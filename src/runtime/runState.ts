import type { RunContext, RunState } from '../types';

export function assistantMessageId({ taskId, turn }: RunState, retry = 0): string {
	return `assistant:${taskId}:${turn}${retry ? `:retry:${retry}` : ''}`;
}

/** 单次任务内部的循环状态，任务之间的隔离由编排层保证 */
export function createRunState(ctx: RunContext): RunState {
	return {
		taskId: ctx.task.id,
		createdAt: ctx.task.createdAt,
		turn: 0,
		messages: [],
		pendingCalls: [],
		status: 'idle',
	};
}
