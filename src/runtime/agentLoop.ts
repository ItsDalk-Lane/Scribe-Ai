import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { taskMessage } from '../orchestration/context/contextBuilder';
import { pauseRun } from '../orchestration/runResume';
import { isWithinPath, toolAbsolutePath } from '../tools/support/pathUtils';
import { toolSignature } from '../tools/support/toolSignature';
import { editTextNotFound } from '../tools/writeTools';
import type { AgentLoop, Message, ModelCoordinator, ModelResponse, NoteRef, RunContext, RunState, TerminalRunStatus, ToolApproval, ToolCall, ToolCoordinator, ToolResult } from '../types';
import { latestIncompleteReply, newContinuationText } from './continuationText';
import { InitialContextBudgetError } from './modelCoordinator';
import { explicitNoteTargets } from './noteTargets';
import { assistantMessageId } from './runState';

const MAX_TURNS = 32;
const MAX_TOOL_CALLS = 256;
const MAX_UNCHANGED_RESULTS = 3;
const MAX_OUTPUT_CONTINUATIONS = 2;
const fileChangeTools = new Set(['Write', 'Edit', 'NotebookEdit']);
const noteRepairTools = new Set(['Read', 'Glob', 'Grep', ...fileChangeTools]);
const repeatedToolsError = '工具多次返回相同结果，已停止重复操作。';
const pendingResume = '退出前未执行。继续任务时请补做此步骤，修改文件仍需重新请求确认。';
const legacyPendingResume = '退出前未执行。继续任务时需要重新请求确认。';
const outputContinuation: Message = {
	role: 'user',
	content: '上一轮回答被截断。请从截断处继续原任务，保留原有格式，避免重复已写的内容或已完成的操作。需要工具时，重新给出完整的请求。',
};

function skippedResults(calls: ToolCall[], content: string): Message[] {
	return calls.map((call) => ({ role: 'tool', toolCallId: call.id, toolName: call.name, isError: true, skipped: true, content }));
}

function assistantReply(state: RunState, response: ModelResponse, content: string, raw: boolean, toolCalls?: ToolCall[]): Message {
	const message: Message = {
		role: 'assistant', id: response.id ?? assistantMessageId(state), content, toolCalls,
		truncated: response.stopReason === 'limit' ? true : undefined,
		metrics: response.metrics,
		reportedUsage: response.reportedUsage,
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

function taskOutcome(
	results: { target: string; path?: string; result: ToolResult }[], written: Map<string, string>, missing: string[],
): { status: TerminalRunStatus; content?: string } {
	const failures = new Set<string>();
	for (const { target, path, result } of results) {
		if (!result.isError) continue;
		const status = path && written.has(path) ? '仍有修改未完成' : '未完成';
		failures.add(`${target} ${status}（${result.content}）`);
	}
	for (const target of missing) failures.add(`${target} 未完成（尚未尝试写入）`);
	if (!failures.size) return { status: written.size ? 'file-changes-done' : 'done' };
	const successes = Array.from(written, ([path, target]) => {
		const unfinished = results.some((item) => item.path === path && item.result.isError);
		return `${target} ${unfinished ? '已写入部分修改' : '已完成'}`;
	});
	return {
		status: written.size || results.some(({ result }) => !result.isError) ? 'partial' : 'failed',
		content: [...successes, ...failures].join('\n'),
	};
}

async function canSteerWithRefs(ctx: RunContext, refs: NoteRef[]): Promise<boolean> {
	const { cwd, permissions } = ctx;
	const readable = await Promise.all(refs.map(async ({ path, lines }) => {
		try {
			const absolute = toolAbsolutePath(cwd, path);
			if (!permissions.canRead(absolute)) return false;
			const canonical = await realpath(absolute);
			const allowed = permissions.readLines?.(canonical);
			return permissions.canRead(canonical) && (!allowed || Boolean(lines && lines[0] >= allowed[0] && lines[1] <= allowed[1]));
		} catch {
			return false;
		}
	}));
	return readable.every(Boolean);
}

export function createAgentLoop(models: ModelCoordinator, tools: ToolCoordinator): AgentLoop {
	return {
		async run(ctx, initialState) {
			let state = initialState;
			const { signal, observer, task } = ctx;
			const resuming = initialState.status === 'interrupted';
			let callsRemaining = MAX_TOOL_CALLS;
			let continuations = 0;
			let outputSoFar: string | undefined;
			let progressVersion = 0;
			const toolOutcomes = new Map<string, { content: string; isError: boolean; unchanged: number; progressVersion: number }>();
			const operations = new Map<string, { target: string; path?: string; editIntent?: string; result: ToolResult }>();
			const written = new Map<string, string>();
			const priorWrittenPaths = new Set<string>();
			const completedChanges = new Set<string>();
			const pendingOverwrites = new Set<string>();
			let repairPaths: Set<string> | undefined;
			let repairPrompt: Message | undefined;
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
				if (!observer.approve) return false;
				await update({ status: 'awaiting-approval' });
				let stop: () => void = () => {};
				const cancelled = new Promise<false>((resolve) => {
					stop = () => resolve(false);
					signal.addEventListener('abort', stop, { once: true });
				});
				try {
					return !signal.aborted && await Promise.race([observer.approve(approval, signal), cancelled]);
				} finally {
					signal.removeEventListener('abort', stop);
					if (!signal.aborted) await update({ status: 'running' });
				}
			};

			try {
				signal.throwIfAborted();
				const explicit = task.request.selection || ctx.sideChat ? new Map<string, string>() : explicitNoteTargets(task.request.instruction, ctx.cwd);
				const vaultRoot = explicit.size || resuming ? await realpath(ctx.cwd) : ctx.cwd;
				const notePath = (name: string) => {
					const path = resolve(ctx.cwd, name);
					return isWithinPath(ctx.cwd, path) ? resolve(vaultRoot, relative(ctx.cwd, path)) : path;
				};
				const expected = new Map(Array.from(explicit, ([path, name]) => [notePath(path), name]));
				const mayWrite = (path: string) => (!repairPaths || repairPaths.has(path))
					&& (!resuming || !expected.size || expected.has(path));
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
				const continuationContext = { ...ctx, permissions: {
					...ctx.permissions,
					canWrite: (path: string) => ctx.permissions.canWrite(path) && mayWrite(notePath(path)),
					canCallTool: (tool: Parameters<typeof ctx.permissions.canCallTool>[0]) =>
						ctx.permissions.canCallTool(tool) && noteRepairTools.has(tool.name),
				} };
				const skipContinuation = async (call: ToolCall) => {
					if ((!resuming && !repairPaths) || !fileChangeTools.has(call.name)) return;
					const target = fileTarget(call);
					if (!target) return;
					if (!mayWrite(notePath(target))) return '此文件不属于本次续做或补写的目标。';
					if (!resuming) return;
					const path = await canonicalNote(target);
					const key = fileChangeSignature(call, path);
					if (completedChanges.has(key)) return '此项修改已完成，已跳过重复操作。';
					if (call.name === 'Write' && priorWrittenPaths.has(path) && !pendingOverwrites.has(key)) {
						return '此文件已有保存的修改，请用局部编辑继续，以免覆盖先前的工作。';
					}
					return undefined;
				};
				const remember = async (call: ToolCall, result: ToolResult, kind?: 'restored' | 'pending' | 'skipped') => {
					const signature = toolSignature(call);
					const { content, isError } = result;
					if (kind !== 'pending') {
						callsRemaining--;
						const previous = toolOutcomes.get(signature);
						const sameResult = previous?.content === content && previous.isError === isError;
						// 有新结果后重新累计，避免把后续核对当成旧操作的空转。
						if (!sameResult) progressVersion++;
						const unchanged = sameResult && previous.progressVersion === progressVersion ? previous.unchanged + 1 : 1;
						toolOutcomes.set(signature, { content, isError, unchanged, progressVersion });
					}
					if (task.request.selection || kind === 'skipped') return;
					const input = call.input as Record<string, unknown> | undefined;
					if (!fileChangeTools.has(call.name)) {
						const source = input?.file_path ?? input?.path;
						const target = typeof source === 'string' ? `${call.name} ${source}` : call.name;
						let key = signature;
						if (call.name === 'Read' || call.name === 'Grep' || call.name === 'Glob') {
							const pathKey = call.name === 'Read' ? 'file_path' : 'path';
							const path = input?.[pathKey];
							const args = { ...input };
							if (typeof path === 'string' && path.trim()) args[pathKey] = notePath(path);
							if (call.name === 'Read' && (args.offset === undefined || args.offset === 0)) args.offset = 1;
							key = toolSignature({ ...call, input: args });
						}
						operations.set(key, { target, result });
						return;
					}
					const target = fileTarget(call);
					const absolute = target ? resuming ? await canonicalNote(target) : notePath(target) : undefined;
					const changeKey = absolute ? fileChangeSignature(call, absolute) : signature;
					const key = absolute && call.name === 'Write' ? toolSignature({ ...call, input: { file_path: absolute } }) : changeKey;
					if (kind === 'pending' && completedChanges.has(changeKey)) return;
					if (kind === 'pending' && call.name === 'Write') pendingOverwrites.add(changeKey);
					const replacement = input?.new_string;
					const editIntent = call.name === 'Edit' && absolute && typeof replacement === 'string' && replacement
						? JSON.stringify([absolute, replacement, input?.replace_all === true]) : undefined;
					if (!isError && absolute && target) {
						written.set(absolute, target);
						if (resuming) completedChanges.add(changeKey);
						if (kind === 'restored') priorWrittenPaths.add(absolute);
						// shortcut: 只归并同一文件、同一替换文字的原文未匹配，精确确认编辑意图需要明确的重试标识。
						if (editIntent && !operations.get(key)?.result.isError) {
							const matches = [...operations].filter(([, item]) => item.editIntent === editIntent
								&& item.result.isError && item.result.content === editTextNotFound);
							if (matches.length === 1) operations.delete(matches[0]![0]);
						}
					}
					operations.set(key, { target: target ?? '未指定文件路径', path: absolute, editIntent, result });
				};
				const rememberPending = (call: ToolCall) => remember(call, {
					callId: call.id, isError: true,
					content: fileChangeTools.has(call.name) ? '退出前尚未完成此项修改。' : '退出前尚未执行此步骤。',
				}, 'pending');
				if (resuming) {
					for (const { call, pending, result } of savedResults(state.messages)) {
						if (pending) await rememberPending(call);
						else await remember(call, result, 'restored');
					}
					for (const call of state.pendingCalls) await rememberPending(call);
					repairPrompt = { role: 'user', content: '从重开前保存的进度继续原任务。保留已经成功的修改，不要重复操作。补做之前未执行的读取、搜索和核对。同一篇笔记如有未完成的修改，请重新读取后完成。优先使用局部编辑，已记录的整篇写入才能原样重试，所有改动仍需重新请求确认。' };
					outputSoFar = latestIncompleteReply(state.messages);
					if (outputSoFar) repairPrompt.content += '上一段回复尚未完成，请从已经保存的文字末尾接着写，避免重复。';
				}
				const previous = state.messages.length && resuming ? state.messages : [...state.messages, taskMessage(task.request)];
				await update({ status: 'running', resumed: resuming || undefined, pendingCalls: [], messages: [...previous,
					...skippedResults(state.pendingCalls, pendingResume),
				] });
				while (true) {
					signal.throwIfAborted();
					if (state.turn >= MAX_TURNS) {
						await stopAtLimit('已达到单次任务的模型轮数上限。');
						break;
					}
					await update({ turn: state.turn + 1 });
					const start = { type: 'turn-start' as const, turn: state.turn };
					await ctx.record?.(start);
					observer.onEvent?.(start);
					const reminder = repairPrompt ?? (outputSoFar === undefined ? undefined : outputContinuation);
					repairPrompt = undefined;
					const steering: (Message & { id: string })[] = [];
					for (const { id, request } of ctx.takeSteering?.() ?? []) {
						if (!request.refs.length || await canSteerWithRefs(ctx, request.refs)) steering.push({ ...taskMessage(request), id: `steer:${id}` });
						else ctx.rejectSteering?.([id]);
					}
					const requestContext = resuming || repairPaths ? continuationContext : ctx;
					const baseRequest = reminder ? { ...state, messages: [...state.messages, reminder] } : state;
					const requestState = steering.length ? { ...baseRequest, messages: [...baseRequest.messages, ...steering] } : baseRequest;
					let response: ModelResponse;
					try {
						response = await models.nextTurn(requestState, requestContext);
					} catch (error) {
						// 只在模型请求尚未发出时移除插话并继续原任务。
						if (!(error instanceof InitialContextBudgetError) || !steering.length) throw error;
						ctx.rejectSteering?.(steering.map(({ id }) => id.slice('steer:'.length)));
						steering.length = 0;
						response = await models.nextTurn(baseRequest, requestContext);
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
					const calls = truncated ? [] : response.toolCalls;
					const content = outputSoFar === undefined ? response.content : newContinuationText(outputSoFar, response.content);
					const finished = response.stopReason === 'end' && calls.length === 0;
					const results = finished ? [...operations.values()] : [];
					const attempted = new Set(results.map(({ path }) => path));
					const missing = finished ? [...expected].filter(([path]) => !attempted.has(path)) : [];
					const canRepair = missing.length && !repairPaths && state.turn < MAX_TURNS && callsRemaining > 0
						&& [...written.keys()].some((path) => expected.has(path));
					if (canRepair) {
						const names = missing.map(([, name]) => name).join('、');
						// 补写仍走原有的路径校验和批准流程，只收窄可写范围。
						repairPaths = new Set(missing.map(([path]) => path));
						repairPrompt = {
							role: 'user',
							content: `完成检查发现这些目标从未尝试写入：${names}。请按原任务要求只补做这些目标。保留其他笔记的现有改动，确认写入结果后再收尾。`,
						};
						outputSoFar = undefined;
						await update({ messages: [...state.messages, assistantReply(state, response, `还未写入 ${names}，正在补做。\n\n`, false)] });
						continue;
					}
					const outcome = finished ? taskOutcome(results, written, missing.map(([, name]) => name)) : undefined;
					// 工具请求保留原始签名，修正后的纯文字用已拼接的正文回放。
					const keepRaw = !truncated && (content === response.content || calls.length > 0);
					if (calls.some((call) => !call.id) || new Set(calls.map((call) => call.id)).size !== calls.length) {
						throw new Error('模型返回了无法配对的工具请求。');
					}
					await update({
						messages: [...state.messages, assistantReply(state, response, outcome?.content ?? content, keepRaw && !outcome?.content, calls)],
						pendingCalls: calls,
						status: outcome?.status ?? state.status,
					});

					if (truncated) {
						if (continuations < MAX_OUTPUT_CONTINUATIONS && state.turn < MAX_TURNS) {
							continuations++;
							outputSoFar = (outputSoFar ?? '') + content;
							continue;
						}
						await stopAtLimit('模型的回答被截断，已保留收到的内容。');
						break;
					}
					outputSoFar = undefined;
					if (calls.length === 0) {
						if (response.stopReason === 'tool-calls') throw new Error('模型结束了本轮，却没有给出完整的工具请求。');
						break;
					}
					if (state.turn >= MAX_TURNS || calls.length > callsRemaining) {
						await stopAtLimit('继续执行将超过单次任务的运行上限。');
						break;
					}

					const signatures = new Map(calls.map((call) => [call.id, toolSignature(call)]));
					const allStalled = (pending: ToolCall[]) => pending.length > 0 && pending.every((call) => {
						const outcome = toolOutcomes.get(signatures.get(call.id)!);
						return outcome?.progressVersion === progressVersion && outcome.unchanged >= MAX_UNCHANGED_RESULTS;
					});
					if (allStalled(calls)) {
						await stopAtLimit(repeatedToolsError);
						break;
					}

					for await (const { call, result, skipped } of tools.runCalls(
						state, resuming || repairPaths ? continuationContext : ctx, approve, skipContinuation,
					)) {
						if (result.isError && signal.reason === pauseRun) signal.throwIfAborted();
						await remember(call, result, skipped ? 'skipped' : undefined);
						const message: Message = {
							role: 'tool', content: result.content, toolCallId: call.id,
							toolName: call.name, isError: result.isError, skipped: skipped || undefined,
							toolDurationMs: result.durationMs,
						};
						if (result.fileRead) ctx.readDelivery.remember(message, result.fileRead);
						await update({
							messages: [...state.messages, message],
							pendingCalls: state.pendingCalls.slice(1),
						});
						observer.onEvent?.({ type: 'tool-end', call, result, skipped });
						signal.throwIfAborted();
						if (allStalled(state.pendingCalls)) {
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
