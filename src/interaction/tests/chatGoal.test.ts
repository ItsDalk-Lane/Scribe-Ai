import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_NOT_APPROVED } from '../../types';
import type { Message, RunState } from '../../types';
import { activeMode, chatSystemPrompt } from '../../orchestration/context/systemPrompt';
import { finishGoalRound, goalCompletionEvidence, goalRoundInstruction, parseChatGoal, reportGoalToolName, restoreChatGoal, setGoalWorkClock, stripGoalReport } from '../chatGoal';
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
	const oldCap = { ...started, maxRounds: 5, usedRounds: 51, totalRounds: 51, criteria: [started.objective], refs: [{ path: '复习计划.md' }] };
	const progress = '<!-- scribe-goal-report: {"checks":[],"remaining":["复查日期"]} -->';
	const working = { ...run, messages: [readNote('复习计划.md', ['五月考试']), { role: 'assistant' as const, content: progress }] };
	const next = finishGoalRound(oldCap, working);
	assert.equal(next.status, 'active');
	assert.equal(finishGoalRound(next, working).reason, 'stalled');
	assert.equal(finishGoalRound(started, run).reason, 'stalled');
	assert.equal(finishGoalRound(started, { ...run, status: 'cancelled' }).reason, 'manual');
	assert.equal(finishGoalRound(started, undefined).reason, 'failed');
});

void test('a reopened legacy goal applies current evidence checks to a new completion claim', () => {
	const completion = '<!-- scribe-goal-complete: [[复习计划.md]] 的三段日期均已核对 -->';
	const run: RunState = { taskId: 'a', turn: 1, messages: [{ role: 'assistant', content: `已核对。\n\n${completion}` }],
		pendingCalls: [], status: 'done' };
	assert.equal(finishGoalRound(started, run).status, 'paused');
	const observed = { ...run, messages: [readNote('复习计划.md', ['复习日：周一、周二和周三。']), ...run.messages] };
	assert.equal(finishGoalRound(started, observed).reason, 'verification');
	assert.equal(finishGoalRound(started, observed, 'passed').status, 'complete');
	const saved = { ...started, status: 'complete', evidence: '[[复习计划.md]] 的三段日期均已核对' };
	assert.deepEqual(restoreChatGoal(saved), saved);
	assert.equal(finishGoalRound(started, { ...run, status: 'failed' }).status, 'paused');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'tool', content: completion }] }).status, 'paused');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'assistant', content: `\`\`\`\n${completion}\n\`\`\`` }] }).status, 'paused');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'tool', content: TOOL_NOT_APPROVED }, ...run.messages] }).reason, 'blocked');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'assistant', content: '请先选择笔记。\n<!-- scribe-goal-blocked -->' }] }).reason, 'blocked');
	const closed = { ...started, status: 'paused', reason: 'closed' } as const;
	assert.equal(finishGoalRound(closed, run), closed);
});

void test('structured goal guidance belongs to static XML while the active round is marked by a runtime reminder', () => {
	assert.match(chatSystemPrompt, /^<system-prompt>[\s\S]*自动目标/u);
	assert.match(activeMode(undefined, 'ask', false, true), /聊天目标的自动执行轮次[\s\S]*ReportGoal/u);
	assert.match(activeMode(undefined, 'ask', false, true, { plan: false, goalReport: false }), /文本回执/u);
	assert.doesNotMatch(activeMode(undefined, 'ask'), /聊天目标的自动执行轮次/u);
	assert.doesNotMatch(activeMode(undefined, 'ask', true, true), /聊天目标的自动执行轮次/u);
	assert.doesNotMatch(activeMode('plan', 'ask', false, true), /聊天目标的自动执行轮次/u);
});

void test('goal checks require real note receipts and carry each verified criterion into the next round', () => {
	const [dates, index] = ['核对 [[会议/纪要.md]] 的日期', '生成索引'];
	const goal = { ...started, criteria: [dates, index], plan: '先检查纪要，再生成索引',
		refs: [{ path: '会议', kind: 'folder' as const }], chatQuotes: ['会议资料在此文件夹'] };
	const first = '<!-- scribe-goal-report: {"checks":[{"criterion":1,"evidence":"第 2 行写明日期"}],"remaining":["生成索引"]} -->';
	const round: RunState = { taskId: 'round-one', turn: 1, status: 'done', pendingCalls: [],
		messages: [
			{ role: 'tool', toolName: 'Read', toolCallId: 'read-one', isError: false, content: '会议/纪要.md（第 1–2 行）\n1\t# 纪要\n2\t日期：2026-11-23' },
			{ role: 'assistant', content: `已核对日期。\n${first}` },
		] };
	const pending = finishGoalRound(goal, { ...round, messages: round.messages.slice(1) });
	assert.deepEqual(pending.progress, { checks: [], remaining: goal.criteria });
	const verified = finishGoalRound(goal, round);
	assert.deepEqual({ checks: verified.progress?.checks, remaining: verified.progress?.remaining }, { checks: [{ criterion: dates, evidence: '第 2 行写明日期',
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
	assert.equal(finishGoalRound(verified, nextRound).reason, 'verification');
	const done = finishGoalRound(verified, nextRound, 'passed');
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

function readNote(path: string, lines: string[], start = 1): Message {
	return { role: 'tool', toolName: 'Read', toolCallId: 'r', isError: false,
		content: [`${path}（第 ${start}–${start + lines.length - 1} 行）`, ...lines.map((line, i) => `${start + i}\t${line}`)].join('\n') };
}

void test('structured goal completion needs a paired receipt after the latest user message', () => {
	const goal = { ...started, criteria: ['[[索引.md]] 的一级标题为「本周」'] };
	const call = { name: reportGoalToolName, id: 'report', input: { checks: [{ criterion: 1, evidence: '索引标题已核对' }], remaining: [] } };
	const request: Message = { role: 'assistant', content: '', toolCalls: [call] };
	const receipt: Message = { role: 'tool', toolName: reportGoalToolName, toolCallId: call.id, isError: false, content: '已登记。' };
	const answer: Message = { role: 'assistant', content: '标题已核对。' };
	const complete = (...messages: Message[]) => finishGoalRound(goal, { taskId: 'goal', turn: 3, status: 'done',
		pendingCalls: [], messages: [readNote('索引.md', ['# 本周']), ...messages, answer] }).status;
	assert.equal(complete(request, receipt), 'complete');
	assert.notEqual(complete(request), 'complete');
	assert.notEqual(complete(receipt), 'complete');
	assert.notEqual(complete(request, receipt, { role: 'user', content: '稍等，先继续复查。' }), 'complete');
});

function reportedRound(messages: Message[], checks: { criterion: number; evidence: string; notePaths?: string[] }[], remaining: string[] = []): RunState {
	return { taskId: 'goal', turn: 1, status: 'done', pendingCalls: [], messages: [...messages,
		{ role: 'assistant', content: `<!-- scribe-goal-report: ${JSON.stringify({ checks, remaining })} -->` }] };
}

void test('local title and links require visible Markdown evidence from the target note, even when a model approves', () => {
	const goal = { ...started, criteria: ['[[索引.md]] 的一级标题为「本周」', '在 [[索引.md]] 添加 [[A.md]]、[[B]] 两条链接'] };
	const checks = goal.criteria.map((_, i) => ({ criterion: i + 1, evidence: '均已核实', notePaths: ['索引.md'] }));
	const matching = ['---', 'title: 其他', '---', '# 本周', '[[A|项目 A]] 与 [[B.md]]'];
	const correct = readNote('索引.md', matching);
	const success = reportedRound([correct], checks);
	assert.equal(finishGoalRound(goal, success).status, 'complete');
	assert.deepEqual(goalCompletionEvidence(goal, success)?.checks, []);
	const edit = (after: string): Message => ({ role: 'tool', toolName: 'Edit', isError: false,
		noteChange: { path: '索引.md', before: '# 先前', after }, content: '已修改。' });
	assert.equal(finishGoalRound(goal, reportedRound([edit(matching.join('\n'))], checks)).status, 'complete');
	for (const messages of [
		[readNote('索引.md', ['# 空索引'])],
		[readNote('不是索引.md', matching)],
		[correct, readNote('索引.md', ['# 本周', '[[A]]'])],
		[correct, edit('# 本周\n[[A]]')],
		[correct, { ...edit(''), noteChange: { path: '索引.md', omitted: true as const } }],
		[readNote('索引.md', matching, 10)],
		[readNote('索引.md', ['# 本周', '```', '[[A]] [[B]]', '```'])],
		[readNote('索引.md', ['# 本周', '<!-- [[A]] -->', '`[[B]]`'])],
		[readNote('索引.md', ['# 本周', '<pre>[[A]]</pre>', '$$[[B]]$$'])],
		[readNote('索引.md', ['# 本周', '![[A]] \\[[B]]'])],
		[{ ...correct, isError: true }], [{ ...correct, skipped: true }],
		[{ ...correct, content: correct.content + '\n第 1 行过长，内容已截断。' }],
	]) {
		const run = reportedRound(messages, checks);
		assert.notEqual(finishGoalRound(goal, run, 'passed').status, 'complete');
		assert.equal(goalCompletionEvidence(goal, run), undefined);
	}
});

void test('semantic checks need an independent verdict and mixed conditions preserve the semantic requirement', () => {
	const goal = { ...started, criteria: ['[[索引.md]] 的标题为“本周”', '[[索引.md]] 包含 [[A]] 并解释为何推荐'] };
	const run = reportedRound([readNote('索引.md', ['# 本周', '[[A]] 因为它记录了当周原始数据。']), readNote('A.md', ['# A'])],
		goal.criteria.map((_, i) => ({ criterion: i + 1, evidence: '核对成功', notePaths: ['索引.md'] })));
	assert.deepEqual(goalCompletionEvidence(goal, run)?.checks.map((check) => check.criterion), [goal.criteria[1]]);
	const pending = finishGoalRound(goal, run, 'needs-evidence');
	assert.equal(pending.reason, 'verification');
	assert.deepEqual(pending.progress?.remaining, goal.criteria);
	assert.equal(finishGoalRound(goal, run, 'passed').status, 'complete');
	assert.deepEqual(parseChatGoal(pending), pending);
});

void test('fresh observations in the current scope advance a goal once across restarts; wording changes, unrelated notes and retries do not', () => {
	const goal = { ...started, criteria: ['汇总本周资料'], refs: [{ path: '本周', kind: 'folder' as const }] };
	const read = readNote('本周/一.md', ['# 一', '会议拟于周三召开']);
	assert.equal(finishGoalRound(goal, reportedRound([], [], ['改日整理'])).reason, 'stalled');
	assert.equal(finishGoalRound(goal, reportedRound([readNote('其他/二.md', ['无关'])], [], ['改日整理'])).reason, 'stalled');
	const next = finishGoalRound(goal, reportedRound([read], [], ['复核日期']));
	assert.equal(next.status, 'active');
	const restored = { ...restoreChatGoal(next)!, status: 'active' as const };
	assert.equal(finishGoalRound(restored, reportedRound([read], [], ['再查一次日期'])).reason, 'stalled');
	assert.equal(finishGoalRound(restored, reportedRound([readNote('本周/一.md', ['定于周四'])], [], ['复核日期'])).status, 'active');
});

void test('an explicit filename, English title and standard Markdown links use the final local evidence', () => {
	const path = '工作/Index.md';
	const criteria = ['The title of 工作/Index.md must be "Week 1".',
		'工作/Index.md must contain links to [纪要](纪要.md) and [官网](https://example.org/docs).'];
	const goal = { ...started, criteria };
	const checks = criteria.map((_, i) => ({ criterion: i + 1, evidence: '已核实' }));
	const body = ['# Week 1', '[纪要](%E7%BA%AA%E8%A6%81.md) · [官网](https://example.org/docs)'];
	const run = reportedRound([readNote(path, body)], checks);
	assert.equal(finishGoalRound(goal, run).status, 'complete');
	assert.deepEqual(goalCompletionEvidence(goal, run)?.checks, []);
	assert.deepEqual(goalCompletionEvidence(goal, run)?.local, [{ path, start: 1, body: body.join('\n') }]);
	assert.equal(finishGoalRound(goal, run, 'needs-evidence').reason, 'verification');
	for (const line of ['[纪要](其他.md) · [官网](https://example.org/docs)', '[纪要](纪要.md) · https://example.org/docs',
		'[伪造](纪要.md) · [官网](https://example.org/docs)', '`[纪要](纪要.md)` · [官网](https://example.org/docs)']) {
		const partial = reportedRound([readNote(path, [body[0]!, line])], checks);
		assert.notEqual(finishGoalRound(goal, partial, 'passed').status, 'complete');
	}
});

void test('ambiguous and negative criteria need independent review, even when the note contains matching words', () => {
	const scope = ['索引.md', '来源.md'];
	for (const criterion of ['索引.md 的标题为总览并补齐来源', '索引.md 不包含 A、B 两条链接',
		'索引.md 包含 [[A]]，并为 [[来源.md]] 写一段分析', '索引.md 包含 [[A]] 两条链接']) {
		const goal = { ...started, criteria: [criterion] };
		const run = reportedRound(scope.map((path) => readNote(path, ['# 总览并补齐来源', '[[A]] [[B]]'])),
			[{ criterion: 1, evidence: '已核实', notePaths: scope }]);
		assert.equal(finishGoalRound(goal, run).reason, 'verification');
		assert.equal(goalCompletionEvidence(goal, run)?.checks[0]?.criterion, criterion);
	}
});

void test('a general research goal can advance on a newly read source identified in the account', () => {
	const goal = { ...started, criteria: ['找出几位作者的论据并比较'] };
	const read = readNote('资料/论文.md', ['研究采用匿名问卷。']);
	const run = reportedRound([read], [], ['对照 资料/论文.md 的问卷设计与第二种方法']);
	const next = finishGoalRound(goal, run);
	assert.equal(next.status, 'active');
	assert.equal(finishGoalRound(next, reportedRound([read], [], ['重新比较 资料/论文.md'])).reason, 'stalled');
});
