import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { App, FileSystemAdapter } from 'obsidian';
import { conversationHistory } from './context/conversationHistory';
import { createRunContext } from './runContext';
import { canResumeRun, createResumeReview, pauseRun } from './runResume';
import { trackRun } from './storage/runTranscript';
import { createTask } from './taskManager';
import type {
	ConversationSnapshot, ConversationStore, RunObserver, RunState, RuntimeLayer, SavedRun, ScribeSettings, SessionController, Task,
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
	signal: AbortSignal,
	observer: RunObserver,
	restored?: { run: SavedRun; conversation: ConversationSnapshot },
): Promise<RunState> {
	const { providerId, model } = settings;
	const selection = { providerId, model };
	const toolsEnabled = () => settings.modelOverrides[providerId]?.[model]?.capabilities?.tools !== false;
	const toolsEnabledAtStart = toolsEnabled();
	const connection = connectionKey(settings, providerId, model);
	const checkModel = () => {
		if (connection !== connectionKey(settings, providerId, model)) {
			throw new Error('运行期间模型连接设置已变更，请重新提交任务。');
		}
	};
	const transcript = trackRun(conversations, task, observer, restored?.run);
	const review = restored && observer.confirmResume
		? createResumeReview(task.request, observer.confirmResume, signal, checkModel, transcript.record)
		: undefined;
	const runSignal = review?.signal ?? signal;
	let started = false;
	let state: RunState;
	try {
		const conversationId = task.request.conversationId;
		const saved = restored ? { ...restored.conversation, runs: restored.conversation.runs.slice(0, -1) }
			: await conversations.load(conversationId);
		await conversations.setLastOpened(conversationId);
		const cwd = (app.vault.adapter as FileSystemAdapter).getBasePath();
		let ctx;
		try {
			ctx = await createRunContext(task, {
				cwd, model: selection, signal: runSignal, checkModel, observer: transcript.observed,
				record: review ? (event) => review.record(event) : transcript.record, resumeReview: review?.review,
				...(task.request.selection ? {} : conversationHistory(saved)),
			}, app.vault.configDir, () => toolsEnabledAtStart && toolsEnabled());
		} finally {
			if (!restored) {
				await transcript.start(selection);
				started = true;
			}
		}
		started = true;
		const agent = runtime.createAgent(ctx, restored?.run.state);
		state = await agent.loop.run(ctx, agent.state);
	} catch (error) {
		if (restored && !started) throw error;
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
): SessionController {
	let active: { id: string; controller: AbortController } | undefined;
	let disposed = false;
	function launch(taskId: string, run: (signal: AbortSignal) => Promise<RunState>) {
		if (disposed) throw new Error('插件已关闭。');
		if (active) throw new Error('已有任务正在运行。');
		const controller = new AbortController();
		active = { id: taskId, controller };
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
		submit(request, observer = {}) {
			if (!request.instruction.trim()) throw new Error('请输入任务。');
			if (!settings.providerId || !settings.model) throw new Error('请先在设置中选择模型。');
			const task = createTask(request);
			for (const ref of task.request.refs) {
				if (isAbsolute(ref.path)) ref.addedExternal = true;
			}
			return launch(task.id, (signal) => runTask(task, app, settings, runtime, conversations, signal, observer));
		},
		resume(conversationId, taskId, observer = {}) {
			return launch(taskId, async (signal) => {
				const conversation = await conversations.load(conversationId);
				const run = conversation.runs.at(-1);
				if (!canResumeRun(run) || run.state.taskId !== taskId) throw new Error('无法从此处继续任务，请先核对已保存的进度。');
				if (settings.providerId !== run.model.providerId || settings.model !== run.model.model) {
					throw new Error(`请先选择原任务使用的模型 ${run.model.model}。`);
				}
				const refs = run.request.refs.filter(({ path, addedExternal }) => !isAbsolute(path) || addedExternal === true);
				const task = { ...createTask({ ...run.request, refs }), id: taskId };
				return runTask(task, app, settings, runtime, conversations, signal, observer, { run, conversation });
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
