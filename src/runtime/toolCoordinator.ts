import type { App } from 'obsidian';
import { ToolReviewDeniedError } from '../types';
import type { ToolContext, ToolCoordinator, ToolExecutor, ToolReviewStatus } from '../types';

export function createToolCoordinator(app: App, executor: ToolExecutor): ToolCoordinator {
	return {
		async *runCalls(state, ctx, approve, skip) {
			const { task, signal, permissions, readFiles, readDelivery, cwd, observer } = ctx;
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
				let approvalReview: ToolReviewStatus | undefined;
				let denied: ToolContext['retryApproval'];
				const result = await executor.execute(call, { app, task, signal, permissions, readFiles, readDelivery, cwd,
					skillRun: ctx.skillRun, subagents: ctx.subagents, subagentId: ctx.subagentId,
					onShellOutput: observer.onEvent && ((output) => {
						if (!signal.aborted) observer.onEvent?.({ type: 'tool-output', callId: call.id, output });
					}),
					approve: approve && (async (approval, identity) => {
						const requested = performance.now();
						const trackReview = approval.kind === 'shell' && permissions.executionMode === 'auto-review';
						try {
							const allowed = await approve(approval);
							if (trackReview) approvalReview = allowed ? 'approved' : 'incomplete';
							return allowed;
						} catch (error) {
							if (trackReview) approvalReview = error instanceof ToolReviewDeniedError ? 'denied' : 'incomplete';
							if (approvalReview === 'denied' && identity) denied = { approval: { ...approval }, identity };
							throw error;
						} finally {
							waiting += performance.now() - requested;
						}
					}),
				});
				if (denied && observer.onAutoReviewDenied && !ctx.subagentId && !signal.aborted) {
					const retryApproval = denied;
					const retryCall = structuredClone(call);
					let spent = false;
					observer.onAutoReviewDenied({
						id: `${task.id}/${call.id}`,
						approval: { ...retryApproval.approval },
						async retry(retrySignal) {
							if (spent) throw new Error('此操作已经尝试过。');
							retrySignal.throwIfAborted();
							spent = true;
							ctx.checkModel?.();
							return executor.execute(retryCall, { app, task, signal: retrySignal, cwd, permissions, retryApproval,
								readFiles: new Map(), readDelivery, approve: async () => true });
						},
					});
				}
				yield { call, result: {
					...result, ...(approvalReview && { approvalReview }),
					durationMs: Math.max(0, performance.now() - started - waiting),
				} };
			}
		},
	};
}
