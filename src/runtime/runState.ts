import type { RunContext, RunState } from '../types';

/** 单次任务内部的循环状态，任务之间的隔离由编排层保证 */
export function createRunState(ctx: RunContext): RunState {
	return {
		taskId: ctx.task.id,
		turn: 0,
		messages: [],
		pendingCalls: [],
		status: 'idle',
	};
}
