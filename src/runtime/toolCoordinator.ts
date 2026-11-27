import type { App } from 'obsidian';
import { subagentOperation } from '../tools/subagentTools';
import { isDirectMcpToolName } from '../tools/support/toolInput';
import { normalizeModelIntent } from './responseIntent';
import { ToolReviewDeniedError } from '../types';
import type { ToolContext, ToolCoordinator, ToolExecutor, ToolCall, ToolResult, ToolReviewStatus } from '../types';

const MAX_PARALLEL_READS = 3;

export function createToolCoordinator(app: App, executor: ToolExecutor): ToolCoordinator {
	return {
		async *runCalls(state, ctx, approve, skip) {
			const { task, signal, permissions, readFiles, readDelivery, cwd, observer } = ctx;
			const toolContext = { app, task, signal, permissions, readFiles, readDelivery, cwd,
				memory: ctx.memory, skillRun: ctx.skillRun, mcpRun: ctx.mcpRun, subagents: ctx.subagents, subagentId: ctx.subagentId, chatTasks: ctx.chatTasks };
			const busy = () => ctx.collaboration?.pending().blocking;
			let reads: Array<() => Promise<ToolResult>> | undefined;
			if (executor.prepareParallelReads && state.pendingCalls.length > 1 && state.pendingCalls.every((call) => call.name === 'Read')
				&& !state.resumed && !ctx.resumeReview && !busy()) {
				observer.onWork?.(task.id, true);
				try {
					let allowed = true;
					for (const call of state.pendingCalls) {
						if (await skip?.(call)) { allowed = false; break; }
					}
					if (allowed) reads = await executor.prepareParallelReads(state.pendingCalls, toolContext);
				}
				finally { observer.onWork?.(task.id, false); }
			}
			let next = 0;
			while (reads && next < reads.length) {
				const end = Math.min(next + MAX_PARALLEL_READS, reads.length);
				const started: Promise<{ call: ToolCall; result: ToolResult }>[] = [];
				let active = 0;
				try {
					while (next < end) {
						const call = state.pendingCalls[next]!;
						signal.throwIfAborted();
						if (await skip?.(call) || busy()) break;
						signal.throwIfAborted();
						// 模型请求已入盘，纯读取只在结果按序交付时推进恢复点。
						observer.onEvent?.({ type: 'tool-start', call });
						if (++active === 1) observer.onWork?.(task.id, true);
						const start = performance.now();
						const read = reads[next++]!;
						started.push(read().then((result) => ({
							call, result: { ...result, durationMs: performance.now() - start },
						})).finally(() => {
							if (--active === 0) observer.onWork?.(task.id, false);
						}));
					}
					for (const reading of started) {
						const entry = await reading;
						signal.throwIfAborted();
						yield entry;
					}
				} finally {
					await Promise.allSettled(started);
				}
				if (next < end) break;
			}
			for (const call of state.pendingCalls.slice(next)) {
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
				const operation = subagentOperation(call);
				const work = operation === 'wait_agent' || operation === 'ask_parent' ? undefined : observer.onWork;
				work?.(task.id, true);
				const result = await executor.execute(call, { app, task, signal, permissions, readFiles, readDelivery, cwd,
					memory: ctx.memory, skillRun: ctx.skillRun, mcpRun: ctx.mcpRun, subagents: ctx.subagents, subagentId: ctx.subagentId,
					chatTasks: ctx.chatTasks, plan: ctx.plan, goalReport: ctx.goalReport,
					onShellOutput: observer.onEvent && ((output) => {
						if (!signal.aborted) observer.onEvent?.({ type: 'tool-output', callId: call.id, output });
					}),
					approve: approve && (async (approval, identity) => {
						const requested = performance.now();
						const trackReview = permissions.executionMode === 'auto-review' && !approval.humanRequired;
						const intent = !trackReview && !isDirectMcpToolName(call.name)
							? normalizeModelIntent((call.input as { intent?: unknown } | null)?.intent) : undefined;
						try {
							const allowed = await approve(intent ? { ...approval, intent } : approval);
							if (trackReview) approvalReview = allowed ? 'approved' : 'incomplete';
							return allowed;
						} catch (error) {
							if (trackReview) approvalReview = error instanceof ToolReviewDeniedError ? 'denied' : 'incomplete';
							if (approval.kind === 'shell' && approvalReview === 'denied' && identity) denied = { approval: { ...approval }, identity };
							throw error;
						} finally {
							waiting += performance.now() - requested;
						}
					}),
				}).finally(() => work?.(task.id, false));
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
