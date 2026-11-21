import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { App, FileSystemAdapter } from 'obsidian';
import { conversationHistory } from './context/conversationHistory';
import { reviewToolApproval } from './policies/approvalReview';
import { createRunContext } from './runContext';
import { canResumeRun, createResumeReview, pauseRun, ResumeThinkingUnavailable } from './runResume';
import { chatModelKey } from './settings/thinking';
import { trackRun } from './storage/runTranscript';
import { createTask } from './taskManager';
import { MissingConversationError } from '../types';
import type {
	ConversationSnapshot, ConversationStore, ExecutionMode, ModelService, QueuedMessage, RunContext, RunObserver, RunState, RuntimeLayer, SavedRun, ScribeSettings, SessionController, Task, TaskRequest,
} from '../types';

interface Steering {
	accepting: boolean;
	pending: Map<string, { message: QueuedMessage; resolve: () => void; reject: (reason: Error) => void }>;
}

function rejectSteering(steering: Steering, ids: Iterable<string>) {
	for (const id of ids) {
		steering.pending.get(id)?.reject(new Error('当前任务无法接受这条插话。'));
		steering.pending.delete(id);
	}
}

function mainTask(request: TaskRequest): Task {
	if (!request.instruction.trim()) throw new Error('请输入任务。');
	const task = createTask(request);
	for (const ref of task.request.refs) {
		if (isAbsolute(ref.path)) ref.addedExternal = true;
	}
	return task;
}

function connectionKey(settings: ScribeSettings, provider: string, model: string): string {
	return JSON.stringify([
		settings.customProviders[provider],
		settings.communication.baseUrls[provider],
		settings.communication.protocols[provider],
		settings.communication.credentialIds[provider],
		settings.communication.proxyUrl,
		settings.modelOverrides[provider]?.[model],
		settings.providerModels[provider]?.[0],
	]);
}

function failedRun(task: Task, signal: AbortSignal, error: unknown): RunState {
	return {
		taskId: task.id,
		turn: 0,
		messages: [],
		pendingCalls: [],
		status: signal.reason === pauseRun ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed',
		error: signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
	};
}

async function runTask(
	task: Task,
	app: App,
	settings: ScribeSettings,
	runtime: RuntimeLayer,
	conversations: ConversationStore,
	selection: RunContext['model'],
	signal: AbortSignal,
	observer: RunObserver,
	{ restored, replaceFromTaskId, sideRuns, queued, steering, rememberConversation = true, executionMode, models }: {
		restored?: { run: SavedRun; conversation: ConversationSnapshot }; replaceFromTaskId?: string; sideRuns?: SavedRun[];
		queued?: { message: QueuedMessage; onStarted: () => void }; steering?: Steering; rememberConversation?: boolean;
		executionMode?: ExecutionMode; models?: Pick<ModelService, 'send' | 'contextLimits'>;
	} = {},
): Promise<RunState> {
	const { providerId, model } = selection;
	const toolsEnabled = () => settings.modelOverrides[providerId]?.[model]?.capabilities?.tools !== false;
	const toolsEnabledAtStart = toolsEnabled();
	const connection = connectionKey(settings, providerId, model);
	const checkModel = () => {
		if (connection !== connectionKey(settings, providerId, model)) {
			throw new Error('运行期间模型连接设置已变更，请重新提交任务。');
		}
	};
	const transcript = trackRun(sideRuns ? undefined : {
		async append(id, entries) {
			if (entries[0]?.type === 'start') {
				if (replaceFromTaskId !== undefined) return conversations.replaceFrom(id, replaceFromTaskId, entries);
				if (queued) {
					await conversations.append(id, entries, { messages: [queued.message], fifo: true });
					queued.onStarted();
					return;
				}
			}
			const forwarded = entries.flatMap((entry) => entry.type === 'messages'
				? entry.messages.flatMap(({ id, role }) => {
					const item = role === 'user' && id?.startsWith('steer:') && steering?.pending.get(id.slice(6));
					return item ? [item] : [];
				}) : []);
			await conversations.append(id, entries, forwarded.length ? { messages: forwarded.map(({ message }) => message) } : undefined);
			for (const item of forwarded) {
				steering?.pending.delete(item.message.id);
				item.resolve();
			}
		},
	}, task, observer, restored?.run);
	const review = restored && observer.confirmResume
		? createResumeReview(task.request, observer.confirmResume, signal, checkModel, transcript.record)
		: undefined;
	const runSignal = review?.signal ?? signal;
	let started = false;
	let state: RunState;
	try {
		const conversationId = task.request.conversationId;
		const snapshot = sideRuns ? { id: conversationId, runs: sideRuns }
			: restored?.conversation ?? await conversations.load(conversationId);
		const replaceAt = replaceFromTaskId === undefined ? undefined
			: snapshot.runs.findIndex((run) => run.state.taskId === replaceFromTaskId);
		if (replaceAt === -1) throw new Error('对话中找不到这条消息。');
		const saved = restored || replaceAt !== undefined
			? { ...snapshot, runs: snapshot.runs.slice(0, restored ? -1 : replaceAt) } : snapshot;
		if (!sideRuns && rememberConversation) await conversations.setLastOpened(conversationId);
		const cwd = (app.vault.adapter as FileSystemAdapter).getBasePath();
		let ctx: RunContext | undefined;
		try {
			ctx = await createRunContext(task, {
				cwd, model: selection, signal: runSignal, checkModel, observer: transcript.observed,
				reviewTool: executionMode === 'auto-review' && models ? async (operation) => {
					checkModel();
					const allowed = await reviewToolApproval(models, selection, task.request, operation, runSignal);
					checkModel();
					return allowed;
				} : undefined,
				record: review ? (event) => review.record(event) : transcript.record, resumeReview: review?.review,
				...(steering ? {
					takeSteering: () => Array.from(steering.pending.values(), ({ message }) => message),
					rejectSteering: (ids: string[]) => rejectSteering(steering, ids),
				} : {}),
				...(task.request.selection ? {} : conversationHistory(saved)),
			}, app.vault.configDir, () => toolsEnabledAtStart && toolsEnabled(), Boolean(sideRuns), executionMode);
		} finally {
			if (!restored && ((!queued && replaceFromTaskId === undefined) || ctx)) {
				if (replaceFromTaskId !== undefined || queued) {
					runSignal.throwIfAborted();
					checkModel();
				}
				await transcript.start(selection);
				started = true;
			}
		}
		started = true;
		const agent = runtime.createAgent(ctx, restored?.run.state);
		state = await agent.loop.run(ctx, agent.state);
	} catch (error) {
		if ((restored || replaceFromTaskId !== undefined || queued) && !started) throw error;
		state = failedRun(task, runSignal, error);
	} finally {
		if (steering) {
			steering.accepting = false;
			rejectSteering(steering, steering.pending.keys());
		}
	}
	if (restored && review && !review.approved) {
		if (runSignal.aborted) return restored.run.state;
		throw new Error(state.error ?? '无法确认续做请求的发送地址。');
	}
	if (started) {
		try {
			state = await transcript.finish(state);
		} catch {
			state = { ...state, status: 'failed', error: '无法保存最后的操作进度，请检查本地对话记录。' };
		}
	}
	transcript.observed.onEvent?.({ type: 'state', state });
	return state;
}

/** 提交和续做共用一个运行入口，每段对话同时只运行一个任务。 */
export function createSessionController(
	app: App,
	settings: ScribeSettings,
	runtime: RuntimeLayer,
	conversations: ConversationStore,
	thinkingOptions?: ModelService['thinkingOptions'],
	models?: Pick<ModelService, 'send' | 'contextLimits'>,
): SessionController {
	const active = new Map<string, { conversationId: string; controller: AbortController; steering: Steering }>();
	const deleting = new Set<string>();
	const closeSideChats = new Set<() => void>();
	let disposed = false;
	function conversationIsBusy(key: string) {
		return Array.from(active.values()).some(({ conversationId }) => conversationId === key);
	}
	function modelChoice(choice?: RunContext['model']): RunContext['model'] {
		if (choice && !settings.providerModels[choice.providerId]?.includes(choice.model)) {
			throw new Error('所选模型已不可用，请重新选择。');
		}
		return choice ?? settings;
	}
	function selectedModel(choice?: RunContext['model']): RunContext['model'] {
		const { providerId, model, reasoning } = modelChoice(choice);
		if (!providerId || !model) throw new Error('请先在设置中选择模型。');
		const selection: RunContext['model'] = { providerId, model };
		const preferred = reasoning === undefined ? settings.thinkingByModel[chatModelKey(providerId, model)] : reasoning;
		selection.reasoning = preferred === null || !thinkingOptions ? preferred : thinkingOptions(selection, preferred).level ?? null;
		return selection;
	}
	function launch(conversationId: string, taskId: string, run: (signal: AbortSignal, steering: Steering) => Promise<RunState>) {
		if (disposed) throw new Error('插件已关闭。');
		const key = conversationId.toLowerCase();
		// 分支保留历史任务编号，避免两个中断副本共用停止入口。
		if (active.has(taskId) || conversationIsBusy(key)) throw new Error('已有任务正在运行。');
		if (deleting.has(key)) throw new Error('对话正在删除。');
		const controller = new AbortController();
		const steering: Steering = { accepting: true, pending: new Map() };
		active.set(taskId, { conversationId: key, controller, steering });
		const result = run(controller.signal, steering);
		return { taskId, result: result.finally(() => {
			rejectSteering(steering, steering.pending.keys());
			active.delete(taskId);
		}) };
	}
	return {
		async createConversation() {
			const id = randomUUID();
			await conversations.setLastOpened(id);
			return id;
		},
		listConversations: () => conversations.list(),
		async openConversation(id) {
			const selected = id ?? await conversations.lastOpened() ?? (await conversations.list())[0]?.id;
			if (!selected) return null;
			const saved = await conversations.load(selected);
			if (id) {
				if (!saved.runs.length && !saved.queue?.length) throw new MissingConversationError('对话不存在。');
				await conversations.setLastOpened(id);
			}
			return saved;
		},
		async forkConversation(id, taskId, rememberConversation = true) {
			if (disposed) throw new Error('插件已关闭。');
			const key = id.toLowerCase();
			if (conversationIsBusy(key)) throw new Error('请先停止正在运行的任务。');
			if (deleting.has(key)) throw new Error('对话正在删除。');
			const branch = await conversations.fork(id, taskId);
			if (rememberConversation) await conversations.setLastOpened(branch.id);
			return branch;
		},
		async renameConversation(id, title) {
			if (disposed) throw new Error('插件已关闭。');
			await conversations.rename(id, title);
		},
		async deleteConversation(id) {
			if (disposed) throw new Error('插件已关闭。');
			const key = id.toLowerCase();
			if (conversationIsBusy(key)) throw new Error('请先停止这段对话中的任务。');
			if (deleting.has(key)) throw new Error('对话正在删除。');
			deleting.add(key);
			try {
				await conversations.delete(id);
			} finally {
				deleting.delete(key);
			}
		},
		createSideChat(parentRuns) {
			if (disposed) throw new Error('插件已关闭。');
			const id = randomUUID();
			const runs = [...parentRuns];
			let running: AbortController | undefined;
			let closed = false;
			function close() {
				closed = true;
				running?.abort();
				runs.length = 0;
				closeSideChats.delete(close);
			}
			closeSideChats.add(close);
			return {
				id,
				submit({ instruction, refs = [], chatQuotes, model: choice }, observer = {}) {
					if (closed) throw new Error('侧聊已关闭。');
					if (running) throw new Error('侧聊正在回答。');
					if (!instruction.trim()) throw new Error('请输入问题。');
					const model = selectedModel(choice);
					const task = createTask({ conversationId: id, instruction, refs: refs.filter(({ path, kind, addedExternal }) =>
						!isAbsolute(path) || (kind === 'file' && addedExternal === true)), chatQuotes });
					const request = task.request;
					const controller = new AbortController();
					running = controller;
					const result = runTask(task, app, settings, runtime, conversations, model, controller.signal,
						{ onEvent: observer.onEvent }, { sideRuns: runs }).then((state) => {
						// 关闭后，已取消的请求可以收尾，不能恢复已清空的对话。
						if (!closed && state.messages.some(({ role }) => role === 'user')) {
							runs.push({ request, model, state });
						}
						return state;
					}).finally(() => { running = undefined; });
					return { taskId: task.id, request, model, result };
				},
				stop: () => running?.abort(),
				close,
			};
		},
		submit(request, observer = {}, replaceFromTaskId, { model, rememberConversation, executionMode } = {}) {
			const selection = selectedModel(model);
			const task = mainTask(request);
			return launch(request.conversationId, task.id, (signal, steering) =>
				runTask(task, app, settings, runtime, conversations, selection, signal, observer, { replaceFromTaskId, steering, rememberConversation, executionMode, models }));
		},
		submitQueued(message, observer, onStarted, { model, rememberConversation, executionMode } = {}) {
			const selection = selectedModel(model);
			const task = mainTask(message.request);
			return launch(message.request.conversationId, task.id, (signal, steering) =>
				runTask(task, app, settings, runtime, conversations, selection, signal, observer, { queued: { message, onStarted }, steering, rememberConversation, executionMode, models }));
		},
		canSteer(conversationId, taskId) {
			const running = active.get(taskId);
			return running?.conversationId === conversationId.toLowerCase()
				&& running.steering.accepting && !running.controller.signal.aborted;
		},
		steer(taskId, message) {
			const running = active.get(taskId);
			if (!running || running.conversationId !== message.request.conversationId.toLowerCase()
				|| !running.steering.accepting || running.controller.signal.aborted || running.steering.pending.has(message.id)) {
				return Promise.reject(new Error('当前任务无法接受这条插话。'));
			}
			return new Promise((resolve, reject) => {
				running.steering.pending.set(message.id, { message, resolve, reject });
			});
		},
		resume(conversationId, taskId, observer = {}, { model, rememberConversation, executionMode } = {}) {
			return launch(conversationId, taskId, async (signal, steering) => {
				const conversation = await conversations.load(conversationId);
				const run = conversation.runs.at(-1);
				if (!canResumeRun(run) || run.state.taskId !== taskId) throw new Error('无法从此处继续任务，请先核对已保存的进度。');
				const selection = modelChoice(model);
				if (selection.providerId !== run.model.providerId || selection.model !== run.model.model) {
					throw new Error(`请先选择原任务使用的模型 ${run.model.model}。`);
				}
				if (run.model.reasoning && thinkingOptions && !thinkingOptions(run.model).levels.includes(run.model.reasoning)) {
					throw new ResumeThinkingUnavailable(run.model.reasoning);
				}
				const refs = run.request.refs.filter(({ path, addedExternal }) => !isAbsolute(path) || addedExternal === true);
				const task = { ...createTask({ ...run.request, refs }), id: taskId };
				return runTask(task, app, settings, runtime, conversations, run.model, signal, observer, { restored: { run, conversation }, steering, rememberConversation, executionMode, models });
			});
		},
		cancel(taskId) {
			active.get(taskId)?.controller.abort();
			return Promise.resolve();
		},
		pause(taskId) {
			active.get(taskId)?.controller.abort(pauseRun);
		},
		dispose() {
			disposed = true;
			for (const { controller } of active.values()) controller.abort(pauseRun);
			closeSideChats.forEach((close) => close());
		},
	};
}
