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
				const started = performance.now();
				let waiting = 0;
				const result = await executor.execute(call, { app, task, signal, permissions, readFiles, readDelivery, cwd,
					approve: approve && (async (approval) => {
						const requested = performance.now();
						try {
							return await approve(approval);
						} finally {
							waiting += performance.now() - requested;
						}
					}),
				});
				yield { call, result: { ...result, durationMs: Math.max(0, performance.now() - started - waiting) } };
			}
		},
	};
}
