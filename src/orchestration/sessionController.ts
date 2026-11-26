import { guardModelConnection, queuedModelDestination, sameQueuedDestination } from './settings/modelConnection';
import { approvedPlanRequest, submittedPlan } from '../interaction/chatPlan';
import { obsidianSearchToolName } from '../tools/workspaceTools';
import { chatTaskReadTools } from '../tools/chatTaskTools';
import { isModelAvailable, isProviderEnabled, videoModelFor } from './settings/modelAvailability';
import { createSkillRun } from './context/skillRun';
import { bindSkillMentions } from '../skills/mentions';
import type { SkillRegistry } from './context/skills';
import { readOnlySkillTools } from '../tools/skillTools';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { App, FileSystemAdapter } from 'obsidian';
import { logScope } from '../communication/diagnostics';
import { meteredService } from './meteredService';
import { createVideoAnalysis } from './context/videoAnalysis';
import { transcodableVideo } from './context/videoEncoding';
import { videoSourceKind, videoSources } from './context/videoAttachments';
import { conversationHistory, runsAfterManualCompaction } from './context/conversationHistory';
import { createHistorySummarizer } from './context/historySummary';
import { createRunSummarizer } from './context/runSummary';
import { buildWritingRulesPrompt } from './context/writingRules';
import { reviewToolApproval } from './policies/approvalReview';
import { createRunContext } from './runContext';
import { canResumeRun, createResumeReview, pauseRun, ResumeThinkingUnavailable, wasSharedRef } from './runResume';
import { chatModelKey } from './settings/thinking';
import { trackRun } from './storage/runTranscript';
import { createTask } from './taskManager';
import { createSubagentController } from './subagents/controller';
import type { ChildRunOptions } from './subagents/controller';
import { subagentToolNames } from '../tools/subagentTools';
import { structuredOutputToolName } from '../tools/structuredOutputTool';
import type { ShellJobs } from '../tools/external/shellJobs';
import { MissingConversationError } from '../types';
import type {
	ConversationSnapshot, ConversationStore, ExecutionMode, ModelService, QueuedMessage, QueuedModelDestination, RunContext, RunObserver, RunState, RuntimeLayer, SavedRun, ScribeSettings, SessionController, SkillMention, Task, TaskRequest,
} from '../types';

type RunModels = Pick<ModelService, 'send' | 'contextLimits' | 'modelOrigin' | 'modelCapabilities'> & Partial<Pick<ModelService, 'modelConnection'>>;
const readOnlyTools = new Set([...readOnlySkillTools, ...chatTaskReadTools, 'Read', 'Glob', 'Grep', obsidianSearchToolName, ...subagentToolNames]);

interface Steering {
	accepting: boolean;
	destination?: QueuedModelDestination;
	pending: Map<string, { message: QueuedMessage; request: TaskRequest; resolve: () => void; reject: (reason: Error) => void }>;
}

function rejectSteering(steering: Steering, ids: Iterable<string>, reason = '当前任务无法接受这条插话。') {
	for (const id of ids) {
		steering.pending.get(id)?.reject(new Error(reason));
		steering.pending.delete(id);
	}
}

function mainTask(request: TaskRequest, fromSaved = false): Task {
	if (!request.instruction.trim()) throw new Error('请输入任务。');
	if (request.intent && request.target) throw new Error('请在普通聊天中指定工具或子 Agent。');
	const task = createTask({ ...request, refs: fromSaved ? request.refs.filter(wasSharedRef) : request.refs,
		approvalSource: undefined, subagentCallerTaskId: undefined, inheritedSkillIds: undefined, inheritedSkills: undefined });
	for (const ref of task.request.refs) {
		if (isAbsolute(ref.path)) ref.addedExternal = true;
	}
	return task;
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
	{ restored, replaceFromTaskId, sideSnapshot, queued, steering, rememberConversation = true, executionMode, models, subagents, child, skills }: {
		restored?: { run: SavedRun; conversation: ConversationSnapshot }; replaceFromTaskId?: string; sideSnapshot?: ConversationSnapshot;
		queued?: { message: QueuedMessage; address?: string; onStarted: () => void }; steering?: Steering; rememberConversation?: boolean;
		executionMode?: ExecutionMode; models?: RunModels; subagents?: ReturnType<typeof createSubagentController>; child?: ChildRunOptions; skills?: SkillRegistry;
	} = {},
): Promise<RunState> {
	const { providerId, model } = selection;
	const toolsEnabled = () => (settings.modelOverrides[providerId]?.[model]?.capabilities?.tools
		?? models?.modelCapabilities?.(providerId, model).tools) !== false;
	const toolsEnabledAtStart = toolsEnabled();
	const { intent } = task.request;
	const target = task.request.target;
	const directAgent = !restored && !child && !sideSnapshot && !intent && target?.kind === 'agent' ? target : undefined;
	if (skills && intent !== 'review') {
		const { refs } = task.request;
		const activeNote = child || sideSnapshot ? '' : undefined;
		task.request.skillScope ??= skills.scope(refs, activeNote);
		task.request.skillNotePaths ??= skills.notePaths(refs, restored ? '' : activeNote);
	}
	const checkModel = guardModelConnection(settings, selection, models?.modelConnection);
	if (steering) steering.destination = queuedModelDestination(selection, models?.modelConnection);
	let current: RunState | undefined;
	const trackingObserver: RunObserver = {
		...observer,
		onEvent(event) {
			if (event.type === 'state') current = event.state;
			observer.onEvent?.(event);
		},
	};
	const transcript = trackRun(child ? {
		append: (_id, entries) => child.append(entries.flatMap((entry) =>
			entry.type === 'subagent' || entry.type === 'subagent-report' || entry.type === 'chat-tasks' || entry.type === 'queue-add' || entry.type === 'queue-edit' || entry.type === 'queue-delete' ? [] : [entry])),
	} : sideSnapshot ? undefined : {
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
	}, task, trackingObserver, restored?.run);
	const sendingModels = child && models ? {
		contextLimits: models.contextLimits,
		send: ((request, receipt) => models.send({ ...request,
			beforeSend: (address) => child.confirmDestination(request, address),
		}, receipt)) as ModelService['send'],
	} : models;
	const reviewModels = executionMode === 'auto-review' && sendingModels ? meteredService(sendingModels, 'review', transcript.recordUsage) : undefined;
	const review = restored && observer.confirmResume
		? createResumeReview(task.request, observer.confirmResume, signal, checkModel, transcript.record)
		: undefined;
	const runSignal = review?.signal ?? signal;
	let started = false;
	let claimedTask = false;
	let state: RunState;
	try {
		const conversationId = task.request.conversationId;
		const snapshot = sideSnapshot ?? restored?.conversation ?? child?.snapshot ?? await conversations.load(conversationId);
		const replaceAt = replaceFromTaskId === undefined ? undefined
			: snapshot.runs.findIndex((run) => run.state.taskId === replaceFromTaskId);
		if (replaceAt === -1) throw new Error('对话中找不到这条消息。');
		const saved = restored || replaceAt !== undefined
			? { ...snapshot, runs: snapshot.runs.slice(0, restored ? -1 : replaceAt) } : snapshot;
		const { approvedPlanTaskId, revisesPlanTaskId } = task.request;
		if (approvedPlanTaskId) {
			const plan = submittedPlan(saved.runs.at(-1));
			if (child || sideSnapshot || intent || !plan || plan.taskId !== approvedPlanTaskId
				|| approvedPlanRequest(plan).instruction !== task.request.instruction) throw new Error('待执行计划已变化，请重新核对并确认。');
		}
		if (revisesPlanTaskId) {
			const previous = saved.runs.at(-1);
			if (child || sideSnapshot || intent !== 'plan' || previous?.request.intent !== 'plan'
				|| previous.state.taskId !== revisesPlanTaskId) throw new Error('正在修改的计划已变化，请重新选择计划。');
		}
		if (!child && !sideSnapshot && rememberConversation) await conversations.setLastOpened(conversationId);
		const cwd = (app.vault.adapter as FileSystemAdapter).getBasePath();
		let ctx: RunContext | undefined;
		let directSkills: SkillMention[] = [];
		try {
			const { refs } = task.request;
			if (directAgent && !toolsEnabledAtStart) throw new Error('当前模型已停用工具，无法启动选定的子 Agent。');
			if (skills && (directAgent || queued || replaceFromTaskId !== undefined) && task.request.instruction.includes('$')) {
				directSkills = bindSkillMentions(task.request.instruction, task.request.skillMentions ?? [],
					await skills.list(refs, '', task.request.skillScope));
			}
			const writingRules = intent === 'review' ? undefined : await buildWritingRulesPrompt(app.vault);
			ctx = await createRunContext(task, {
				cwd, model: selection, signal: runSignal, checkModel, observer: transcript.observed, writingRules,
				reviewTool: reviewModels ? async (operation) => {
					checkModel();
					const allowed = await reviewToolApproval(reviewModels, selection, task.request, operation, runSignal);
					checkModel();
					return allowed;
				} : undefined,
				record: review ? (event) => review.record(event) : transcript.record, resumeReview: review?.review,
				...(steering ? {
					takeSteering: () => Array.from(steering.pending.values(), ({ message, request }) => ({ id: message.id, request })),
					rejectSteering: (ids: string[], reason?: string) => rejectSteering(steering, ids, reason),
				} : {}),
				...(intent !== 'review' && conversationHistory(saved)),
			}, app.vault.configDir, () => toolsEnabledAtStart && toolsEnabled(), Boolean(sideSnapshot), executionMode);
			if (queued?.address) {
				const expected = new URL(queued.address);
				const prefix = expected.pathname.replace(/\/+$/u, '');
				ctx.destinationCheck = async (_request, address) => {
					const actual = new URL(address);
					if (actual.origin !== expected.origin || (actual.pathname !== prefix && !actual.pathname.startsWith(prefix + '/'))) {
						throw new Error('排队消息的实际接收地址已变更，请检查模型设置。');
					}
				};
			}
			ctx.recordUnfinishedRequest = (receipt) => transcript.recordUsage({ kind: 'main-attempt', ...receipt });
			const runPermissions = ctx.permissions;
			ctx.permissions = { ...runPermissions, canCallTool: (tool) => runPermissions.canCallTool(tool)
				&& (tool.name !== structuredOutputToolName || models?.modelCapabilities?.(providerId, model).structuredOutput === true) };
			if (skills && intent !== 'review') ctx.skillRun = createSkillRun(skills, task.request,
				models?.contextLimits?.(selection)?.contextWindow, runSignal, task.id, observer.onWork && ((active) => observer.onWork?.(task.id, active)));
			if (child) {
				ctx.subagentId = child.agentId;
				ctx.history = [...child.baseHistory ?? [], ...ctx.history ?? []];
				ctx.destinationCheck = child.confirmDestination;
				if (child.readOnly) {
					const policy = ctx.permissions;
					ctx.permissions = { ...policy, canWrite: () => false,
						canRequestPath: (path, operation) => operation === 'read' && policy.canRequestPath?.(path, operation) === true,
						canCallTool: (tool) => policy.canCallTool(tool) && readOnlyTools.has(tool.name) };
				}
			}
			if (!sideSnapshot && intent !== 'review') {
				const list = conversations.chatTasks;
				const actor = { owner: child?.agentId ?? 'root', runId: task.id, planRunId: intent === 'plan' ? task.id : undefined };
				ctx.chatTasks = {
					list: () => list.list(conversationId),
					get: (id) => list.get(conversationId, id),
					create: (input) => list.create(conversationId, actor, input),
					async update(input) {
						const changed = await list.update(conversationId, actor, input);
						if (changed.status === 'in_progress') claimedTask = true;
						return changed;
					},
				};
				const summaryModels = sendingModels ? meteredService(sendingModels, 'summary', transcript.recordUsage) : undefined;
				const save = (entries: Parameters<ChildRunOptions['append']>[0]) => child
					? child.append(entries) : conversations.append(conversationId, entries);
				// 续做再次整理当前任务前，先完成已有的内容和发送地址确认。
				ctx.runCompaction = createRunSummarizer(ctx, summaryModels, () => !restored || review?.approved === true,
					(summary) => save([{ type: 'run-summary', taskId: task.id, summary }]),
					restored?.run.runSummary);
				ctx.summarizeHistory = createHistorySummarizer(runsAfterManualCompaction(saved), ctx, restored ? undefined : summaryModels,
					(summary) => save([{ type: 'history-summary', taskId: task.id, summary }]),
					restored?.run.historySummary);
			}
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
		if (approvedPlanTaskId) await conversations.chatTasks.approvePlan(conversationId, approvedPlanTaskId);
		if (ctx && subagents && !sideSnapshot && !intent) {
			if (replaceFromTaskId) await subagents.reload(conversationId);
			else await subagents.controls.load(conversationId);
			if (directAgent) {
				runSignal.throwIfAborted();
				checkModel();
			}
			await subagents.connect(ctx, () => current, child?.agentId, child?.readOnly, directAgent && { role: directAgent.id, skills: directSkills });
			if (child?.instructions) ctx.subagentPrompt = [ctx.subagentPrompt, child.instructions].filter(Boolean).join('\n');
		}
		const savedVideo = restored?.run.videoAnalysis;
		if (ctx && savedVideo) {
			ctx.videoAnalysis = { sources: restored.run.videoAnalysisSources ?? ['file', 'link'], read: () => Promise.resolve(savedVideo) };
		} else if (ctx && models && !sideSnapshot && !child && !intent) {
			const prior = restored?.run ?? (replaceAt !== undefined ? snapshot.runs[replaceAt] : saved.runs.at(-1));
			const previous = prior && ['interrupted', 'failed', 'cancelled'].includes(prior.state.status) ? prior.videoItems : undefined;
			ctx.videoAnalysis = createVideoAnalysis(ctx, settings, models, transcript.recordUsage,
				(content, sources) => conversations.append(task.request.conversationId, [{ type: 'video-analysis', taskId: task.id, content, sources }]),
				{ previous, alreadySaved: Boolean(restored), save: (item) => conversations.append(task.request.conversationId, [{ type: 'video-item', taskId: task.id, item }]) },
				restored ? observer.confirmResume : undefined);
		}
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
			if (claimedTask) await conversations.chatTasks.release(task.request.conversationId, task.id);
			state = await transcript.finish(state);
		} catch {
			state = { ...state, status: 'failed', error: '无法保存最后的操作进度，请检查本地对话记录。' };
		}
	}
	state = transcript.withDetails(state);
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
	models?: RunModels,
	shellJobs?: ShellJobs,
	skills?: SkillRegistry,
	onConversationDeleted?: (id: string) => Promise<void>,
): SessionController {
	const active = new Map<string, { conversationId: string; controller: AbortController; steering: Steering }>();
	const deleting = new Set<string>();
	const closeSideChats = new Set<() => void>();
	let disposed = false;
	function conversationIsBusy(key: string) {
		return Array.from(active.values()).some(({ conversationId }) => conversationId === key);
	}
	function modelChoice(choice?: RunContext['model']): RunContext['model'] {
		if (choice ? !isModelAvailable(settings, choice) : !isProviderEnabled(settings, settings.providerId)) {
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
	function restoredModel(selection: RunContext['model']): RunContext['model'] {
		if (selection.reasoning && thinkingOptions && !thinkingOptions(selection).levels.includes(selection.reasoning)) {
			throw new ResumeThinkingUnavailable(selection.reasoning);
		}
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
		// 这段任务发起的所有模型请求都记入该对话的日志文件。
		const result = logScope.run(conversationId.toLowerCase(), () => run(controller.signal, steering));
		return { taskId, result: result.finally(() => {
			rejectSteering(steering, steering.pending.keys());
			active.delete(taskId);
		}) };
	}
	const subagents = createSubagentController(settings, conversations,
		(task, model, signal, observer, executionMode, child) => logScope.run(task.request.conversationId.toLowerCase(),
			() => runTask(task, app, settings, runtime, conversations, model, signal, observer, {
				executionMode, child, models, subagents, skills,
				restored: child.restored && { run: child.restored, conversation: child.snapshot },
			})), (model, restored) => restored ? restoredModel(modelChoice(model)) : selectedModel(model), models,
		shellJobs && ((id, agents) => shellJobs.stopSubagents(id, agents)));
	return {
		subagents: subagents.controls,
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
				if (!saved.runs.length && !saved.queue?.length && !saved.hasGoal) throw new MissingConversationError('对话不存在。');
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
			if (conversationIsBusy(key) || subagents.busy(id)) throw new Error('请先停止这段对话中的任务。');
			if (deleting.has(key)) throw new Error('对话正在删除。');
			deleting.add(key);
			try {
				await shellJobs?.stopConversation(id);
				await conversations.delete(id);
				subagents.forget(id);
				shellJobs?.forgetConversation(id);
				await onConversationDeleted?.(id);
			} finally {
				deleting.delete(key);
			}
		},
		createSideChat(parentRuns, manualCompaction) {
			if (disposed) throw new Error('插件已关闭。');
			const id = randomUUID();
			const runs = [...parentRuns];
			const sideSnapshot = { id, runs, manualCompaction };
			const parent = parentRuns.at(-1)?.request;
			const parentScope = parent?.skillScope ?? skills?.scope(parent?.refs);
			const parentPaths = parent?.skillNotePaths ?? skills?.notePaths(parent?.refs);
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
				skillScope: parentScope,
				submit(draft, observer = {}) {
					const { instruction, refs = [], chatQuotes, skillScope, skillNotePaths, skillMentions, imageSourcePath, model: choice } = draft;
					if (closed) throw new Error('侧聊已关闭。');
					if (running) throw new Error('侧聊正在回答。');
					if ('target' in draft && draft.target) throw new Error('请在普通聊天中指定工具或子 Agent。');
					if (!instruction.trim()) throw new Error('请输入问题。');
					const model = selectedModel(choice);
					if (draft.queued && (!draft.queued.destination
						|| !sameQueuedDestination(draft.queued.destination, queuedModelDestination(model, models?.modelConnection)))) {
						throw new Error('侧聊的接收方与排队记录不一致。请切换到原模型，或在主聊天确认接收方后发送。');
					}
					const allowedRefs = refs.filter((ref) => !isAbsolute(ref.path) || (ref.kind === 'file' && wasSharedRef(ref)));
					const notePaths = skills?.notePaths(allowedRefs, '');
					const task = createTask({ conversationId: id, instruction, skillMentions,
						imageSourcePath,
						skillScope: skillScope ?? (notePaths?.length ? skills?.scope(allowedRefs, '') : parentScope),
						skillNotePaths: skillNotePaths ?? (notePaths?.length ? notePaths : parentPaths), refs: allowedRefs, chatQuotes });
					const request = task.request;
					const controller = new AbortController();
					running = controller;
					// 侧聊不单独存档，它的请求记录归到所属对话。
					const logOwner = (parentRuns.at(-1)?.request.conversationId ?? id).toLowerCase();
					const result = logScope.run(logOwner, () => runTask(task, app, settings, runtime, conversations, model, controller.signal,
						{ onEvent: observer.onEvent }, { sideSnapshot, skills, models })).then((state) => {
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
			const task = mainTask(request, replaceFromTaskId !== undefined);
			if (replaceFromTaskId && subagents.busy(request.conversationId)) throw new Error('请先停止这段对话的子任务。');
			return launch(request.conversationId, task.id, (signal, steering) =>
				runTask(task, app, settings, runtime, conversations, selection, signal, observer, { replaceFromTaskId, steering, rememberConversation, executionMode, models, subagents, skills }));
		},
		submitQueued(message, observer, onStarted, { model, rememberConversation, executionMode, confirmQueuedDestination } = {}) {
			const selection = selectedModel(model);
			const task = mainTask(message.request, true);
			return launch(message.request.conversationId, task.id, async (signal, steering) => {
				let address: string | undefined;
				if (models?.modelConnection) {
					const destination = queuedModelDestination(selection, models.modelConnection);
					if (!destination) throw new Error('无法确认排队消息的模型地址，请检查模型设置。');
					if (!sameQueuedDestination(message.destination, destination)) {
						if (!await confirmQueuedDestination?.(message.destination, destination, signal)) {
							signal.throwIfAborted();
							throw new Error('排队消息的接收方已变更或未保存。请选择继续队列并确认发送。');
						}
						signal.throwIfAborted();
						modelChoice(selection);
						if (!sameQueuedDestination(destination, queuedModelDestination(selection, models.modelConnection))) {
							throw new Error('确认后模型地址再次变更，请重新确认。');
						}
					}
					address = destination.baseUrl;
				}
				return runTask(task, app, settings, runtime, conversations, selection, signal, observer, {
					queued: { message, address, onStarted }, steering, rememberConversation, executionMode, models, subagents, skills,
				});
			});
		},
		canSteer(conversationId, taskId) {
			const running = active.get(taskId);
			return running?.conversationId === conversationId.toLowerCase()
				&& running.steering.accepting && !running.controller.signal.aborted;
		},
		steer(taskId, message) {
			if (message.request.selection) return Promise.reject(new Error('选区问答已停用，请新建普通提问。'));
			if (message.request.target) return Promise.reject(new Error('指定了工具或子 Agent 的消息需要单独发送。'));
			if (videoSources(message.request, transcodableVideo).some((source) => videoModelFor(settings, videoSourceKind(source)))) {
				return Promise.reject(new Error('含视频的消息需作为独立任务发送，请等待队列自动发送。'));
			}
			const running = active.get(taskId);
			if (!running || running.conversationId !== message.request.conversationId.toLowerCase()
				|| !running.steering.accepting || running.controller.signal.aborted || running.steering.pending.has(message.id)) {
				return Promise.reject(new Error('当前任务无法接受这条插话。'));
			}
			if (models?.modelConnection && (!message.destination || !sameQueuedDestination(message.destination, running.steering.destination))) {
				return Promise.reject(new Error('当前任务的接收方与排队记录不一致。请从队列确认后独立发送。'));
			}
			return new Promise((resolve, reject) => {
				const request = message.request.skillNotePaths || !skills ? message.request
					: { ...message.request, skillNotePaths: skills.notePaths(message.request.refs, '') };
				running.steering.pending.set(message.id, { message, request, resolve, reject });
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
				const refs = run.request.refs.filter(wasSharedRef);
				const task = { ...createTask({ ...run.request, refs }), id: taskId };
				return runTask(task, app, settings, runtime, conversations, restoredModel(run.model), signal, observer, { restored: { run, conversation }, steering, rememberConversation, executionMode, models, subagents, skills });
			});
		},
		async cancel(taskId) {
			const running = active.get(taskId);
			if (!running) return;
			running.controller.abort();
			await subagents.stopTask(running.conversationId, taskId);
		},
		pause(taskId) {
			active.get(taskId)?.controller.abort(pauseRun);
		},
		dispose() {
			disposed = true;
			for (const { controller } of active.values()) controller.abort(pauseRun);
			closeSideChats.forEach((close) => close());
			subagents.dispose();
			void shellJobs?.dispose();
		},
	};
}
