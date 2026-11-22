import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_NOT_APPROVED } from '../../types';
import type { RunState } from '../../types';
import { buildSystemPrompt } from '../../orchestration/context/systemPrompt';
import { DEFAULT_GOAL_ROUNDS, finishGoalRound, restoreChatGoal, validGoalRounds } from '../chatGoal';
import type { ChatGoal } from '../chatGoal';

const started: ChatGoal = { objective: '检查复习计划', status: 'active', maxRounds: DEFAULT_GOAL_ROUNDS, usedRounds: 1, totalRounds: 2 };

void test('an interrupted goal restores paused with its objective, limit and progress', () => {
	assert.deepEqual(restoreChatGoal(started), { ...started, status: 'paused', reason: 'closed' });
	assert.equal(restoreChatGoal({ ...started, maxRounds: 0 }), undefined);
	assert.equal(validGoalRounds(1.5), false);
});

void test('goal continuation stops on the selected cap, interruption or failure', () => {
	const run: RunState = { taskId: 'a', turn: 1, messages: [{ role: 'assistant', content: '已经检查了一份笔记。' }],
		pendingCalls: [], status: 'done' };
	assert.deepEqual(finishGoalRound(started, run), started);
	const lastRound = { ...started, usedRounds: started.maxRounds };
	assert.deepEqual(finishGoalRound(lastRound, run), { ...lastRound, status: 'paused', reason: 'limit' });
	assert.equal(finishGoalRound(started, { ...run, status: 'cancelled' }).reason, 'manual');
	assert.equal(finishGoalRound(started, undefined).reason, 'failed');
});

void test('completion requires evidence in the last line of a successful final answer', () => {
	const completion = '<!-- scribe-goal-complete: [[复习计划.md]] 的三段日期均已核对 -->';
	const run: RunState = { taskId: 'a', turn: 1, messages: [{ role: 'assistant', content: `已核对。\n\n${completion}` }],
		pendingCalls: [], status: 'done' };
	assert.deepEqual(finishGoalRound(started, run), { ...started, status: 'complete', evidence: '[[复习计划.md]] 的三段日期均已核对' });
	assert.equal(finishGoalRound(started, { ...run, status: 'failed' }).status, 'paused');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'tool', content: completion }] }).status, 'active');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'assistant', content: `\`\`\`\n${completion}\n\`\`\`` }] }).status, 'active');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'tool', content: TOOL_NOT_APPROVED }, ...run.messages] }).reason, 'blocked');
	assert.equal(finishGoalRound(started, { ...run, messages: [{ role: 'assistant', content: '请先选择笔记。\n<!-- scribe-goal-blocked -->' }] }).reason, 'blocked');
	const closed = { ...started, status: 'paused', reason: 'closed' } as const;
	assert.equal(finishGoalRound(closed, run), closed);
});

void test('goal instructions are sent only for an automatic goal round', () => {
	assert.match(buildSystemPrompt(false, 'ask', undefined, undefined, true), /scribe-goal-complete/u);
	assert.doesNotMatch(buildSystemPrompt(false, 'ask'), /scribe-goal-complete/u);
	assert.doesNotMatch(buildSystemPrompt(true, 'ask', undefined, undefined, true), /scribe-goal-complete/u);
	assert.doesNotMatch(buildSystemPrompt(false, 'ask', undefined, 'plan', true), /scribe-goal-complete/u);
});
