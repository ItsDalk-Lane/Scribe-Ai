import { realpath } from 'node:fs/promises';
import { obsidianSearchToolName } from '../tools/workspaceTools';
import { relative, resolve } from 'node:path';
import { taskMessage } from '../orchestration/context/contextBuilder';
import { pauseRun } from '../orchestration/runResume';
import { SkillSteeringError } from '../skills/mentions';
import type { McpManager } from '../tools/external/mcp';
import { createMcpRun } from '../tools/external/mcpTools';
import { webSearchToolName } from '../tools/external/webTools';
import { readOnlySkillTools } from '../tools/skillTools';
import { chatTaskToolNames } from '../tools/chatTaskTools';
import { planDraftToolNames } from '../tools/planTools';
import { contactSubagentTool, manageSubagentsTool } from '../tools/subagentTools';
import { isWithinPath, resolveToolPath, toolAbsolutePath } from '../tools/support/pathUtils';
import { toolSignature } from '../tools/support/toolSignature';
import type { AgentLoop, Message, ModelCoordinator, RunEvent, RunState, SubagentNote, ToolApproval, ToolCall, ToolCoordinator, ToolResult } from '../types';
import { batchAdmission, hasNewInboxMessage, readSteering, waitForTurnInput } from './toolAdmission';
import { latestIncompleteReply, mayHaveStoppedEarly, newContinuationText } from './continuationText';
import { InitialContextBudgetError } from './modelCoordinator';
import { explicitNoteTargets } from './noteTargets';
import { assistantMessageId } from './runState';
import { nextTurnAction } from './turnDecision';

const MAX_UNCHANGED_RESULTS = 3;
const fileChangeTools = new Set(['Write', 'Edit', 'NotebookEdit']);
const resumeTools = new Set(['Read', 'Glob', 'Grep', obsidianSearchToolName, webSearchToolName, ...readOnlySkillTools, ...fileChangeTools,
	contactSubagentTool, manageSubagentsTool, 'wait_agent', 'review_subagent_result', 'read_subagent_result', ...chatTaskToolNames, ...planDraftToolNames]);
const repeatedToolsError = '工具多次返回相同结果，已停止重复操作。';
const pendingResume = '退出前未执行。继续任务时请补做此步骤，修改文件仍需重新请求确认。';
const legacyPendingResume = '退出前未执行。继续任务时需要重新请求确认。';
const outputContinuation: Message = {
	role: 'user',
	content: '上一轮回答被截断。请从截断处继续原任务，保留原有格式，避免重复已写的内容或已完成的操作。需要工具时，重新给出完整的请求。',
};
const earlyEndReminder: Message = {
	role: 'user',
	content: '刚才在没有正文和工具调用的情况下结束了。如果上段回复还没写完，请从停下的位置继续。如果还有可以执行的步骤，请按原任务继续。避免重复已经输出的内容和已成功的操作。如果已经说完或需要用户补充，可以直接结束。',
};

function skippedResults(calls: ToolCall[], content: string): Message[] {
	return calls.map((call) => ({ role: 'tool', toolCallId: call.id, toolName: call.name, isError: true, skipped: true, content }));
}

function collaborationMessages(notes: readonly SubagentNote[], existing: readonly Message[], child?: string): Message[] {
	const seen = new Set(existing.flatMap(({ subagentActivity }) => subagentActivity ? [subagentActivity.id] : []));
	return notes.flatMap(({ id, from, agentName, kind, text, review }): Message[] => {
		if (seen.has(id) || (kind === 'result' && review && review.status !== 'pending')) return [];
		const activity = kind === 'result' || kind === 'question' ? kind
			: child && from !== 'user' && (kind === 'answer' || kind === 'message') ? 'instruction' : undefined;
		if (!activity) return [];
		seen.add(id);
		return [{
			id: `subagent:${id}`, role: activity === 'instruction' ? 'user' : 'assistant', content: text, local: true,
			subagentActivity: { id, agentId: from, agentName: agentName ?? (from === 'root' ? '主聊天' : from), kind: activity },
		}];
	});
}

function assistantReply(state: RunState, response: Awaited<ReturnType<ModelCoordinator['nextTurn']>>, content: string, raw: boolean, toolCalls?: ToolCall[]): Message {
	const message: Message = {
		role: 'assistant', id: response.id ?? assistantMessageId(state), content, toolCalls,
		truncated: response.stopReason === 'limit' ? true : undefined,
		metrics: response.metrics,
		reportedUsage: response.reportedUsage,
		...(response.goalReportRequired && { goalReportRequired: true }),
		...(response.estimatedUsage && { estimatedUsage: response.estimatedUsage }),
		...(response.usageStatus === 'provisional' && { usageStatus: response.usageStatus }),
	};
	if (raw) return { ...message, rawAssistant: response.raw };
	message.usage = response.usage ?? response.raw.usage;
	const thinkingBlocks = response.raw.content.flatMap((block, contentIndex) =>
		block.type === 'thinking' && !block.redacted && block.thinking ? [{
			type: block.type, thinking: block.thinking, durationMs: block.durationMs, contentIndex,
		}] : []);
	const textIndex = response.raw.content.findIndex((block) => block.type === 'text');
	return { ...message, thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : undefined, textIndex: textIndex > 0 ? textIndex : undefined };
}

function* savedResults(messages: Message[]) {
	let calls = new Map<string, ToolCall>();
	for (const message of messages) {
		if (message.role === 'user' && message.id?.startsWith('steer:')) yield { steering: true as const };
		if (message.role === 'assistant' && !message.incomplete) calls = new Map(message.toolCalls?.map((call) => [call.id, call]));
		if (message.role !== 'tool' || !message.toolCallId) continue;
		const call = calls.get(message.toolCallId);
		const pending = message.skipped && (message.content === pendingResume || message.content === legacyPendingResume);
		if (call && (!message.skipped || pending)) {
			yield { call, pending, result: { callId: call.id, content: message.content, isError: message.isError ?? false } };
		}
	}
}

function fileChangePathKey(call: ToolCall): string {
	return call.name === 'NotebookEdit' ? 'notebook_path' : 'file_path';
}

function fileChangeSignature(call: ToolCall, path: string): string {
	const input = { ...(call.input as Record<string, unknown>), [fileChangePathKey(call)]: path };
	if (call.name === 'Edit' && input.replace_all === undefined) input.replace_all = false;
	if (call.name === 'NotebookEdit') {
		if (input.edit_mode === undefined) input.edit_mode = 'replace';
		if (input.edit_mode === 'delete' && input.new_source === undefined) input.new_source = '';
	}
	return toolSignature({ ...call, input });
}

export function createAgentLoop(models: ModelCoordinator, tools: ToolCoordinator, mcp?: McpManager): AgentLoop {
	return {
		async run(context, initialState) {
			const { target } = context.task.request;
			const ctx = mcp ? { ...context, mcpRun: createMcpRun(mcp, target?.kind === 'mcp' ? target.id : undefined) } : context;
			let state = initialState;
			const { signal, observer, task, collaboration } = ctx;
			const resuming = initialState.status === 'interrupted';
			let outputSoFar: string | undefined;
			let progressVersion = 0;
			const toolOutcomes = new Map<string, { content: string; isError: boolean; unchanged: number; progressVersion: number }>();
			const priorWrittenPaths = new Set<string>();
			const completedChanges = new Set<string>();
			const pendingOverwrites = new Set<string>();
			let resumePrompt: Message | undefined;
			const update = async (patch: Partial<RunState>) => {
				state = { ...state, ...patch };
				const event = { type: 'state' as const, state };
				try {
					await ctx.record?.(event);
				} finally {
					observer.onEvent?.(event);
				}
			};
			const stopAtLimit = (error: string) => update({
				status: 'limit', error, pendingCalls: [],
				messages: [...state.messages, ...skippedResults(state.pendingCalls, error)],
			});

			const approve = async (approval: ToolApproval): Promise<boolean> => {
				signal.throwIfAborted();
				const decide = ctx.permissions.executionMode === 'auto-review' && !approval.humanRequired ? ctx.reviewTool : observer.approve;
				if (!decide) return false;
				const userDecides = decide === observer.approve;
				if (userDecides) observer.onWork?.(task.id, false);
				await update({ status: 'awaiting-approval' });
				let stop: () => void = () => {};
				const cancelled = new Promise<false>((resolve) => {
					stop = () => resolve(false);
					signal.addEventListener('abort', stop, { once: true });
				});
				try {
					return !signal.aborted && await Promise.race([decide(approval, signal), cancelled]);
				} finally {
					signal.removeEventListener('abort', stop);
					if (!signal.aborted) {
						await update({ status: 'running' });
						if (userDecides) observer.onWork?.(task.id, true);
					}
				}
			};

			try {
				signal.throwIfAborted();
				const explicit = resuming && !ctx.sideChat ? explicitNoteTargets(task.request.instruction, ctx.cwd) : undefined;
				const vaultRoot = resuming ? await realpath(ctx.cwd) : ctx.cwd;
				const notePath = (name: string) => {
					const path = resolve(ctx.cwd, name);
					return isWithinPath(ctx.cwd, path) ? resolve(vaultRoot, relative(ctx.cwd, path)) : path;
				};
				const resumeTargets = new Set(Array.from(explicit?.keys() ?? [], notePath));
				const mayWrite = (path: string) => !resumeTargets.size || resumeTargets.has(notePath(path));
				const fileTarget = (call: ToolCall) => {
					const value = (call.input as Record<string, unknown> | undefined)?.[fileChangePathKey(call)];
					return typeof value === 'string' && value.trim() ? value : undefined;
				};
				const canonicalNote = async (target: string) => {
					let requested: string;
					try {
						requested = toolAbsolutePath(ctx.cwd, target);
					} catch {
						return notePath(target);
					}
					if (!ctx.permissions.canWrite(requested)) return notePath(target);
					const direct = await realpath(requested).catch(() => undefined);
					return direct && ctx.permissions.canWrite(direct) ? direct : notePath(target);
				};
				const { canRequestPath } = ctx.permissions;
				const requestContext = resuming ? {
					...ctx,
					subagents: ctx.subagents && { ...ctx.subagents, resuming: true },
					canDescribeTool: (tool: Parameters<typeof ctx.permissions.canCallTool>[0]) =>
						ctx.permissions.canCallTool(tool) && (resumeTools.has(tool.name) || Boolean(tool.mcp)),
					permissions: {
						...ctx.permissions,
						canWrite: (path: string) => ctx.permissions.canWrite(path) && mayWrite(path),
						canRequestPath: canRequestPath && ((path: string, operation: 'read' | 'write') =>
							(operation === 'read' || mayWrite(path)) && canRequestPath(path, operation)),
						canCallTool: (tool: Parameters<typeof ctx.permissions.canCallTool>[0]) =>
							ctx.permissions.canCallTool(tool) && (resumeTools.has(tool.name) || Boolean(tool.mcp)),
					},
				} : ctx;
				const skipContinuation = async (call: ToolCall) => {
					if (!fileChangeTools.has(call.name)) return;
					const target = fileTarget(call);
					if (!target) return;
					if (!mayWrite(target)) return '此文件不属于本次续做的目标。';
					const path = await canonicalNote(target);
					const key = fileChangeSignature(call, path);
					if (completedChanges.has(key)) return '此项修改已完成，已跳过重复操作。';
					if (call.name === 'Write' && priorWrittenPaths.has(path) && !pendingOverwrites.has(key)) {
						return '此文件已有保存的修改，请用局部编辑继续，以免覆盖先前的工作。';
					}
					return undefined;
				};
				const remember = (call: ToolCall, { content, isError }: ToolResult) => {
					const signature = toolSignature(call);
					const previous = toolOutcomes.get(signature);
					const sameResult = previous?.content === content && previous.isError === isError;
					// 有新结果后重新累计，避免把后续核对当成旧操作的空转。
					if (!sameResult) progressVersion++;
					const unchanged = sameResult && previous.progressVersion === progressVersion ? previous.unchanged + 1 : 1;
					toolOutcomes.set(signature, { content, isError, unchanged, progressVersion });
				};
				const rememberResumeChange = async (call: ToolCall, kind: 'restored' | 'pending' | 'current') => {
					if (!fileChangeTools.has(call.name)) return;
					const target = fileTarget(call);
					if (!target) return;
					const path = await canonicalNote(target);
					const key = fileChangeSignature(call, path);
					if (kind === 'pending') {
						if (call.name === 'Write' && !completedChanges.has(key)) pendingOverwrites.add(key);
						return;
					}
					completedChanges.add(key);
					if (kind === 'restored') priorWrittenPaths.add(path);
				};
				if (resuming) {
					for (const saved of savedResults(state.messages)) {
						if (saved.steering) {
							progressVersion++;
							continue;
						}
						const { call, pending, result } = saved;
						if (pending) await rememberResumeChange(call, 'pending');
						else {
							// 退出后认领会释放，协作者也能变更清单。续做时重新观察当前结果。
							if (!chatTaskToolNames.has(call.name)) remember(call, result);
							if (!result.isError) await rememberResumeChange(call, 'restored');
						}
					}
					for (const call of state.pendingCalls) await rememberResumeChange(call, 'pending');
					resumePrompt = { role: 'user', content: '从重开前保存的进度继续原任务。保留已经成功的修改，不要重复操作。补做之前未执行的读取、搜索和核对。同一篇笔记如有未完成的修改，请重新读取后完成。优先使用局部编辑，已记录的整篇写入才能原样重试，所有改动仍需重新请求确认。' };
					outputSoFar = latestIncompleteReply(state.messages);
					if (outputSoFar) resumePrompt.content += '上一段回复尚未完成，请从已经保存的文字末尾接着写，避免重复。';
				}
				const previous = state.messages.length && resuming ? state.messages : [...state.messages, taskMessage(task.request)];
				await update({ status: 'running', resumed: resuming || undefined, pendingCalls: [], messages: [...previous,
					...skippedResults(state.pendingCalls, pendingResume),
				] });
				let lateSteering: Awaited<ReturnType<typeof readSteering>> | undefined;
				let earlyEndCheck: 'pending' | 'used' | undefined;
				let awaitingCollaboration = false;
				turns: while (true) {
					signal.throwIfAborted();
					await update({ turn: state.turn + 1 });
					const start = { type: 'turn-start' as const, turn: state.turn };
					await ctx.record?.(start);
					observer.onEvent?.(start);
					const nudge = earlyEndCheck === 'pending';
					const finishing = lateSteering !== undefined || nudge;
					const steering = lateSteering ?? await readSteering(ctx);
					lateSteering = undefined;
					if (nudge) earlyEndCheck = 'used';
					const restoring = Boolean(resumePrompt);
					const reminder = resumePrompt ?? (outputSoFar === undefined ? undefined : outputContinuation)
						?? (nudge && !steering.length ? earlyEndReminder : undefined);
					resumePrompt = undefined;
					// 空回复留在聊天记录里，续做请求直接接在上一段正文及配对的工具结果之后。
					const messages = reminder === earlyEndReminder ? state.messages.slice(0, -1) : state.messages;
					const baseRequest = reminder ? { ...state, messages: [...messages, reminder] } : state;
					const inbox = ctx.inbox?.();
					const received = collaborationMessages(inbox ?? [], state.messages, ctx.subagentId);
					if (received.length) await update({ messages: [...state.messages, ...received] });
					const userNotes: Message[] = (inbox ?? []).flatMap((note) => note.from === 'user'
						? [{ role: 'user', id: `steer:${note.id}`, content: note.text,
							taskPrompt: { instruction: note.text.length, references: 0, quotes: 0 } }] : []);
					const answering = inbox?.some(({ kind }) => kind === 'question');
					const turnContext = inbox ? {
						...requestContext,
						inbox: () => inbox,
						subagentPrompt: awaitingCollaboration
							? [requestContext.subagentPrompt, '上一次答复结束时还有未完成的分工。先处理提问或核对结果，确认依赖解除后再给正式答复。'].filter(Boolean).join('\n')
							: requestContext.subagentPrompt,
					} : requestContext;
					const modelContext = collaboration?.pending().blocking ? {
						...turnContext,
							// 有待处理的分工时，先核对本次模型响应的用途，再显示正文。
						observer: { ...observer, onEvent: (event: RunEvent) => {
							if (event.type !== 'text-delta') observer.onEvent?.(event);
						} },
					} : turnContext;
					let response: Awaited<ReturnType<ModelCoordinator['nextTurn']>>;
					ctx.skillRun?.rememberCommitted(state.messages);
					for (;;) {
						const requestState = steering.length ? { ...baseRequest, messages: [...baseRequest.messages, ...steering] } : baseRequest;
						try { response = await models.nextTurn(requestState, { ...modelContext, promptMessageCount: state.messages.length, promptResuming: restoring }); break; } catch (error) {
							// 只在模型请求尚未发出时移除插话并继续原任务。
							if (error instanceof SkillSteeringError) {
								const index = steering.findIndex((message) => message.id === error.messageId);
								if (index < 0) throw error;
								steering.splice(index, 1);
								ctx.rejectSteering?.([error.messageId.slice('steer:'.length)], error.message);
								if (steering.length) continue;
							} else if (error instanceof InitialContextBudgetError && (steering.length || finishing)) {
								ctx.rejectSteering?.(steering.map(({ id }) => id.slice('steer:'.length)));
								steering.length = 0;
							} else { throw error; }
							if (finishing && !collaboration?.pending().blocking) {
								await update({ status: 'done' });
								break turns;
							}
							if (requestState === baseRequest) throw error;
						}
					}
					signal.throwIfAborted();
					if (steering.length) {
						// 只有模型请求成功后才把插话写入本轮记录，并在同一次写入中移出队列。
						const checkpoint = { type: 'state' as const, state: { ...state, messages: [...state.messages, ...steering] } };
						await ctx.record?.(checkpoint);
						state = checkpoint.state;
						observer.onEvent?.(checkpoint);
						signal.throwIfAborted();
					}
					const truncated = response.stopReason === 'limit';
					const calls = truncated ? [] : response.toolCalls.map((call) => {
						const label = ctx.mcpRun?.label(call.name, call.input);
						return label ? { ...call, label } : call;
					});
					const finished = response.stopReason === 'end' && calls.length === 0;
					if (finished && ctx.takeSteering) {
						const pending = await readSteering(ctx);
						if (pending.length) lateSteering = pending;
					}
					const progress = finished ? collaboration?.pending() : undefined;
					const held = progress?.blocking === true;
					awaitingCollaboration = held;
					const content = held ? '' : outputSoFar === undefined ? response.content : newContinuationText(outputSoFar, response.content);
					// 工具请求保留原始签名，修正后的纯文字用已拼接的正文回放。
					const keepRaw = !held && !truncated && (content === response.content || calls.length > 0);
					if (calls.some((call) => !call.id) || new Set(calls.map((call) => call.id)).size !== calls.length) {
						throw new Error('模型返回了无法配对的工具请求。');
					}
					const next = nextTurnAction(response, content, {
						newInput: finished && (Boolean(lateSteering) || hasNewInboxMessage(ctx, inbox)),
						collaboration: progress,
						checkEmptyReply: finished && !held && !earlyEndCheck && outputSoFar === undefined
							&& !response.content.trim() && mayHaveStoppedEarly(state.messages),
					});
					await update({
						messages: [...state.messages, ...userNotes, assistantReply(state, response, content, keepRaw, calls)],
						pendingCalls: calls,
						status: next === 'finish' ? 'done' : state.status,
					});
					if (inbox?.length) await ctx.acceptInbox?.(inbox.map(({ id }) => id));
					if (steering.length || userNotes.length) progressVersion++;

					if (next === 'continue-text') {
						outputSoFar = (outputSoFar ?? '') + content;
						continue;
					}
					if (next === 'stop-at-limit') {
						await stopAtLimit('模型的回答被截断，已保留收到的内容。');
						break;
					}
					outputSoFar = undefined;
					if (next === 'finish') break;
					if (next === 'incomplete-calls') throw new Error('模型结束了本轮，却没有给出完整的工具请求。');
					if (next !== 'run-tools') {
						if (next === 'check-empty-reply') earlyEndCheck = 'pending';
						if (next === 'wait-for-collaboration') await waitForTurnInput(ctx);
						continue;
					}
					const admission = batchAdmission(ctx, inbox, answering === true, resuming ? skipContinuation : undefined, response.requiredToolIntents);
					const signatures = new Map(calls.map((call) => [call.id, toolSignature(call)]));
					const allStalled = (pending: ToolCall[]) => pending.length > 0 && pending.every((call) => {
						const outcome = toolOutcomes.get(signatures.get(call.id)!);
						return outcome?.progressVersion === progressVersion && outcome.unchanged >= MAX_UNCHANGED_RESULTS;
					});
					if (allStalled(calls) && !await admission.userHasSteered()) {
						await stopAtLimit(repeatedToolsError);
						break;
					}

					for await (const { call, result, skipped } of tools.runCalls(state, requestContext, approve, admission.skip)) {
						if (result.isError && signal.reason === pauseRun) signal.throwIfAborted();
						if (!skipped || !await admission.userHasSteered()) remember(call, result);
						if (resuming && !skipped && !result.isError) await rememberResumeChange(call, 'current');
						const message: Message = {
							role: 'tool', content: result.content, toolCallId: call.id,
							toolName: call.name, isError: result.isError, skipped: skipped || undefined,
							toolDurationMs: result.durationMs,
							...(result.shellStatus && { shellStatus: result.shellStatus }),
							...(result.approvalReview && { approvalReview: result.approvalReview }),
							...(result.noteChange && !skipped && !result.isError && { noteChange: result.noteChange }),
							...(result.imageRefs?.length && !skipped && !result.isError && { imageRefs: result.imageRefs }),
						};
						if (result.fileRead) ctx.readDelivery.remember(message, result.fileRead);
						if (call.name === 'Read' && !result.isError && ctx.promptContext && ctx.directoryRules?.trusted()) {
							const path = (call.input as { file_path?: unknown } | null)?.file_path;
							if (typeof path === 'string' && !/^https?:/iu.test(path)) {
								const location = await resolveToolPath(ctx, path, 'read').catch(() => undefined);
								if (location?.vaultPath) ctx.promptContext.directories.add(location.vaultPath);
							}
						}
						await update({
							messages: [...state.messages, message],
							pendingCalls: state.pendingCalls.slice(1),
						});
						observer.onEvent?.({ type: 'tool-end', call, result, skipped });
						signal.throwIfAborted();
						if (allStalled(state.pendingCalls) && !await admission.userHasSteered()) {
							await stopAtLimit(repeatedToolsError);
							break;
						}
					}
					if (state.status === 'limit') break;
				}
			} catch (error) {
				if (signal.reason === pauseRun) return { ...state, status: 'interrupted' };
				const interrupted = skippedResults(state.pendingCalls, signal.aborted ? '任务已停止。' : '任务已中断。');
				// 持久化失败时仍将当前内存状态报告给界面。
				await update({
					status: signal.aborted ? 'cancelled' : 'failed',
					messages: [...state.messages, ...interrupted],
					pendingCalls: [],
					error: signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
				}).catch(() => {});
			}
			return state;
		},
	};
}
