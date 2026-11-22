import { TOOL_NOT_APPROVED } from '../types';
import type { RunState } from '../types';

export const DEFAULT_GOAL_ROUNDS = 5;
export const MAX_GOAL_ROUNDS = 50;
export const MAX_GOAL_LENGTH = 8_000;

export type GoalPause = 'manual' | 'closed' | 'limit' | 'failed' | 'blocked';

export interface ChatGoal {
	objective: string;
	status: 'active' | 'paused' | 'complete';
	maxRounds: number;
	usedRounds: number;
	totalRounds: number;
	reason?: GoalPause;
	evidence?: string;
}

export function validGoalRounds(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_GOAL_ROUNDS;
}

export function restoreChatGoal(value: unknown): ChatGoal | undefined {
	if (!value || typeof value !== 'object') return;
	const saved = value as Partial<ChatGoal>;
	if (typeof saved.objective !== 'string' || !saved.objective.trim() || saved.objective.length > MAX_GOAL_LENGTH
		|| !validGoalRounds(saved.maxRounds) || !Number.isSafeInteger(saved.totalRounds) || saved.totalRounds! < 0
		|| !Number.isSafeInteger(saved.usedRounds) || saved.usedRounds! < 0
		|| (saved.status !== 'active' && saved.status !== 'paused' && saved.status !== 'complete')) return;
	const { objective, maxRounds, usedRounds, totalRounds, status, reason, evidence } = saved as ChatGoal;
	if (status === 'active') return { objective, maxRounds, usedRounds, totalRounds, status: 'paused', reason: 'closed' };
	return {
		objective, maxRounds, usedRounds, totalRounds, status,
		reason: reason && ['manual', 'closed', 'limit', 'failed', 'blocked'].includes(reason) ? reason : undefined,
		evidence: typeof evidence === 'string' ? evidence.slice(0, 600) : undefined,
	};
}

export function finishGoalRound(goal: ChatGoal, result: RunState | undefined): ChatGoal {
	if (goal.status !== 'active') return goal;
	if (result?.status !== 'done' && result?.status !== 'file-changes-done') {
		return { ...goal, status: 'paused', reason: result?.status === 'limit' ? 'limit' : result?.status === 'cancelled' ? 'manual' : 'failed' };
	}
	if (result.messages.some(({ role, content, approvalReview }) => role === 'tool'
		&& (content === TOOL_NOT_APPROVED || approvalReview === 'denied'))) {
		return { ...goal, status: 'paused', reason: 'blocked' };
	}
	const answer = result.messages.filter((message) => message.role === 'assistant' && !message.local
		&& !message.subagentActivity && !message.incomplete && !message.truncated).at(-1);
	if (answer?.toolCalls?.length) return { ...goal, status: 'paused', reason: 'failed' };
	const lastLine = answer?.content.trimEnd().split('\n').at(-1);
	if (lastLine === '<!-- scribe-goal-blocked -->') return { ...goal, status: 'paused', reason: 'blocked' };
	const evidence = lastLine?.match(/^<!-- scribe-goal-complete: ([^<>\r\n]{1,600}) -->$/u)?.[1]?.trim();
	if (evidence && evidence !== '实际的完成依据') return { ...goal, status: 'complete', evidence };
	return goal.usedRounds < goal.maxRounds ? goal : { ...goal, status: 'paused', reason: 'limit' };
}
