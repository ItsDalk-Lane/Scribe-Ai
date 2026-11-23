import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { FileSystemAdapter } from 'obsidian';
import { MAX_REVIEW_MATERIAL_BYTES } from '../constants';
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { canResumeRun, ResumeThinkingUnavailable } from '../orchestration/runResume';
import { composerShortcut } from './composerKeyboard';
import { manualConversationSummary } from '../orchestration/context/manualConversationSummary';
import { confirmAction } from './ConfirmModal';
import { approvedPlanRequest, submittedPlan } from './chatPlan';
import { goalRoundInstruction, validGoalRef } from './chatGoal';
import BackgroundShellJobs from './components/BackgroundShellJobs';
import ChatGoalStatus from './components/ChatGoalStatus';
import ChatPlanCard from './components/ChatPlanCard';
import { ActivityMetric, ContextMetric, UsagePopover, useChatMetrics } from './components/ChatMetrics';
import ChatNavigation, { ConversationList } from './components/ChatNavigation';
import type { HistoryTrigger } from './components/ChatNavigation';
import ExecutionView from './components/ExecutionView';
import { MetricPopoverProvider } from './components/MetricPopover';
import QueuedMessages from './components/QueuedMessages';
import SubagentRequests from './components/SubagentRequests';
import type { ChatRequestContent, ParentPrompt } from './components/SubagentRequests';
import SubagentsPanel, { subagentIsActive, renderSubagentsActivity } from './components/SubagentsPanel';
import type { InspectSubagent } from './components/SubagentsPanel';
import TaskInput from './components/TaskInput';
import { prepareSkillMentions, sliceSkillMentions } from './components/skillMentionText';
import type { SkillDraft } from './components/skillMentionText';
import { openSideChat, SideChatHandoffError } from './SideChatView';
import { emptyExecution, restoreExecution, updateExecution } from './context';
import type { DisplayedRun } from './context';
import { thinkingLabel, uiText } from './uiText';
import { useChatModel } from './useChatModel';
import { useMessageQueue } from './useMessageQueue';
import { chooseSlashAgent, chooseSlashMcp, exportSlash, getSlashTargets, openSlashSettings, reviewChanges,
	showSlashDiff, showSlashSummary, showSlashWarnings, slashNoteChanges } from './slashActions';
import { parseSlashCommand, readSlashDraft, slashCommandAcceptsArgs, slashGoalActions } from './slashCommands';
import type { SlashCommand, SlashCommandName, SlashSubcommand } from './slashCommands';
import type { SlashUi } from './slashUi';
import { readPresets, showSlashPresets } from './slashPresets';
import { tr } from './skills/dialog';
import { useChatGoal } from './useChatGoal';
import type { ChatTabActivity } from './ChatTabs';
import type ScribeAiPlugin from '../main';
import { MissingConversationError } from '../types';
import type { AutoReviewDenial, ConversationSnapshot, ConversationSummary, ExecutionMode, NoteRef, QueuedMessage, RunObserver,
	RunEvent, RunState, SavedRun, SkillMention, SubagentSnapshot, TaskRequest, TaskTarget } from '../types';

interface ActiveSubmission {
	executionMode: ExecutionMode;
	taskId?: string;
	queuedId?: string;
	stopped?: boolean;
	goal?: true;
	settled: Promise<void>;
}

const noSubagents: SubagentSnapshot = { agents: [], requests: [] };

interface EditDraft {
	taskId: string;
	original: ComposerDraft;
}

interface ComposerDraft extends SkillDraft {
	target?: TaskTarget;
	refs: NoteRef[];
	quotes: string[];
	skillScope?: string[];
}

function draftRequest(draft: ComposerDraft, conversationId: string, intent?: TaskRequest['intent']): TaskRequest {
	return {
		conversationId,
		instruction: draft.instruction,
		...(intent && { intent }),
		...(!intent && draft.target && { target: draft.target }),
		refs: draft.refs,
		skillScope: draft.skillScope,
		...(draft.skillMentions?.length ? { skillMentions: draft.skillMentions } : {}),
		...(draft.quotes.length ? { chatQuotes: draft.quotes } : {}),
	};
}

function vaultRefs(refs: NoteRef[]): NoteRef[] {
	return refs.filter(({ path }) => !isAbsolute(path));
}

interface ChatPaneProps {
	plugin: ScribeAiPlugin;
	historyTrigger: HistoryTrigger;
	conversation: ConversationSnapshot;
	mode: ExecutionMode;
	onModeChange: (mode: ExecutionMode) => void;
	selected: boolean;
	open: boolean;
	conversations: ConversationSummary[];
	initialError: string;
	initialDraft?: SkillDraft;
	onNew: (title?: string) => void;
	onArchive: (id: string, archived: boolean) => Promise<void>;
	onOpen: (id: string) => Promise<void>;
	onRename: (id: string, title: string) => Promise<boolean>;
	onDelete: (id: string) => Promise<void>;
	onRefresh: () => Promise<void>;
	onFork: (conversation: ConversationSnapshot) => void;
	onActivity: (id: string, activity: ChatTabActivity) => void;
}

export default function App({ plugin, historyTrigger, conversation, mode, onModeChange, selected, open, conversations, initialError, initialDraft,
	onNew, onArchive, onOpen, onRename, onDelete, onRefresh, onFork, onActivity }: ChatPaneProps) {
	const text = uiText();
	const services = plugin.services;
	const sessions = services.orchestration.sessions;
	const conversationId = conversation.id;
	const subagents = sessions.subagents;
	const subscribeSlashTargets = useCallback((listener: () => void) => services.tools.mcp?.subscribe(listener), [services]);
	const chatModel = useChatModel(plugin, conversation.runs.at(-1)?.model, true);
	const [refs, setRefs] = useState(() => vaultRefs(conversation.runs.at(-1)?.request.refs ?? []));
	const [quotes, setQuotes] = useState<string[]>([]);
	const [history, setHistory] = useState<DisplayedRun[]>(conversation.runs);
	const [instruction, setInstruction] = useState(initialDraft?.instruction ?? '');
	const [skillMentions, setSkillMentions] = useState<SkillMention[]>(initialDraft?.skillMentions ?? []);
	const [skillScope, setSkillScope] = useState(initialDraft?.skillScope);
	const [target, setTarget] = useState<TaskTarget>();
	const [execution, setExecution] = useState(emptyExecution);
	const [liveRequest, setLiveRequest] = useState<TaskRequest>();
	const [liveModel, setLiveModel] = useState<SavedRun['model']>();
	const [editing, setEditing] = useState<EditDraft>();
	const [parentPrompt, setParentPrompt] = useState<ParentPrompt>();
	const [error, setError] = useState(initialError);
	const [busy, setBusy] = useState(false);
	const [composerMode, setComposerMode] = useState<'plan' | 'goal'>();
	const planned = composerMode === 'plan';
	const [loading, setLoading] = useState(false);
	const [managingHistory, setManagingHistory] = useState(false);
	const queue = useMessageQueue(services.orchestration.conversations, () => setError(text.queueSendFailed), conversation.queue);
	const active = useRef<ActiveSubmission | null>(null);
	const pending = useRef<ParentPrompt>(undefined);
	const nextPrompt = useRef(0);
	const mounted = useRef(false);
	const navigating = useRef(false);
	const visible = useRef(selected);
	const openingSideChat = useRef(false);
	const auxiliary = useRef<AbortController>(null);
	const denials = useRef<AutoReviewDenial[]>([]);
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (initialDraft) input.current?.focus({ preventScroll: true });
	}, [initialDraft]);
	const lastRun = history.at(-1);
	const resumable = canResumeRun(lastRun) ? lastRun : undefined;
	const liveTaskId = execution.state?.taskId;
	const editIndex = editing ? history.findIndex(({ state }) => state.taskId === editing.taskId) : -1;
	const metricHistory = useMemo(() => editIndex < 0 ? history : history.slice(0, editIndex), [history, editIndex]);
	const subscribeAgents = useCallback((changed: () => void) =>
		subagents?.subscribe(conversationId, changed) ?? (() => {}), [conversationId, subagents]);
	const getAgents = useCallback(() => subagents?.snapshot(conversationId) ?? noSubagents, [conversationId, subagents]);
	const agentSnapshot = useSyncExternalStore(subscribeAgents, getAgents);
	const hasActiveAgents = agentSnapshot.agents.some(subagentIsActive);
	const agentRuns = useMemo(() => agentSnapshot.agents.flatMap(({ runs }) => runs), [agentSnapshot.agents]);
	const subagentNames = useMemo(() => new Map(agentSnapshot.agents.map(({ id, name }) => [id, name])), [agentSnapshot.agents]);
	const metrics = useChatMetrics(metricHistory, execution.state, agentRuns);
	const childPrompt = agentSnapshot.requests.reduce<SubagentSnapshot['requests'][number] | undefined>((first, item) =>
		!first || item.createdAt < first.createdAt ? item : first, undefined);
	const displayedPrompt = childPrompt && (!parentPrompt || childPrompt.createdAt < parentPrompt.createdAt) ? {
		...childPrompt,
		source: { id: childPrompt.agentId, name: agentSnapshot.agents.find(({ id }) => id === childPrompt.agentId)?.name ?? childPrompt.agentId },
		respond: (accepted: boolean) => subagents?.respond(conversationId, childPrompt.id, accepted),
	} : parentPrompt;
	const visibleHistory = useMemo(() => {
		const visible = editIndex < 0 ? history : liveTaskId ? history.slice(0, editIndex) : history.slice(0, editIndex + 1);
		return visible.filter((run) => run.state.taskId !== liveTaskId);
	}, [history, liveTaskId, editIndex]);
	const receivedSubmissions = useMemo(() => new Set([
		...visibleHistory.map(({ state }) => state.messages), ...agentRuns.map(({ state }) => state.messages), execution.state?.messages ?? [],
	].flatMap((messages) => messages.flatMap(({ subagentActivity }) => subagentActivity?.kind === 'result' ? [subagentActivity.id] : []))),
	[visibleHistory, agentRuns, execution.state?.messages]);
	const landing = !loading && !history.length && !execution.state && !queue.rows.length;
	const referenceShape = (refs: NoteRef[]) => JSON.stringify(refs.map(({ path, kind, lines }) => [path, kind, lines]));
	const expectedRefs = vaultRefs((liveTaskId ? liveRequest : lastRun?.request)?.refs ?? []);
	const dirty = Boolean(instruction.trim() || target || quotes.length || referenceShape(refs) !== referenceShape(expectedRefs));

	const tabStatus = displayedPrompt || execution.modelRetry === 'manual' ? 'attention'
		: busy || hasActiveAgents ? 'running' : (execution.state ?? lastRun?.state)?.status === 'failed' ? 'error' : undefined;
	const tabHasDraft = dirty || Boolean(composerMode) || Boolean(editing) || Boolean(queue.rows.length);
	const goal = useChatGoal({
		app: services.app, store: services.orchestration.conversations, conversationId, isOpen: open,
		canContinue: open && !busy && !loading && !managingHistory && !editing && !instruction.trim() && !target
			&& !queue.rows.length && !hasActiveAgents && !chatModel.saving && !chatModel.selecting && Boolean(chatModel.choice) && !composerMode,
		start: (value) => perform(undefined, undefined, undefined, {
			goal: true, request: { conversationId, instruction: value.objective, refs: value.refs ?? [], chatQuotes: value.chatQuotes,
				skillMentions: value.skillMentions, skillScope: value.skillScope, goalRound: true, goalContext: goalRoundInstruction(value) },
		}),
		stopRunning: () => { if (active.current?.goal) stop(); },
		onDefinitionChange: () => { void refreshConversations(); },
	});
	const tabTitle = (history[0]?.request.instruction ?? liveRequest?.instruction ?? goal.value?.objective)?.replace(/\s+/gu, ' ').trim().slice(0, 120);
	const plan = useMemo(() => submittedPlan(lastRun), [lastRun]);
	const eligiblePlan = planned && selected && open && !busy && !loading && !managingHistory && !editing && !instruction.trim()
		&& !queue.rows.length && !hasActiveAgents && !chatModel.saving && !chatModel.selecting && Boolean(chatModel.choice) && goal.ready ? plan : undefined;
	const planToConfirm = useRef(eligiblePlan);
	useLayoutEffect(() => {
		planToConfirm.current = eligiblePlan;
	}, [eligiblePlan]);
	useLayoutEffect(() => {
		onActivity(conversationId, { status: tabStatus, title: tabTitle, hasDraft: tabHasDraft });
	}, [conversationId, onActivity, tabStatus, tabTitle, tabHasDraft]);
	useLayoutEffect(() => {
		visible.current = selected;
	}, [selected]);

	useEffect(() => {
		let cancelled = false;
		void subagents?.load(conversationId).catch((cause: unknown) => {
			if (!cancelled) setError(cause instanceof Error ? cause.message : text.chatHistoryError);
		});
		return () => { cancelled = true; };
	}, [conversationId, subagents, text.chatHistoryError]);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			auxiliary.current?.abort();
			const submission = active.current;
			active.current = null;
			if (submission?.taskId) sessions.pause(submission.taskId);
			pending.current?.respond(false);
		};
	}, [sessions]);
	useEffect(() => { if (!open) auxiliary.current?.abort(); }, [open]);

	async function switchConversation(id: string) {
		setError('');
		try {
			await onOpen(id);
		} catch (cause) {
			if (mounted.current && !(cause instanceof MissingConversationError)) setError(text.chatHistoryError);
		}
	}

	async function refreshConversations() {
		try {
			await onRefresh();
			if (mounted.current) setError((previous) => previous === text.chatHistoryError ? '' : previous);
		} catch {
			if (mounted.current) setError(text.chatHistoryError);
		}
	}

	function changeExecutionMode(next: ExecutionMode, trigger: HTMLButtonElement) {
		const available = () => mounted.current && visible.current && trigger.isConnected && !trigger.disabled
			&& !active.current && !navigating.current && !queue.rows.length && !getAgents().agents.some(subagentIsActive);
		if (!available()) return;
		if (next !== 'full-access') {
			onModeChange(next);
			return;
		}
		confirmAction(services.app, {
			title: text.chatModeFullAccessConfirm,
			message: text.chatModeFullAccessDisclosure,
			confirmText: text.chatModeFullAccessConfirm,
			cancelText: text.cancel,
			onConfirm: () => { if (available()) onModeChange(next); },
			onClose: () => trigger.ownerDocument.defaultView?.requestAnimationFrame(() => {
				if (available()) trigger.focus({ preventScroll: true });
			}),
		});
	}

	async function manageConversation(id: string, title?: string): Promise<boolean> {
		if (navigating.current) return false;
		navigating.current = true;
		setManagingHistory(true);
		setError('');
		try {
			if (title !== undefined) return await onRename(id, title);
			await onDelete(id);
			return true;
		} catch {
			if (mounted.current) setError(title === undefined ? text.chatDeleteError : text.chatRenameError);
			return false;
		} finally {
			navigating.current = false;
			if (mounted.current) setManagingHistory(false);
		}
	}

	function confirmDeleteConversation(conversation: ConversationSummary, trigger: HTMLButtonElement) {
		if (navigating.current) return;
		confirmAction(services.app, {
			title: text.chatDeleteConversation,
			message: text.chatDeleteConfirm.replace('{title}', () => conversation.title || text.chatUntitled),
			confirmText: text.chatDeleteConversation,
			cancelText: text.cancel,
			onConfirm: async () => { if (mounted.current) await manageConversation(conversation.id); },
			onClose: restoreHistoryFocus(trigger),
		});
	}

	function restoreHistoryFocus(trigger: HTMLButtonElement) {
		const historyPanel = trigger.closest<HTMLElement>('.scribe-history-panel');
		return () => trigger.ownerDocument.defaultView?.requestAnimationFrame(() => {
			if (!mounted.current || !visible.current) return;
			const target = trigger.isConnected && !trigger.disabled ? trigger
				: historyPanel ? (historyPanel.isConnected ? historyPanel : historyTrigger.button) : input.current;
			target?.focus({ preventScroll: true });
		});
	}

	function confirmArchiveConversation(conversation: ConversationSummary, trigger: HTMLButtonElement) {
		if (navigating.current) return;
		const archive = !conversation.archived;
		const action = archive ? text.chatArchiveConversation : text.chatUnarchiveConversation;
		confirmAction(services.app, {
			title: action,
			message: conversation.title || text.chatUntitled,
			confirmText: action,
			cancelText: text.cancel,
			onConfirm: async () => {
				if (!mounted.current || navigating.current) return;
				navigating.current = true;
				setManagingHistory(true);
				setError('');
				try {
					await onArchive(conversation.id, archive);
				} catch (cause) {
					if (mounted.current) setError(cause instanceof Error ? cause.message : text.chatArchiveError);
				} finally {
					navigating.current = false;
					if (mounted.current) setManagingHistory(false);
				}
			},
			onClose: restoreHistoryFocus(trigger),
		});
	}

	function editTurn(taskId: string) {
		if (active.current || navigating.current || getAgents().agents.some(subagentIsActive)) return;
		if (editing?.taskId === taskId) {
			setInstruction(editing.original.instruction);
			setSkillMentions(editing.original.skillMentions ?? []);
			setSkillScope(editing.original.skillScope);
			setTarget(editing.original.target);
			setRefs(editing.original.refs);
			setQuotes(editing.original.quotes);
			setEditing(undefined);
		} else {
			const request = history.find(({ state }) => state.taskId === taskId)?.request;
			if (!request || request.selection || request.intent === 'review') return;
			setEditing({ taskId, original: editing?.original ?? { instruction, refs, quotes, skillMentions, skillScope, target } });
			setInstruction(request.instruction);
			setSkillMentions(request.skillMentions ?? []);
			setSkillScope(request.skillScope);
			setTarget(request.target);
			setRefs(request.refs);
			setQuotes(request.chatQuotes ?? []);
			setExecution(emptyExecution);
			setLiveRequest(undefined);
		}
		setError('');
		input.current?.focus({ preventScroll: true });
	}

	async function forkTurn(taskId: string) {
		if (active.current || auxiliary.current || navigating.current) return false;
		navigating.current = true;
		setLoading(true);
		setError('');
		let errorMessage = text.chatForkFailed;
		try {
			const branch = await sessions.forkConversation(conversationId, taskId, false);
			errorMessage = text.chatHistoryError;
			if (mounted.current) onFork(branch);
			await onRefresh();
			return true;
		} catch {
			if (mounted.current) setError(errorMessage);
			return false;
		} finally {
			navigating.current = false;
			if (mounted.current) setLoading(false);
		}
	}

	function clearDraft(draft: ComposerDraft, keepVaultRefs = false) {
		setTarget((current) => current === draft.target ? undefined : current);
		setInstruction((previous) => previous === draft.instruction ? '' : previous);
		setSkillMentions((previous) => previous === skillMentions || previous === draft.skillMentions ? [] : previous);
		setSkillScope(undefined);
		setRefs((previous) => previous === draft.refs ? keepVaultRefs ? vaultRefs(previous) : [] : previous);
		setQuotes((previous) => previous === draft.quotes ? [] : previous);
	}

	async function askSideChat(request: TaskRequest, prompt = request.instruction) {
		if (request.selection) throw new SideChatHandoffError(text.queueSelectionUnavailable);
		if (request.target) throw new SideChatHandoffError(tr('这条任务已指定服务或子 Agent，请在主聊天中发送。', 'Send this targeted task in the main chat.'));
		if (navigating.current) throw new SideChatHandoffError(text.sideChatOpenFailed);
		if (openingSideChat.current) throw new SideChatHandoffError(text.sideChatBusy);
		if (request.refs.some(({ path, kind }) => isAbsolute(path) && kind !== 'file')) {
			throw new SideChatHandoffError(text.sideChatExternalFolder);
		}
		openingSideChat.current = true;
		const parentRuns: SavedRun[] = [...visibleHistory];
		const state = execution.state;
		if (state && liveRequest && liveModel) {
			const inProgress = state.status === 'idle' || state.status === 'running' || state.status === 'awaiting-approval';
			const partial = inProgress ? execution.items.flatMap((item) =>
				item.kind === 'text' && item.draft && !item.abandoned ? [item.content] : []).join('') : undefined;
			parentRuns.push({ request: liveRequest, model: liveModel, partial, state });
		}
		try {
			const start = prompt === request.instruction ? 0 : Math.max(0, request.instruction.trimEnd().length - prompt.length);
			await openSideChat(plugin, conversationId, parentRuns, {
				prompt,
				skillScope: request.skillScope,
				skillMentions: sliceSkillMentions(request, start, start + prompt.length),
				refs: request.refs.map((ref) => isAbsolute(ref.path) ? { ...ref, addedExternal: true } : ref),
				quotes: request.chatQuotes ?? [],
			}, chatModel.choice);
		} catch (cause) {
			if (cause instanceof SideChatHandoffError) throw cause;
			throw new SideChatHandoffError(text.sideChatOpenFailed);
		} finally {
			openingSideChat.current = false;
		}
	}

	async function askSideChatQuote(quote: string) {
		try {
			await askSideChat({ conversationId, instruction: '', refs: [], chatQuotes: [quote] }, '');
			if (mounted.current) setError('');
		} catch (cause) {
			if (mounted.current) setError(cause instanceof SideChatHandoffError ? cause.message : text.sideChatOpenFailed);
		}
	}

	async function changeModel(value: string, effort?: string): Promise<boolean> {
		if (active.current || navigating.current || chatModel.isSaving()) return false;
		setError('');
		try {
			await chatModel.selectModel(value, effort);
			return true;
		} catch {
			if (mounted.current) setError(text.saveFailed);
			return false;
		}
	}

	async function changeThinking(level: string) {
		if (active.current || navigating.current) return;
		setError('');
		try {
			await chatModel.selectThinking(level);
		} catch {
			if (mounted.current) setError(text.saveFailed);
		}
	}

	function requestParent(submission: ActiveSubmission, details: ChatRequestContent, signal: AbortSignal): Promise<boolean> {
		if (signal.aborted || active.current !== submission || pending.current) return Promise.resolve(false);
		return new Promise((resolve) => {
			const respond = (allow: boolean) => {
				if (pending.current?.respond !== respond) return;
				signal.removeEventListener('abort', onAbort);
				pending.current = undefined;
				if (active.current === submission) setParentPrompt(undefined);
				resolve(allow && !signal.aborted);
			};
			const onAbort = () => respond(false);
			const request = { ...details, respond, id: `main-${++nextPrompt.current}`, createdAt: Date.now() };
			pending.current = request;
			signal.addEventListener('abort', onAbort, { once: true });
			setParentPrompt(request);
		});
	}

	const openAgent = useCallback<InspectSubagent>((id) => plugin.openSubagent(conversationId, id), [plugin, conversationId]);

	async function perform(draft?: ComposerDraft, resume?: DisplayedRun, queued?: QueuedMessage,
		command?: { request: TaskRequest; goal?: true }): Promise<RunState | undefined> {
		if (active.current || auxiliary.current || navigating.current || chatModel.isSaving()) return;
		if (planned && ((resume && !resume.request.intent) || (queued && !queued.request.intent) || command?.goal)) return;
		const choice = chatModel.choice;
		if (!choice) {
			setError(text.chatModelMissing);
			if (queued) queue.pause();
			return;
		}
		if (!chatModel.refreshSelection()) {
			setError(text.chatModelChanged);
			if (queued) queue.pause();
			return;
		}
		let settle = () => {};
		const settled = new Promise<void>((resolve) => { settle = resolve; });
		const submission: ActiveSubmission = { queuedId: queued?.id, executionMode: mode, goal: command?.goal, settled };
		active.current = submission;
		setBusy(true);
		setError('');
		if (!queued && !queue.rows.length && queue.paused) queue.resume(Promise.resolve(conversationId));
		const replaceFrom = draft ? editing?.taskId : undefined;
		let appliedEdit = false;
		let displayed = resume ? restoreExecution(resume) : emptyExecution;
		const onEvent = (event: RunEvent) => {
			if (active.current !== submission) return;
			displayed = updateExecution(displayed, event);
			setExecution(displayed);
			if (draft && replaceFrom && !appliedEdit && event.type === 'state' && event.state.messages.some(({ role }) => role === 'user')) {
				appliedEdit = true;
				clearDraft(draft, true);
			}
		};
		try {
			const working = new Set<string>();
			const observer: RunObserver = {
				onEvent,
				onWork: submission.goal ? (id, isWorking) => {
					if (active.current !== submission || submission.stopped) return;
					if (isWorking) working.add(id);
					else working.delete(id);
					goal.setWorkActive(working.size > 0);
				} : undefined,
				onAutoReviewDenied: (denial) => {
					if (active.current === submission) denials.current = [...denials.current.slice(-9), denial];
				},
				approve: (approval, signal) => requestParent(submission, { kind: 'approval', approval }, signal),
				retryConnection: async (signal) => {
					if (!await requestParent(submission, { kind: 'retry' }, signal)) throw new Error(text.chatStopped);
				},
				confirmResume: (preview, signal) => requestParent(submission, { kind: 'send', preview }, signal),
			};
			setExecution(displayed);
			const editIntent = replaceFrom ? history.find(({ state }) => state.taskId === replaceFrom)?.request.intent : undefined;
			const request = resume?.request ?? queued?.request ?? command?.request ??
				(draft && draftRequest(draft, conversationId, planned ? 'plan' : editIntent));
			if (!request) return;
			const options = { model: choice, rememberConversation: false, executionMode: submission.executionMode };
			const run = resume ? sessions.resume(conversationId, resume.state.taskId, observer, options)
				: queued ? sessions.submitQueued(queued, observer, () => { if (active.current === submission) queue.remove(queued.id); }, options)
					: sessions.submit(request, observer, replaceFrom, options);
			submission.taskId = run.taskId;
			setLiveRequest(request);
			setLiveModel(resume?.model ?? choice);
			if (draft && !replaceFrom) clearDraft(draft, true);
			const result = await run.result;
			onEvent({ type: 'state', state: result });
			if (active.current !== submission) return;
			if (replaceFrom) {
				setHistory((previous) => previous.slice(0, editIndex));
				setEditing(undefined);
			}
			const [index, current] = await Promise.allSettled([onRefresh(), services.orchestration.conversations.load(conversationId)]);
			if (active.current !== submission) return;
			if (current.status === 'fulfilled' && current.value.runs.some(({ state }) => state.taskId === run.taskId)) {
				const runs = current.value.runs;
				const latest = displayed;
				setHistory((previous) => {
					const byId = new Map(previous.map((saved) => [saved.state.taskId, saved]));
					return runs.map((saved) => saved.state.taskId === run.taskId && latest.state
						? { ...saved, state: latest.state, displayed: latest } : byId.get(saved.state.taskId) ?? saved);
				});
				setExecution(emptyExecution);
				setLiveRequest(undefined);
				setLiveModel(undefined);
			}
			if (index.status === 'rejected' || current.status === 'rejected') setError(text.chatHistoryError);
			return result;
		} catch (cause) {
			if (active.current === submission) {
				if (resume || replaceFrom || queued) {
					setExecution(emptyExecution);
					setLiveRequest(undefined);
					setLiveModel(undefined);
				}
				if (queued) queue.pause();
				if (!submission.stopped) {
					setError(queued ? [text.queueStartFailed, cause instanceof Error ? cause.message : ''].filter(Boolean).join(' ') : cause instanceof ResumeThinkingUnavailable
						? text.chatResumeThinkingUnavailable.replace('{level}', () => thinkingLabel(text, cause.level))
						: cause instanceof Error ? cause.message : text.chatFailed);
				}
			}
			return undefined;
		} finally {
			if (active.current === submission) {
				if (submission.goal) goal.setWorkActive(false);
				pending.current?.respond(false);
				active.current = null;
				setBusy(false);
			}
			settle();
		}
	}

	function stop() {
		if (auxiliary.current) { auxiliary.current.abort(); return; }
		const submission = active.current;
		if (!submission) return;
		queue.pause();
		submission.stopped = true;
		if (submission.goal) goal.setWorkActive(false);
		if (submission.taskId) {
			void sessions.cancel(submission.taskId).catch((cause: unknown) => {
				if (active.current === submission) setError(cause instanceof Error ? cause.message : text.chatFailed);
			});
		}
	}

	function addRef(ref: NoteRef) {
		if (navigating.current) return;
		setSkillScope(undefined);
		setRefs((previous) => previous.some((existing) => existing.path === ref.path)
			? previous.map((existing) => existing.path === ref.path ? ref : existing)
			: [...previous, ref]);
	}

	function addQuote(quote: string) {
		if (navigating.current) return;
		setQuotes((previous) => previous.includes(quote) ? previous : [...previous, quote]);
		input.current?.focus({ preventScroll: true });
	}

	async function sendSideCommand(draft: ComposerDraft, prompt: string) {
		try {
			await askSideChat(draftRequest(draft, conversationId), prompt);
			if (mounted.current) {
				setRefs((previous) => previous === draft.refs ? [] : previous);
				setQuotes((previous) => previous === draft.quotes ? [] : previous);
				setError('');
			}
			return true;
		} catch (cause) {
			throw cause instanceof SideChatHandoffError ? cause : new Error(text.sideChatOpenFailed);
		}
	}

	async function createGoal(draft: ComposerDraft) {
		if (!chatModel.choice) throw new Error(text.chatModelMissing);
		if (draft.target) throw new Error(tr('请先移除已选的服务或子 Agent。', 'Remove the selected service or subagent first.'));
		if (!draft.refs.every(validGoalRef)) throw new Error(tr('目标只支持添加库内资料，请移除库外文件。', 'Remove external files before starting the goal.'));
		const objective = draft.instruction.trim();
		const start = draft.instruction.length - draft.instruction.trimStart().length;
		const created = await goal.create(objective, {
			refs: draft.refs, chatQuotes: draft.quotes, skillScope: draft.skillScope,
			skillMentions: sliceSkillMentions(draft, start, start + objective.length),
		});
		if (created && mounted.current) setComposerMode(undefined);
		return created;
	}

	async function submitDraft(value: string, mentions: SkillMention[], scope: string[]) {
		if (navigating.current) return;
		const draft = { instruction: value, refs, quotes, skillMentions: mentions, skillScope: scope, target };
		if (value.trim()) {
			if (composerMode === 'goal') {
				if (await createGoal(draft) && mounted.current) clearDraft(draft, true);
				return;
			}
			const current = active.current;
			if (current) {
				const request = draftRequest(draft, conversationId, planned ? 'plan' : undefined);
				request.skillNotePaths = services.orchestration.skills.notePaths(refs);
				queue.add(request, Promise.resolve(conversationId));
				clearDraft(draft);
				setError('');
			} else {
				void perform(draft);
			}
		}
	}

	function slashUnavailable(name: SlashCommandName, args: string): string | undefined {
		if (!selected || navigating.current) return text.chatLoadingHistory;
		const goalAction = name === 'goal' && slashGoalActions.some((action) => action === args.toLowerCase());
		const switchingDuringWork = (name === 'plan' || (name === 'goal' && !goalAction)) && busy && !active.current?.goal;
		if (switchingDuringWork || (busy && ['clear', 'review', 'compact', 'recap', 'approve', 'presets', 'export'].includes(name))) {
			return tr('当前任务结束后可用。', 'Available after the current task finishes.');
		}
		if (editing && ['plan', 'review', 'compact', 'recap', 'goal'].includes(name)) {
			return tr('请先完成或退出消息编辑。', 'Finish or cancel editing this message first.');
		}
		if (['review', 'compact', 'recap'].includes(name) || (name === 'plan' && args)) {
			if (!chatModel.choice) return text.chatModelMissing;
			if (chatModel.isSaving()) return tr('正在保存模型选择。', 'The model selection is being saved.');
		}
		if (composerMode && (name === 'mcp' || name === 'agents')) return tr('请先关闭计划或目标标签。', 'Close the Plan or Goal label first.');
		if ((name === 'plan' || (name === 'goal' && !goalAction)) && target) {
			return tr('请先移除已选的服务或子 Agent。', 'Remove the selected service or subagent first.');
		}
		if (name === 'approve' && (mode !== 'auto-review' || planned || !denials.current.length)) {
			return tr('没有可重试的自动审核操作。', 'There is no denied auto-review action to retry.');
		}
		if (name === 'goal' && (args.toLowerCase() === 'resume' || args && !goalAction)) {
			if (!chatModel.choice) return text.chatModelMissing;
		}
		if (name === 'goal' && args.toLowerCase() === 'resume' && composerMode) {
			return tr('请先关闭计划或目标标签。', 'Close the Plan or Goal label first.');
		}
		if ((name === 'goal' || name === 'plan') && !goal.ready) return goal.error || text.chatLoadingHistory;
		return undefined;
	}

	function confirmPlan() {
		if (!plan || !mounted.current || !visible.current || planToConfirm.current !== plan
			|| active.current || auxiliary.current || navigating.current) return;
		planToConfirm.current = undefined;
		setComposerMode(undefined);
		void perform(undefined, undefined, undefined, { request: approvedPlanRequest(plan) });
	}

	function slashDraft(command: SlashCommand, inputText = instruction): ComposerDraft {
		const { args, argsStart } = command;
		const fromInput = inputText === instruction;
		return {
			instruction: args, refs, quotes, skillScope,
			skillMentions: fromInput ? sliceSkillMentions({ instruction, skillMentions }, argsStart, argsStart + args.length) : [],
		};
	}

	async function runAuxiliary<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (auxiliary.current || active.current) throw new Error(tr('当前任务正在运行。', 'A task is already running.'));
		const controller = new AbortController();
		auxiliary.current = controller;
		setBusy(true);
		try {
			return await work(controller.signal);
		} finally {
			if (auxiliary.current === controller) {
				auxiliary.current = null;
				if (mounted.current) setBusy(false);
			}
		}
	}

	const app = services.app;
	const currentTitle = conversations.find(({ id }) => id === conversationId)?.title || tabTitle || text.chatUntitled;
	const noteChanges = () => slashNoteChanges([...visibleHistory, ...agentRuns], execution.state);
	const reviewablePath = (path: string) => !path.startsWith(`${app.vault.configDir}/`) && !isAbsolute(path);

	function reviewTargets(hasChanges: boolean) {
		const current = app.workspace.getActiveFile();
		return [
			...(hasChanges ? [{ kind: 'changes' as const, id: 'changes', label: tr('本次聊天的改动', 'Changes in this chat'),
				searchLabel: tr('审查本次聊天的改动', 'Review changes in this chat'), keywords: ['review-changes', tr('改动', 'Changes')] }] : []),
			...(current?.extension === 'md' && reviewablePath(current.path) ? [{ kind: 'file' as const,
				id: `file:${current.path}`, label: current.path, file: current,
				searchLabel: tr('审查当前笔记', 'Review current note'), keywords: ['review-current-note', current.basename, current.path] }] : []),
			{ kind: 'pick' as const, id: 'pick', label: tr('选择笔记', 'Choose a note'),
				searchLabel: tr('审查其他笔记', 'Review another note'), keywords: ['review-note', tr('选择笔记', 'Choose a note')] },
		];
	}

	function approvalLabel({ approval }: AutoReviewDenial) {
		return [approval.title, approval.target].filter(Boolean).join(' · ');
	}

	function getSlashSubcommands(): SlashSubcommand[] {
		const hasChanges = execution.state?.messages.some(({ noteChange }) => noteChange)
			|| visibleHistory.some(({ state }) => state.messages.some(({ noteChange }) => noteChange))
			|| agentRuns.some(({ state }) => state.messages.some(({ noteChange }) => noteChange));
		const rows: SlashSubcommand[] = reviewTargets(hasChanges).map(({ id, label, searchLabel, keywords }) => ({
			name: 'review', subcommand: id, label: searchLabel, keywords: [label, ...keywords],
		}));
		if (mode === 'auto-review' && !planned) {
			for (const denial of [...denials.current].reverse()) {
				const { id, approval } = denial;
				rows.push({ name: 'approve', subcommand: id, label: approvalLabel(denial),
					keywords: ['approve', tr('批准', 'Approve'), approval.title, approval.target ?? ''] });
			}
		}
		return rows;
	}

	async function reviewNotes(args: string, controls: CommandUi, subcommand?: string) {
		const changed = noteChanges();
		const inline = args.trim();
		const targets = reviewTargets(changed.length > 0);
		const target = subcommand ? targets.find(({ id }) => id === subcommand)
			: inline && changed.length ? targets[0]
				: await controls.ui.choose(tr('选择要检查的内容', 'Choose what to review'), targets, ({ label }) => label);
		if (!target) return false;
		const file = target.kind === 'file' ? target.file : target.kind === 'pick' ? await controls.ui.choose(target.label,
			app.vault.getMarkdownFiles().filter(({ path }) => reviewablePath(path)), ({ path }) => path) : undefined;
		if (target.kind !== 'changes' && !file) return false;
		if (file) {
			const root = await realpath((app.vault.adapter as FileSystemAdapter).getBasePath());
			const expected = resolve(root, file.path);
			if (await realpath(expected) !== expected || file.stat.size > MAX_REVIEW_MATERIAL_BYTES) {
				throw new Error(tr('请选择库内的普通 Markdown 笔记。', 'Choose a regular Markdown note within the vault.'));
			}
		}
		const material = target.kind === 'changes' ? reviewChanges(changed) : `${file!.path}\n\n${await app.vault.cachedRead(file!)}`;
		if (new TextEncoder().encode(material).length > MAX_REVIEW_MATERIAL_BYTES) throw new Error(tr(
			'检查内容过长，请选择较短的笔记。', 'The review material is too long. Choose a shorter note.'));
		const title = file?.path ?? target.label;
		const send = await controls.ui.confirm(tr('检查笔记', 'Review notes'), tr(
			`检查对象：${title}。内容会发给模型：${chatModel.choice?.model ?? ''}。`,
			`Review ${title} with ${chatModel.choice?.model ?? ''}. Its content will be sent to the model.`), tr('开始检查', 'Start review'));
		if (!send || !mounted.current || !visible.current) return false;
		void perform(undefined, undefined, undefined, {
			request: { conversationId, instruction: inline || tr(`检查 ${title}`, `Review ${title}`), refs: [], intent: 'review', reviewMaterial: material },
		});
		return true;
	}

	type CommandUi = {
		openSkills: () => Promise<boolean>;
		ui: SlashUi;
	};
	async function runSlash(command: SlashCommand, controls: CommandUi, inputText = instruction): Promise<boolean> {
		const { name, args, subcommand } = command;
		if (args && !slashCommandAcceptsArgs(name)) throw new Error(tr('这条命令不接受额外文字。', 'This command does not accept arguments.'));
		const unavailable = slashUnavailable(name, args);
		if (unavailable) throw new Error(unavailable);
		if (name === 'clear' && args.length > 120) {
			throw new Error(tr('对话名称最多 120 个字符。', 'Chat names can be up to 120 characters.'));
		}
		switch (name) {
			case 'clear': onNew(args || undefined); return true;
			case 'skills': return controls.openSkills();
			case 'mcp':
			case 'agents': {
				const choice = await (name === 'mcp' ? chooseSlashMcp : chooseSlashAgent)(plugin, controls.ui);
				if (!choice || !mounted.current || !visible.current) return false;
				setTarget(choice);
				return true;
			}
			case 'side': {
				if (openingSideChat.current) throw new Error(text.sideChatBusy);
				const draft = slashDraft(command, inputText);
				draft.skillScope ??= services.orchestration.skills.scope(refs);
				const mentions = await prepareSkillMentions(draft, services.orchestration.skills, draft.skillScope);
				return sendSideCommand({ ...draft, skillMentions: mentions }, args);
			}
			case 'export': return exportSlash(app, visibleHistory, args, currentTitle, controls.ui);
			case 'warnings': return showSlashWarnings(plugin, controls.ui);
			case 'config': return openSlashSettings(plugin);
			case 'approve': {
				const denial = subcommand ? denials.current.find(({ id }) => id === subcommand)
					: await controls.ui.choose(tr('选择要重试的操作', 'Choose an action to retry'), [...denials.current].reverse(), approvalLabel);
				if (!denial) return false;
				if (!await controls.ui.confirm(tr('仅批准这一次重试', 'Approve one retry'),
					[denial.approval.title, denial.approval.target, denial.approval.after].filter(Boolean).join('\n'), tr('批准并重试', 'Approve and retry'))) return false;
				if (!visible.current || !denials.current.includes(denial) || slashUnavailable('approve', '')) return false;
				denials.current = denials.current.filter(({ id }) => id !== denial.id);
				const result = await runAuxiliary((signal) => denial.retry(signal));
				if (result.isError) throw new Error(result.content);
				return controls.ui.show(tr('重试结果', 'Retry result'), [result.content]);
			}
			case 'presets': {
				const result = command.presetIndex === undefined ? await showSlashPresets(app, controls.ui, tr, subcommand === 'new')
					: readPresets(app)[command.presetIndex]?.content ?? false;
				if (typeof result !== 'string') return result;
				if (!mounted.current || !visible.current) return false;
				const preset = parseSlashCommand(result);
				if (preset) {
					if (preset.name === 'presets') return false;
					return runSlash(preset, controls, result);
				}
				if (readSlashDraft(result)) throw new Error(tr('预设中的命令无法识别。', 'The preset contains an unknown command.'));
				const scope = skillScope ?? services.orchestration.skills.scope(refs);
				const mentions = await prepareSkillMentions({ instruction: result }, services.orchestration.skills, scope);
				await submitDraft(result, mentions, scope);
				return true;
			}
			case 'plan': {
				const previous = active.current;
				if (previous && !previous.goal) return false;
				if (!await goal.pause('plan') || !mounted.current || !visible.current || navigating.current) return false;
				setComposerMode('plan');
				if (args) {
					await previous?.settled;
					const draft = slashDraft(command, inputText);
					draft.skillScope ??= services.orchestration.skills.scope(refs);
					draft.skillMentions = await prepareSkillMentions(draft, services.orchestration.skills, draft.skillScope);
					if (!mounted.current || !visible.current || navigating.current || active.current) return false;
					void perform(undefined, undefined, undefined, { request: draftRequest(draft, conversationId, 'plan') });
					setQuotes([]);
					setRefs(vaultRefs(refs));
				}
				return true;
			}
			case 'goal': {
				if (slashGoalActions.some((action) => action === args.toLowerCase())) return goal.command(args, controls.ui);
				if (!args) {
					setComposerMode('goal');
					return true;
				}
				const draft = slashDraft(command, inputText);
				draft.skillScope ??= services.orchestration.skills.scope(refs);
				draft.skillMentions = await prepareSkillMentions(draft, services.orchestration.skills, draft.skillScope);
				return mounted.current && visible.current && await createGoal(draft);
			}
			case 'recap':
			case 'compact': {
				const choice = chatModel.choice;
				if (!choice) throw new Error(text.chatModelMissing);
				const summary = await runAuxiliary(async (signal) => {
					const store = services.orchestration.conversations;
					const snapshot = await store.load(conversationId);
					const output = await manualConversationSummary(snapshot, services.communication.models, choice, name, signal);
					signal.throwIfAborted();
					const boundary = snapshot.runs.filter(({ request }) => !request.selection).at(-1);
					if (name === 'compact' && boundary) await store.saveManualCompaction(conversationId, {
						throughTaskId: boundary.state.taskId, text: output,
					});
					return output;
				});
				return showSlashSummary(app, controls.ui,
					name === 'recap' ? tr('进展小结', 'Conversation recap') : tr('已整理聊天上下文', 'Chat context compacted'), summary);
			}
			case 'diff': return showSlashDiff(noteChanges(), controls.ui);
			case 'review': return reviewNotes(args, controls, subcommand);
		}
	}

	function continueQueue() {
		if (active.current || navigating.current || queue.rows.some(({ pending }) => pending)) return;
		setError('');
		queue.resume(Promise.resolve(conversationId));
	}

	const startNext = useEffectEvent((next: QueuedMessage) => {
		if (!queue.isUpdating() && !queue.sentToSide(next.id)) void perform(undefined, undefined, next);
	});
	const head = queue.rows[0];
	useEffect(() => {
		if (busy || loading || managingHistory || chatModel.saving || chatModel.selecting || queue.paused || queue.updating
			|| !head || head.pending || head.failed || head.request.selection || (planned && !head.request.intent)) return;
		startNext(head);
	}, [busy, loading, managingHistory, chatModel.saving, chatModel.selecting, queue.paused, queue.updating, head, planned]);

	function queuedMessage(id: string) {
		const message = queue.rows.find((row) => row.id === id && !row.pending && !row.failed);
		if (!message || active.current?.queuedId === id) throw new Error(text.queueMessageChanged);
		return message;
	}

	const activeTaskId = active.current?.taskId;
	const status = execution.state?.status;
	const canSteer = (!status || status === 'idle' || status === 'running' || status === 'awaiting-approval')
		&& !loading && !managingHistory && busy && Boolean(activeTaskId
		&& !liveRequest?.intent && sessions.canSteer(conversationId, activeTaskId));

	const historyNavigation = selected && <ChatNavigation trigger={historyTrigger} conversations={conversations} conversationId={conversationId}
		disabled={loading || managingHistory}
		onRename={manageConversation}
		onArchive={confirmArchiveConversation} onDelete={confirmDeleteConversation}
		onSelect={(id) => void switchConversation(id)} onRefresh={refreshConversations} />;

	return <MetricPopoverProvider>
		<div className="scribe-app" data-layout={landing ? 'landing' : 'conversation'} onKeyDown={(event) => {
			if (!busy || event.defaultPrevented || composerShortcut(event.nativeEvent) !== 'escape'
				|| !(event.target instanceof Element) || !event.currentTarget.contains(event.target)
				|| event.target.closest('select, [role="dialog"], .scribe-subagents-panel')) return;
			event.preventDefault();
			event.stopPropagation();
			stop();
		}}>
			{historyNavigation}
			{landing ? <h1 className="scribe-chat-hero">
				<svg className="scribe-chat-icon" viewBox="0 0 100 100" aria-hidden="true">
					<path fill="currentColor" d="M72 10a8 8 0 0 1 11.3 0l6.7 6.7a8 8 0 0 1 0 11.3L39 79 17 84l5-22L72 10zm-3 14L29 64l-2 10 10-2 40-40-8-8zM13 90h74v6H13z" />
				</svg>
				{text.chatEmptyHeading}
			</h1> : <ExecutionView key={conversationId} app={services.app} skills={services.orchestration.skills} execution={execution} liveRequest={liveRequest} liveModel={liveModel}
				history={visibleHistory} reports={agentSnapshot.reports} loading={loading} conversationId={conversationId} editingId={editing?.taskId}
				automaticReview={active.current?.executionMode === 'auto-review'}
					submissions={agentSnapshot.submissions} inspectSubagent={openAgent} subagentNames={subagentNames}
				renderActivity={(taskId) => renderSubagentsActivity({ taskId, agents: agentSnapshot.agents, onSelect: openAgent, received: receivedSubmissions })}
				onQuoteSelection={loading || managingHistory ? undefined : addQuote}
				onSideChatSelection={loading || managingHistory ? undefined : (quote) => void askSideChatQuote(quote)}
				onEdit={busy || loading || hasActiveAgents ? undefined : editTurn} onFork={busy || loading ? undefined : (id) => void forkTurn(id)} />}
			<SubagentRequests app={services.app} prompt={displayedPrompt} selected={selected} onInspect={openAgent} />
			<div className="scribe-composer-capsules" key={`${conversationId}:capsules`}>
				{!landing && <BackgroundShellJobs jobs={services.tools.shellJobs} conversationId={conversationId} />}
				{selected && <SubagentsPanel controller={subagents} conversationId={conversationId} snapshot={agentSnapshot}
					executionMode={active.current?.executionMode ?? mode} onSelect={openAgent} />}
				{!landing && !loading && <>
					<ActivityMetric metrics={metrics} busy={busy || hasActiveAgents} />
					{metrics.usage && <UsagePopover usage={metrics.usage} busy={busy || hasActiveAgents} />}
				</>}
			</div>
			{planned && plan && <ChatPlanCard app={services.app} plan={plan} disabled={!eligiblePlan}
				onRevise={() => { setInstruction(tr('请调整上面的计划：', 'Revise the plan above: ')); input.current?.focus(); }}
				onExecute={confirmPlan} />}
			<QueuedMessages app={services.app} skills={services.orchestration.skills} rows={queue.rows} canSteer={canSteer} inputRef={input}
				onEdit={async (id, draft) => {
					const message = queuedMessage(id);
					const registry = services.orchestration.skills;
					const scope = message.request.skillScope ?? registry.scope(message.request.refs);
					const mentions = await prepareSkillMentions(draft, registry, scope);
					await queue.edit(queuedMessage(id), { instruction: draft.instruction, skillMentions: mentions });
				}}
				onDelete={async (id) => queue.delete(queuedMessage(id))}
				onSteer={async (id) => {
					const taskId = active.current?.taskId;
					const message = queuedMessage(id);
					if (!taskId || liveRequest?.intent || message.request.intent || message.request.target || queue.sentToSide(id)) throw new Error(text.queueSteerFailed);
					await sessions.steer(taskId, message);
					queue.remove(id);
				}}
				onSideChat={async (id, beforeRemove) => {
					const message = queuedMessage(id);
					await queue.delete(message, { ask: () => askSideChat(message.request), beforeRemove });
				}}
			/>
			<ChatGoalStatus goal={goal} hide={Boolean(composerMode)} />
			<TaskInput
				inputRef={input}
				busy={busy}
				disabled={loading || managingHistory}
				conversationId={conversationId}
				skills={services.orchestration.skills} skillScope={skillScope} skillMentions={skillMentions}
				target={target} onRemoveTarget={() => setTarget(undefined)}
				context={{
					app: services.app, refs, quotes, onAdd: addRef, onAddQuote: addQuote,
					conversationStore: services.orchestration.conversations, conversationIndex: conversations,
					onRemove: (path) => { setSkillScope(undefined); setRefs((previous) => previous.filter((ref) => ref.path !== path)); },
					onRemoveQuotes: (removed) => setQuotes((previous) => previous.filter((quote) => !removed.includes(quote))),
				}}
				contextMetric={!loading && (metrics.context || metrics.contextCompaction) &&
					<ContextMetric context={metrics.context} compaction={metrics.contextCompaction} busy={busy} />}
				executionMode={{ value: active.current?.executionMode ?? mode, queuePending: Boolean(queue.rows.length) || hasActiveAgents,
					onChange: changeExecutionMode }}
				composerMode={composerMode ? { kind: composerMode, onClose: () => setComposerMode(undefined) } : undefined}
				modelGroups={chatModel.groups}
				modelValue={chatModel.value}
				modelSaving={chatModel.saving}
				modelSelecting={chatModel.selecting}
				thinking={chatModel.thinking}
				onModelChange={changeModel}
				onThinkingChange={(level) => void changeThinking(level)}
				error={error}
				instruction={instruction}
				slashCommands={{ surface: 'main', goalActions: Boolean(goal.value), getSubcommands: getSlashSubcommands,
					getTargets: () => getSlashTargets(plugin), subscribeTargets: subscribeSlashTargets, selectTarget: setTarget, unavailable: slashUnavailable, run: runSlash }}
				onChange={(value, mentions, scope) => {
					setInstruction(value); setSkillMentions(mentions);
					if (scope || !value) setSkillScope(scope);
				}}
				onSubmit={submitDraft}
				queueDuringRun
				onContinueQueue={queue.paused && head && !head.request.selection ? continueQueue : undefined}
				queueContinuingDisabled={queue.rows.some(({ pending }) => pending)}
				onResume={!busy && !loading && !editing && !quotes.length && resumable && !resumable.request.goalRound
					&& (composerMode === undefined || planned && resumable.request.intent === 'plan')
					? () => void perform(undefined, resumable) : undefined}
				onStop={stop}
			/>
			{landing && conversations.some(({ archived }) => !archived) && <section className="scribe-chat-recents" aria-label={text.chatRecentConversations}>
				<h2>{text.chatRecentConversations}</h2>
				<ConversationList conversations={conversations.filter(({ archived }) => !archived)} conversationId={conversationId} disabled={managingHistory}
					onSelect={(id) => void switchConversation(id)} onRename={manageConversation}
					onArchive={confirmArchiveConversation} onDelete={confirmDeleteConversation} />
			</section>}
		</div>
	</MetricPopoverProvider>;
}
