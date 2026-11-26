import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_NOT_APPROVED } from '../../types';
import type { RunState } from '../../types';
import { buildSystemPrompt } from '../../orchestration/context/systemPrompt';
import { finishGoalRound, goalRoundInstruction, parseChatGoal, restoreChatGoal, setGoalWorkClock, stripGoalReport } from '../chatGoal';
import type { ChatGoal } from '../chatGoal';

const started: ChatGoal = { objective: '检查复习计划', status: 'active', usedRounds: 1, totalRounds: 2 };

void test('an interrupted goal restores paused with its objective and progress', () => {
	assert.deepEqual(restoreChatGoal(started), { ...started, status: 'paused', reason: 'closed' });
	assert.deepEqual(restoreChatGoal({ ...started, maxRounds: 5, usedRounds: 99 }),
		{ ...started, usedRounds: 99, status: 'paused', reason: 'closed' });
});

void test('goal work time accrues only while active and survives a pause and reopening', () => {
	const first = setGoalWorkClock({ workedMs: 250 }, true, 100);
	assert.equal(setGoalWorkClock(first, true, 150), first);
	const waiting = setGoalWorkClock(first, false, 1_100);
	assert.deepEqual(waiting, { workedMs: 1_250 });
	assert.equal(setGoalWorkClock(waiting, false, 40_000), waiting);
	const resumed = setGoalWorkClock(waiting, true, 50_000);
	const saved = { ...started, ...setGoalWorkClock(resumed, false, 50_800), status: 'paused', reason: 'plan' } as const;
	assert.deepEqual(restoreChatGoal(saved), { ...saved, workedMs: 2_050 });
	assert.deepEqual(restoreChatGoal({ ...saved, status: 'active' }), { ...saved, workedMs: 2_050, reason: 'closed' });
	assert.equal(parseChatGoal({ ...saved, workedMs: -1 }), undefined);
});

void test('a goal restores the selected skill source only when it matches its objective', () => {
	const selected = { id: '/vault/skills/review/SKILL.md', name: 'review', start: 0, end: 7 };
	const goal = { ...started, objective: '$review 检查纪要', skillMentions: [selected], skillScope: ['会议/2026'],
		skillNotePaths: ['会议/2026/周会.md', '会议/资料/'] };
	assert.deepEqual(parseChatGoal(goal), goal);
	assert.equal(parseChatGoal({ ...goal, objective: '$other 检查纪要' }), undefined);
	assert.equal(parseChatGoal({ ...goal, skillMentions: [selected, { ...selected, id: '/other/SKILL.md' }] }), undefined);
	assert.equal(parseChatGoal({ ...goal, skillScope: ['../'] }), undefined);
	assert.equal(parseChatGoal({ ...goal, skillNotePaths: ['../其他位置.md'] }), undefined);
});

void test('goal continuation follows progress beyond the old cap and pauses when progress stops', () => {
	const run: RunState = { taskId: 'a', turn: 1, messages: [{ role: 'assistant', content: '已经检查了一份笔记。' }],
		pendingCalls: [], status: 'done' };
	const oldCap = { ...started, maxRounds: 5, usedRounds: 51, totalRounds: 51, criteria: [started.objective] };
	const progress = '<!-- scribe-goal-report: {"checks":[],"remaining":["复查日期"]} -->';
	const working = { ...run, messages: [{ role: 'assistant' as const, content: progress }] };
	const next = finishGoalRound(oldCap, working);
	assert.equal(next.status, 'active');
	assert.equal(finishGoalRound(next, working).reason, 'stalled');
	assert.equal(finishGoalRound(started, run).reason, 'stalled');
	assert.equal(finishGoalRound(started, { ...run, status: 'cancelled' }).reason, 'manual');
	assert.equal(finishGoalRound(started, undefined).reason, 'failed');
});

void test('completion requires evidence in the last line of a successful final answer', () => {
	const completion = '<!-- scribe-goal-complete: [[复习计划.md]] 的三段日期均已核对 -->';
	const run: RunState = { taskId: 'a', turn: 1, messages: [{ role: 'assistant', content: `已核对。\n\n${completion}` }],
		pendingCalls: [], status: 'done' };
	assert.deepEqual(finishGoalRound(started, run), { ...started, status: 'complete', evidence: '[[复习计划.md]] 的三段日期均已核对' });
	assert.equal(finishGoalRound(started, { ...run, status: 'failed' }).status, 'paused');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'tool', content: completion }] }).status, 'paused');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'assistant', content: `\`\`\`\n${completion}\n\`\`\`` }] }).status, 'paused');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'tool', content: TOOL_NOT_APPROVED }, ...run.messages] }).reason, 'blocked');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'assistant', content: '请先选择笔记。\n<!-- scribe-goal-blocked -->' }] }).reason, 'blocked');
	const closed = { ...started, status: 'paused', reason: 'closed' } as const;
	assert.equal(finishGoalRound(closed, run), closed);
});

void test('goal instructions are sent only for an automatic goal round', () => {
	assert.match(buildSystemPrompt(false, 'ask', undefined, undefined, true), /scribe-goal-report/u);
	assert.doesNotMatch(buildSystemPrompt(false, 'ask'), /scribe-goal-report/u);
	assert.doesNotMatch(buildSystemPrompt(true, 'ask', undefined, undefined, true), /scribe-goal-report/u);
	assert.doesNotMatch(buildSystemPrompt(false, 'ask', undefined, 'plan', true), /scribe-goal-report/u);
});

void test('goal checks require real note receipts and carry each verified criterion into the next round', () => {
	const [dates, index] = ['核对 [[会议/纪要.md]] 的日期', '生成索引'];
	const goal = { ...started, criteria: [dates, index], plan: '先检查纪要，再生成索引',
		refs: [{ path: '会议', kind: 'folder' as const }], chatQuotes: ['会议资料在此文件夹'] };
	const first = '<!-- scribe-goal-report: {"checks":[{"criterion":1,"evidence":"第 2 行写明日期"}],"remaining":["生成索引"]} -->';
	const round: RunState = { taskId: 'round-one', turn: 1, status: 'done', pendingCalls: [],
		messages: [
			{ role: 'tool', toolName: 'Read', toolCallId: 'read-one', isError: false, content: '会议/纪要.md（第 1–3 行）\n1\t# 纪要\n2\t日期：2026-11-23' },
			{ role: 'assistant', content: `已核对日期。\n${first}` },
		] };
	const pending = finishGoalRound(goal, { ...round, messages: round.messages.slice(1) });
	assert.deepEqual(pending.progress, { checks: [], remaining: goal.criteria });
	const verified = finishGoalRound(goal, round);
	assert.deepEqual(verified.progress, { checks: [{ criterion: dates, evidence: '第 2 行写明日期',
		notePaths: ['会议/纪要.md'] }], remaining: [index] });
	assert.match(goalRoundInstruction(verified), /已确认的计划[\s\S]*先检查纪要[\s\S]*上轮已核对[\s\S]*上轮未完成/u);
	assert.deepEqual(parseChatGoal(verified), verified);
	assert.deepEqual(restoreChatGoal(verified), { ...verified, status: 'paused', reason: 'closed' });

	const second = '<!-- scribe-goal-report: {"checks":[{"criterion":2,"evidence":"已创建会议纪要索引","notePaths":["会议/索引.md"]}],"remaining":[]} -->';
	const nextRound: RunState = { ...round, taskId: 'round-two', messages: [
		{ role: 'tool', toolName: 'Write', toolCallId: 'write-two', isError: false, content: '已创建 会议/索引.md。',
			noteChange: { path: '会议/索引.md', after: '# 会议索引\n[[会议/纪要.md]]' } },
		{ role: 'assistant', content: `已完成。\n${second}` },
	] };
	const done = finishGoalRound(verified, nextRound);
	assert.equal(done.status, 'complete');
	assert.deepEqual(done.progress?.checks.map(({ criterion }) => criterion), [dates, index]);
	assert.equal(stripGoalReport(nextRound.messages[1]!.content), '已完成。');

	const changed = { ...nextRound, messages: [
		nextRound.messages[0]!,
		{ role: 'tool' as const, toolName: 'Edit', toolCallId: 'edit-two', isError: false, content: '已更新 会议/纪要.md。',
			noteChange: { path: '会议/纪要.md', before: '日期：2026-11-23', after: '日期：待确认' } },
		nextRound.messages[1]!,
	] };
	assert.deepEqual(finishGoalRound(verified, changed).progress?.remaining, [dates]);
	assert.equal(finishGoalRound(verified, changed).status, 'active');
});

void test('a structured goal saves the blocker and does not accept an old or incomplete completion report', () => {
	const goal = { ...started, criteria: ['补全日期'] };
	const run: RunState = { taskId: 'a', turn: 1, status: 'done', pendingCalls: [], messages: [
		{ role: 'assistant', content: '旧格式\n<!-- scribe-goal-complete: 日期完整 -->' },
	] };
	assert.equal(finishGoalRound(goal, run).status, 'paused');
	const blocked = '<!-- scribe-goal-report: {"checks":[],"remaining":["补全日期"],"blocked":"缺少原始会议记录"} -->';
	const paused = finishGoalRound(goal, { ...run, messages: [{ role: 'assistant', content: blocked }] });
	assert.equal(paused.status, 'paused');
	assert.equal(paused.reason, 'blocked');
	assert.equal(paused.progress?.blocked, '缺少原始会议记录');
	const result = finishGoalRound(goal, { ...run, messages: [
		{ role: 'assistant', content: '<!-- scribe-goal-report: {"checks":[{"criterion":1,"evidence":"找到原始记录"}],"remaining":[]} -->' },
		{ role: 'assistant', content: '等等，日期需要进一步确认', truncated: true },
	] });
	assert.equal(result.status, 'paused');
	assert.deepEqual(result.progress?.remaining, ['补全日期']);
	assert.equal(parseChatGoal({ ...goal, refs: [{ path: '../外部.md' }] }), undefined);
});
