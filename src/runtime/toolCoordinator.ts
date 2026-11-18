import type { App } from 'obsidian';
import type { ToolCoordinator, ToolExecutor } from '../types';

export function createToolCoordinator(app: App, executor: ToolExecutor): ToolCoordinator {
	return {
		async *runCalls(state, ctx, approve, skip) {
			const { task, signal, permissions, readFiles, readDelivery, cwd } = ctx;
			for (const call of state.pendingCalls) {
				signal.throwIfAborted();
				const start = { type: 'tool-start' as const, call };
				const reason = skip ? await skip(call) : undefined;
				signal.throwIfAborted();
				if (reason) {
					ctx.observer.onEvent?.(start);
					yield { call, result: { callId: call.id, isError: true, content: reason }, skipped: true };
					continue;
				}
				await ctx.record?.(start);
				signal.throwIfAborted();
				ctx.observer.onEvent?.(start);
				const result = await executor.execute(call, { app, task, signal, permissions, readFiles, readDelivery, cwd, approve });
				yield { call, result };
			}
		},
	};
}
