import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { App, FileSystemAdapter } from 'obsidian';
import { conversationHistory } from './context/conversationHistory';
import { createRunContext } from './runContext';
import { canResumeRun, createResumeReview, pauseRun, ResumeThinkingUnavailable } from './runResume';
import { chatModelKey } from './settings/thinking';
import { trackRun } from './storage/runTranscript';
import { createTask } from './taskManager';
import type {
	ConversationSnapshot, ConversationStore, ModelService, RunContext, RunObserver, RunState, RuntimeLayer, SavedRun, ScribeSettings, SessionController, Task,
} from '../types';

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
	{ restored, replaceFromTaskId }: { restored?: { run: SavedRun; conversation: ConversationSnapshot }; replaceFromTaskId?: string } = {},
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
	const transcript = trackRun(replaceFromTaskId === undefined ? conversations : {
		...conversations,
		append: (id, entries) => entries[0]?.type === 'start'
			? conversations.replaceFrom(id, replaceFromTaskId, entries) : conversations.append(id, entries),
	}, task, observer, restored?.run);
	const review = restored && observer.confirmResume
		? createResumeReview(task.request, observer.confirmResume, signal, checkModel, transcript.record)
		: undefined;
	const runSignal = review?.signal ?? signal;
	let started = false;
	let state: RunState;
	try {
		const conversationId = task.request.conversationId;
		const snapshot = restored?.conversation ?? await conversations.load(conversationId);
		const replaceAt = replaceFromTaskId === undefined ? undefined
			: snapshot.runs.findIndex((run) => run.state.taskId === replaceFromTaskId);
		if (replaceAt === -1) throw new Error('对话中找不到这条消息。');
		const saved = restored || replaceAt !== undefined
			? { ...snapshot, runs: snapshot.runs.slice(0, restored ? -1 : replaceAt) } : snapshot;
		await conversations.setLastOpened(conversationId);
		const cwd = (app.vault.adapter as FileSystemAdapter).getBasePath();
		let ctx: RunContext | undefined;
		try {
			ctx = await createRunContext(task, {
				cwd, model: selection, signal: runSignal, checkModel, observer: transcript.observed,
				record: review ? (event) => review.record(event) : transcript.record, resumeReview: review?.review,
				...(task.request.selection ? {} : conversationHistory(saved)),
			}, app.vault.configDir, () => toolsEnabledAtStart && toolsEnabled());
		} finally {
			if (!restored && (replaceFromTaskId === undefined || ctx)) {
				if (replaceFromTaskId !== undefined) {
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
		if ((restored || replaceFromTaskId !== undefined) && !started) throw error;
		state = failedRun(task, runSignal, error);
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

/** 提交和续做共用一个运行入口，防止同一任务被同时启动。 */
export function createSessionController(
	app: App,
	settings: ScribeSettings,
	runtime: RuntimeLayer,
	conversations: ConversationStore,
	thinkingOptions?: ModelService['thinkingOptions'],
): SessionController {
	let active: { id: string; conversationId: string; controller: AbortController } | undefined;
	const deleting = new Set<string>();
	let disposed = false;
	function launch(conversationId: string, taskId: string, run: (signal: AbortSignal) => Promise<RunState>) {
		if (disposed) throw new Error('插件已关闭。');
		if (active) throw new Error('已有任务正在运行。');
		if (deleting.has(conversationId.toLowerCase())) throw new Error('对话正在删除。');
		const controller = new AbortController();
		active = { id: taskId, conversationId, controller };
		const result = run(controller.signal);
		return { taskId, result: result.finally(() => { if (active?.controller === controller) active = undefined; }) };
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
			if (id) await conversations.setLastOpened(id);
			return saved;
		},
		async forkConversation(id, taskId) {
			if (disposed) throw new Error('插件已关闭。');
			if (active) throw new Error('请先停止正在运行的任务。');
			if (deleting.has(id.toLowerCase())) throw new Error('对话正在删除。');
			const branch = await conversations.fork(id, taskId);
			await conversations.setLastOpened(branch.id);
			return branch;
		},
		async renameConversation(id, title) {
			if (disposed) throw new Error('插件已关闭。');
			await conversations.rename(id, title);
		},
		async deleteConversation(id) {
			if (disposed) throw new Error('插件已关闭。');
			const key = id.toLowerCase();
			if (active?.conversationId.toLowerCase() === key) throw new Error('请先停止这段对话中的任务。');
			if (deleting.has(key)) throw new Error('对话正在删除。');
			deleting.add(key);
			try {
				await conversations.delete(id);
			} finally {
				deleting.delete(key);
			}
		},
		submit(request, observer = {}, replaceFromTaskId) {
			const { providerId, model } = settings;
			if (!request.instruction.trim()) throw new Error('请输入任务。');
			if (!providerId || !model) throw new Error('请先在设置中选择模型。');
			const task = createTask(request);
			for (const ref of task.request.refs) {
				if (isAbsolute(ref.path)) ref.addedExternal = true;
			}
			return launch(request.conversationId, task.id, async (signal) => {
				const selection: RunContext['model'] = { providerId, model };
				const preferred = settings.thinkingByModel[chatModelKey(providerId, model)];
				selection.reasoning = thinkingOptions ? thinkingOptions(selection, preferred).level ?? null : preferred;
				return runTask(task, app, settings, runtime, conversations, selection, signal, observer, { replaceFromTaskId });
			});
		},
		resume(conversationId, taskId, observer = {}) {
			return launch(conversationId, taskId, async (signal) => {
				const conversation = await conversations.load(conversationId);
				const run = conversation.runs.at(-1);
				if (!canResumeRun(run) || run.state.taskId !== taskId) throw new Error('无法从此处继续任务，请先核对已保存的进度。');
				if (settings.providerId !== run.model.providerId || settings.model !== run.model.model) {
					throw new Error(`请先选择原任务使用的模型 ${run.model.model}。`);
				}
				if (run.model.reasoning && thinkingOptions && !thinkingOptions(run.model).levels.includes(run.model.reasoning)) {
					throw new ResumeThinkingUnavailable(run.model.reasoning);
				}
				const refs = run.request.refs.filter(({ path, addedExternal }) => !isAbsolute(path) || addedExternal === true);
				const task = { ...createTask({ ...run.request, refs }), id: taskId };
				return runTask(task, app, settings, runtime, conversations, run.model, signal, observer, { restored: { run, conversation } });
			});
		},
		cancel(taskId) {
			if (active?.id === taskId) active.controller.abort();
			return Promise.resolve();
		},
		pause(taskId) {
			if (active?.id === taskId) active.controller.abort(pauseRun);
		},
		dispose() {
			disposed = true;
			active?.controller.abort(pauseRun);
		},
	};
}
