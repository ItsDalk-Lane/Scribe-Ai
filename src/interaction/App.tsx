import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Notice } from 'obsidian';
import type { FileSystemAdapter } from 'obsidian';
import { MAX_REVIEW_MATERIAL_BYTES } from '../constants';
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { canResumeRun, ResumeThinkingUnavailable } from '../orchestration/runResume';
import { composerShortcut } from './composerKeyboard';
import { manualConversationSummary } from '../orchestration/context/manualConversationSummary';
import { confirmAction } from './ConfirmModal';
import BackgroundShellJobs from './components/BackgroundShellJobs';
import { ActivityMetric, ContextMetric, UsagePopover, useChatMetrics } from './components/ChatMetrics';
import ChatNavigation, { ConversationList } from './components/ChatNavigation';
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
import { copySlash, exportSlash, openSlashSettings, reviewChanges,
	showSlashDiff, showSlashSummary, showSlashUsage, showSlashWarnings, slashNoteChanges } from './slashActions';
import { parseSlashCommand, readSlashDraft, slashCommandAcceptsArgs } from './slashCommands';
import type { SlashCommand, SlashCommandName } from './slashCommands';
import type { SlashUi } from './slashUi';
import { showSlashPresets } from './slashPresets';
import { tr } from './skills/dialog';
import { ChatGoalStatus, useChatGoal } from './useChatGoal';
import type { ChatTabActivity } from './ChatTabs';
import type ScribeAiPlugin from '../main';
import { MissingConversationError } from '../types';
import type { AutoReviewDenial, ConversationSnapshot, ConversationSummary, ExecutionMode, NoteRef, QueuedMessage, RunObserver,
	RunEvent, RunState, SavedRun, SkillMention, SubagentSnapshot, TaskRequest } from '../types';

interface ActiveSubmission {
	executionMode: ExecutionMode;
	taskId?: string;
	queuedId?: string;
	stopped?: boolean;
	goal?: true;
}

const noSubagents: SubagentSnapshot = { agents: [], requests: [] };

interface EditDraft {
	taskId: string;
	original: ComposerDraft;
}

interface ComposerDraft extends SkillDraft {
	refs: NoteRef[];
	quotes: string[];
	skillScope?: string[];
}

function draftRequest(draft: ComposerDraft, conversationId: string, intent?: TaskRequest['intent']): TaskRequest {
	return {
		conversationId,
		instruction: draft.instruction,
		...(intent && { intent }),
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
	conversation: ConversationSnapshot;
	mode: ExecutionMode;
	onModeChange: (mode: ExecutionMode) => void;
	selected: boolean;
	open: boolean;
	conversations: ConversationSummary[];
	initialError: string;
	initialDraft?: SkillDraft;
	onNew: (title?: string) => void;
	onNewTab: (title?: string) => void;
	onClose: () => void;
	onArchive: (id: string, archived: boolean) => Promise<void>;
	onOpen: (id: string) => Promise<void>;
	onRename: (id: string, title: string) => Promise<boolean>;
	onDelete: (id: string) => Promise<void>;
	onRefresh: () => Promise<void>;
	onFork: (conversation: ConversationSnapshot, title?: string) => void;
	onActivity: (id: string, activity: ChatTabActivity) => void;
}

export default function App({ plugin, conversation, mode, onModeChange, selected, open, conversations, initialError, initialDraft,
	onNew, onNewTab, onClose, onArchive, onOpen, onRename, onDelete, onRefresh, onFork, onActivity }: ChatPaneProps) {
	const text = uiText();
	const services = plugin.services;
	const sessions = services.orchestration.sessions;
	const conversationId = conversation.id;
	const subagents = sessions.subagents;
	const chatModel = useChatModel(plugin, conversation.runs.at(-1)?.model, true);
	const [refs, setRefs] = useState(() => vaultRefs(conversation.runs.at(-1)?.request.refs ?? []));
	const [quotes, setQuotes] = useState<string[]>([]);
	const [history, setHistory] = useState<DisplayedRun[]>(conversation.runs);
	const [instruction, setInstruction] = useState(initialDraft?.instruction ?? '');
	const [skillMentions, setSkillMentions] = useState<SkillMention[]>(initialDraft?.skillMentions ?? []);
	const [skillScope, setSkillScope] = useState(initialDraft?.skillScope);
	const [execution, setExecution] = useState(emptyExecution);
	const [liveRequest, setLiveRequest] = useState<TaskRequest>();
	const [liveModel, setLiveModel] = useState<SavedRun['model']>();
	const [editing, setEditing] = useState<EditDraft>();
	const [parentPrompt, setParentPrompt] = useState<ParentPrompt>();
	const [error, setError] = useState(initialError);
	const [busy, setBusy] = useState(false);
	const [planned, setPlanned] = useState(false);
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
	const dirty = Boolean(instruction.trim() || quotes.length || referenceShape(refs) !== referenceShape(expectedRefs));

	const tabTitle = (history[0]?.request.instruction ?? liveRequest?.instruction)?.replace(/\s+/gu, ' ').trim().slice(0, 120);
	const tabStatus = displayedPrompt || execution.modelRetry === 'manual' ? 'attention'
		: busy || hasActiveAgents ? 'running' : (execution.state ?? lastRun?.state)?.status === 'failed' ? 'error' : undefined;
	const tabHasDraft = dirty || Boolean(editing) || Boolean(queue.rows.length);
	const goal = useChatGoal({
		app: services.app, conversationId, isOpen: open,
		canContinue: open && !busy && !loading && !managingHistory && !editing && !instruction.trim()
			&& !queue.rows.length && !hasActiveAgents && !chatModel.saving && !chatModel.selecting && Boolean(chatModel.choice) && !planned,
		start: (instruction) => perform(undefined, undefined, undefined, {
			goal: true, request: { conversationId, instruction, refs: [], goalRound: true },
		}),
		stopRunning: () => { if (active.current?.goal) stop(); },
	});
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

	async function switchConversation(id?: string) {
		setError('');
		try {
			if (id) await onOpen(id);
			else onNew();
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
		const rail = trigger.closest('.scribe-turn-navigator');
		confirmAction(services.app, {
			title: text.chatDeleteConversation,
			message: text.chatDeleteConfirm.replace('{title}', () => conversation.title || text.chatUntitled),
			confirmText: text.chatDeleteConversation,
			cancelText: text.cancel,
			onConfirm: async () => { if (mounted.current) await manageConversation(conversation.id); },
			onClose: () => trigger.ownerDocument.defaultView?.requestAnimationFrame(() => {
				if (!mounted.current) return;
				const target = trigger.isConnected && !trigger.disabled ? trigger
					: rail?.querySelector<HTMLButtonElement>('.scribe-turn-nav-toggle:not(:disabled), .scribe-turn-marker:not(:disabled)') ?? input.current;
				target?.focus({ preventScroll: true });
			}),
		});
	}

	function editTurn(taskId: string) {
		if (active.current || navigating.current || getAgents().agents.some(subagentIsActive)) return;
		if (editing?.taskId === taskId) {
			setInstruction(editing.original.instruction);
			setSkillMentions(editing.original.skillMentions ?? []);
			setSkillScope(editing.original.skillScope);
			setRefs(editing.original.refs);
			setQuotes(editing.original.quotes);
			setEditing(undefined);
		} else {
			const request = history.find(({ state }) => state.taskId === taskId)?.request;
			if (!request || request.selection || request.intent === 'review') return;
			setEditing({ taskId, original: editing?.original ?? { instruction, refs, quotes, skillMentions, skillScope } });
			setInstruction(request.instruction);
			setSkillMentions(request.skillMentions ?? []);
			setSkillScope(request.skillScope);
			setRefs(request.refs);
			setQuotes(request.chatQuotes ?? []);
			setExecution(emptyExecution);
			setLiveRequest(undefined);
		}
		setError('');
		input.current?.focus({ preventScroll: true });
	}

	async function forkTurn(taskId: string, title?: string) {
		if (active.current || auxiliary.current || navigating.current) return false;
		navigating.current = true;
		setLoading(true);
		setError('');
		let errorMessage = text.chatForkFailed;
		try {
			const branch = await sessions.forkConversation(conversationId, taskId, false);
			if (title) await sessions.renameConversation(branch.id, title);
			errorMessage = text.chatHistoryError;
			if (mounted.current) onFork(branch, title);
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
		setInstruction((previous) => previous === draft.instruction ? '' : previous);
		setSkillMentions((previous) => previous === skillMentions || previous === draft.skillMentions ? [] : previous);
		setSkillScope(undefined);
		setRefs((previous) => previous === draft.refs ? keepVaultRefs ? vaultRefs(previous) : [] : previous);
		setQuotes((previous) => previous === draft.quotes ? [] : previous);
	}

	async function askSideChat(request: TaskRequest, prompt = request.instruction) {
		if (request.selection) throw new SideChatHandoffError(text.queueSelectionUnavailable);
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
		const submission: ActiveSubmission = { queuedId: queued?.id, executionMode: mode, goal: command?.goal };
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
			const observer: RunObserver = {
				onEvent,
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
				pending.current?.respond(false);
				active.current = null;
				setBusy(false);
			}
		}
	}

	function stop() {
		if (auxiliary.current) { auxiliary.current.abort(); return; }
		const submission = active.current;
		if (!submission) return;
		queue.pause();
		submission.stopped = true;
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

	function submitDraft(value: string, mentions: SkillMention[], scope: string[]) {
		if (navigating.current) return;
		const draft = { instruction: value, refs, quotes, skillMentions: mentions, skillScope: scope };
		if (value.trim()) {
			const current = active.current;
			if (current) {
				queue.add(draftRequest(draft, conversationId, planned ? 'plan' : undefined), Promise.resolve(conversationId));
				clearDraft(draft);
				setError('');
			} else {
				void perform(draft);
			}
		}
	}

	function slashUnavailable(name: SlashCommandName, args: string): string | undefined {
		if (!selected || navigating.current) return text.chatLoadingHistory;
		if (busy && ['new', 'clear', 'fork', 'archive', 'delete', 'plan', 'review', 'compact', 'recap',
			'approve', 'presets', 'init', 'export'].includes(name)) {
			return tr('当前任务结束后可用。', 'Available after the current task finishes.');
		}
		if (editing && ['plan', 'review', 'compact', 'recap', 'archive', 'goal'].includes(name)) {
			return tr('请先完成或退出消息编辑。', 'Finish or cancel editing this message first.');
		}
		if (['review', 'compact', 'recap'].includes(name) || (name === 'plan' && args)) {
			if (!chatModel.choice) return text.chatModelMissing;
			if (chatModel.isSaving()) return tr('正在保存模型选择。', 'The model selection is being saved.');
		}
		if (name === 'archive' && (queue.rows.length || hasActiveAgents)) {
			return tr('请先处理排队的消息和子助手任务。', 'Finish queued messages and subagent tasks first.');
		}
		if (name === 'approve' && (mode !== 'auto-review' || planned || !denials.current.length)) {
			return tr('没有可重试的自动审核操作。', 'There is no denied auto-review action to retry.');
		}
		if (name === 'goal' && ((!args && !goal.value) || (args && !['edit', 'pause', 'clear'].includes(args.toLowerCase())))) {
			if (!chatModel.choice) return text.chatModelMissing;
			if (planned) return tr('请先退出计划模式。', 'Exit Plan mode first.');
		}
		return undefined;
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

	async function reviewNotes(args: string, controls: CommandUi) {
		const changed = noteChanges();
		const current = app.workspace.getActiveFile();
		const reviewablePath = (path: string) => !path.startsWith(`${app.vault.configDir}/`) && !isAbsolute(path);
		const inline = args.trim();
		const targets = [
			...(changed.length ? [{ kind: 'changes' as const, label: tr('本次聊天的改动', 'Changes in this chat') }] : []),
			...(current?.extension === 'md' && reviewablePath(current.path) ? [{ kind: 'file' as const, label: current.path, file: current }] : []),
			{ kind: 'pick' as const, label: tr('选择笔记', 'Choose a note') },
		];
		const target = inline && changed.length ? targets[0] : await controls.ui.choose(tr('选择要检查的内容', 'Choose what to review'), targets,
			({ label }) => label);
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
		openMention: () => Promise<boolean>;
		ui: SlashUi;
	};
	async function runSlash(command: SlashCommand, controls: CommandUi, inputText = instruction): Promise<boolean> {
		const { name, args } = command;
		if (args && !slashCommandAcceptsArgs(name)) throw new Error(tr('这条命令不接受额外文字。', 'This command does not accept arguments.'));
		const unavailable = slashUnavailable(name, args);
		if (unavailable) throw new Error(unavailable);
		if (['new', 'clear', 'fork', 'rename'].includes(name) && args.length > 120) {
			throw new Error(tr('对话名称最多 120 个字符。', 'Chat names can be up to 120 characters.'));
		}
		switch (name) {
			case 'new': onNewTab(args || undefined); return true;
			case 'clear': onNew(args || undefined); return true;
			case 'quit': onClose(); return true;
			case 'rename': {
				const title = args || await controls.ui.prompt(text.chatRenameConversation, currentTitle);
				if (title === undefined) return false;
				if (!title || title.length > 120) throw new Error(tr('请输入 1 到 120 个字符。', 'Enter between 1 and 120 characters.'));
				return manageConversation(conversationId, title);
			}
			case 'resume': {
				const rows = conversations.filter(({ id }) => id !== conversationId);
				const matching = args && (rows.find(({ id }) => id === args) ??
					rows.find(({ title }) => title.toLocaleLowerCase() === args.toLocaleLowerCase()));
				const target = matching || await controls.ui.choose(text.chatHistory, rows.filter(({ title, id }) => !args
					|| title.toLocaleLowerCase().includes(args.toLocaleLowerCase()) || id.startsWith(args)),
				({ title, archived }) => archived ? `${title} · ${tr('已归档', 'Archived')}` : title);
				if (!target) return false;
				if (target.archived) {
					if (!await controls.ui.confirm(tr('恢复已归档的聊天', 'Restore archived chat'), target.title, tr('恢复', 'Restore'))) return false;
				}
				await onOpen(target.id);
				return true;
			}
			case 'fork': {
				if (!lastRun) throw new Error(tr('当前还没有可分支的聊天记录。', 'There is no saved turn to fork.'));
				return forkTurn(lastRun.state.taskId, args || undefined);
			}
			case 'archive': {
				if (!lastRun) throw new Error(tr('当前没有可归档的聊天记录。', 'There is no saved conversation to archive.'));
				if (!await controls.ui.confirm(tr('归档聊天', 'Archive chat'), currentTitle, tr('归档', 'Archive'))) return false;
				if (active.current || auxiliary.current || !visible.current) return false;
				await onArchive(conversationId, true);
				return true;
			}
			case 'delete': {
				const message = text.chatDeleteConfirm.replace('{title}', () => currentTitle);
				if (!await controls.ui.confirm(text.chatDeleteConversation, message, text.chatDeleteConversation)) return false;
				return manageConversation(conversationId);
			}
			case 'skills': return controls.openSkills();
			case 'mention': return controls.openMention();
			case 'side': {
				if (openingSideChat.current) throw new Error(text.sideChatBusy);
				const draft = slashDraft(command, inputText);
				draft.skillScope ??= services.orchestration.skills.scope(refs);
				const mentions = await prepareSkillMentions(draft, services.orchestration.skills, draft.skillScope);
				return sendSideCommand({ ...draft, skillMentions: mentions }, args);
			}
			case 'agents': {
				const agents = getAgents().agents;
				return controls.ui.show(tr('子助手概览', 'Subagent overview'), agents.length ? agents.map(({ name, status, role }) =>
					`${name} · ${role} · ${status}`) : [tr('当前聊天暂无子助手。', 'This chat has no subagents.')]);
			}
			case 'multi-agents': {
				const agents = getAgents().agents;
				if (!agents.length) throw new Error(tr('当前聊天暂无子助手。', 'This chat has no subagents.'));
				const agent = await controls.ui.choose(tr('选择子助手', 'Choose a subagent'), agents,
					({ name, status }) => `${name} · ${status}`);
				if (!agent) return false;
				plugin.openSubagent(conversationId, agent.id);
				return true;
			}
			case 'copy': return copySlash(visibleHistory, execution.state, controls.ui);
			case 'export': return exportSlash(app, visibleHistory, args, currentTitle, controls.ui);
			case 'status':
				return controls.ui.show(tr('聊天状态', 'Chat status'), [
					currentTitle,
					chatModel.choice?.model ?? text.chatModelMissing,
					planned ? tr('计划模式', 'Plan mode') : mode === 'full-access' ? text.chatModeFullAccess
						: mode === 'auto-review' ? text.chatModeAutoReview : text.chatModeAsk,
					busy ? tr('正在处理任务', 'Task running') : tr('空闲', 'Idle'),
					...(metrics.context ? [tr(`已用上下文 ${metrics.context.percent}%`, `Context used: ${metrics.context.percent}%`)] : []),
				]);
			case 'usage': return showSlashUsage(metrics, controls.ui);
			case 'warnings': return showSlashWarnings(plugin, controls.ui);
			case 'config': return openSlashSettings(plugin, controls.ui);
			case 'init': return openSlashSettings(plugin, controls.ui, true);
			case 'ps': {
				const jobs = services.tools.shellJobs.list(conversationId);
				return controls.ui.show(tr('后台任务', 'Background jobs'), jobs.length ? jobs.map(({ command, name, status }) =>
					`${command || name} · ${status}`) : [tr('当前聊天暂无后台任务。', 'There are no background jobs in this chat.')]);
			}
			case 'stop': {
				await services.tools.shellJobs.stopConversation(conversationId);
				new Notice(tr('已停止当前聊天的后台任务。', 'Background jobs in this chat have stopped.'));
				return true;
			}
			case 'approve': {
				const denial = await controls.ui.choose(tr('选择要重试的操作', 'Choose an action to retry'), [...denials.current].reverse(),
					({ approval }) => `${approval.title} · ${approval.target ?? ''}`);
				if (!denial) return false;
				if (!await controls.ui.confirm(tr('仅批准这一次重试', 'Approve one retry'),
					[denial.approval.title, denial.approval.target, denial.approval.after].filter(Boolean).join('\n'), tr('批准并重试', 'Approve and retry'))) return false;
				if (!visible.current || slashUnavailable('approve', '')) return false;
				denials.current = denials.current.filter(({ id }) => id !== denial.id);
				const result = await runAuxiliary((signal) => denial.retry(signal));
				if (result.isError) throw new Error(result.content);
				return controls.ui.show(tr('重试结果', 'Retry result'), [result.content]);
			}
			case 'presets': {
				const result = await showSlashPresets(app, controls.ui);
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
				submitDraft(result, mentions, scope);
				return true;
			}
			case 'plan': {
				if (args) {
					const draft = slashDraft(command, inputText);
					draft.skillScope ??= services.orchestration.skills.scope(refs);
					draft.skillMentions = await prepareSkillMentions(draft, services.orchestration.skills, draft.skillScope);
					if (!visible.current || active.current) return false;
					void perform(undefined, undefined, undefined, { request: draftRequest(draft, conversationId, 'plan') });
					setQuotes([]);
					setRefs(vaultRefs(refs));
				}
				setPlanned(true);
				return true;
			}
			case 'goal': return goal.command(args, controls.ui);
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
			case 'review': return reviewNotes(args, controls);
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

	const historyNavigation = selected && <ChatNavigation conversations={conversations} conversationId={conversationId}
		disabled={loading || managingHistory}
		store={services.orchestration.conversations} onRename={manageConversation} onDelete={confirmDeleteConversation}
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
			{landing ? <h1 className="scribe-chat-hero">
				<svg className="scribe-chat-icon" viewBox="0 0 100 100" aria-hidden="true">
					<path fill="currentColor" d="M72 10a8 8 0 0 1 11.3 0l6.7 6.7a8 8 0 0 1 0 11.3L39 79 17 84l5-22L72 10zm-3 14L29 64l-2 10 10-2 40-40-8-8zM13 90h74v6H13z" />
				</svg>
				{text.chatEmptyHeading}
			</h1> : <ExecutionView key={conversationId} app={services.app} execution={execution} liveRequest={liveRequest} liveModel={liveModel}
				historyNavigation={historyNavigation} history={visibleHistory} reports={agentSnapshot.reports} loading={loading} conversationId={conversationId} editingId={editing?.taskId}
				automaticReview={active.current?.executionMode === 'auto-review'}
					submissions={agentSnapshot.submissions} inspectSubagent={openAgent} subagentNames={subagentNames}
				renderActivity={(taskId) => renderSubagentsActivity({ taskId, agents: agentSnapshot.agents, onSelect: openAgent, received: receivedSubmissions })}
				onQuoteSelection={loading || managingHistory ? undefined : addQuote}
				onSideChatSelection={loading || managingHistory ? undefined : (quote) => void askSideChatQuote(quote)}
				onEdit={busy || loading || hasActiveAgents ? undefined : editTurn} onFork={busy || loading ? undefined : (id) => void forkTurn(id)} />}
			<SubagentRequests app={services.app} prompt={displayedPrompt} selected={selected} onInspect={openAgent} />
			<div className="scribe-composer-capsules" key={conversationId}>
				{!landing && <BackgroundShellJobs jobs={services.tools.shellJobs} conversationId={conversationId} />}
				{selected && <SubagentsPanel controller={subagents} conversationId={conversationId} snapshot={agentSnapshot}
					executionMode={active.current?.executionMode ?? mode} onSelect={openAgent} />}
				{!landing && !loading && <>
					<ActivityMetric metrics={metrics} busy={busy || hasActiveAgents} />
					{metrics.usage && <UsagePopover usage={metrics.usage} busy={busy || hasActiveAgents} />}
				</>}
			</div>
			<ChatGoalStatus goal={goal} />
			{planned && <div className="scribe-composer-capsules" role="group" aria-label={tr('计划模式', 'Plan mode')}>
				<button type="button" className="scribe-compose-action" onClick={() => setPlanned(false)}>
					{tr('计划模式 · 退出', 'Plan mode · Exit')}
				</button>
			</div>}
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
					if (!taskId || liveRequest?.intent || message.request.intent || queue.sentToSide(id)) throw new Error(text.queueSteerFailed);
					await sessions.steer(taskId, message);
					queue.remove(id);
				}}
				onSideChat={async (id, beforeRemove) => {
					const message = queuedMessage(id);
					await queue.delete(message, { ask: () => askSideChat(message.request), beforeRemove });
				}}
			/>
			<TaskInput
				inputRef={input}
				busy={busy}
				disabled={loading || managingHistory}
				onNew={() => void switchConversation()}
				conversationId={conversationId}
				skills={services.orchestration.skills} skillScope={skillScope} skillMentions={skillMentions}
				context={{
					app: services.app, refs, quotes, onAdd: addRef,
					onRemove: (path) => { setSkillScope(undefined); setRefs((previous) => previous.filter((ref) => ref.path !== path)); },
					onRemoveQuotes: () => setQuotes([]),
				}}
				contextMetric={!loading && (metrics.context || metrics.contextCompaction) &&
					<ContextMetric context={metrics.context} compaction={metrics.contextCompaction} busy={busy} />}
				executionMode={{ value: active.current?.executionMode ?? mode, queuePending: Boolean(queue.rows.length) || hasActiveAgents,
					onChange: changeExecutionMode }}
				modelGroups={chatModel.groups}
				modelValue={chatModel.value}
				modelSaving={chatModel.saving}
				modelSelecting={chatModel.selecting}
				thinking={chatModel.thinking}
				onModelChange={changeModel}
				onThinkingChange={(level) => void changeThinking(level)}
				error={error}
				instruction={instruction}
				slashCommands={{ surface: 'main', unavailable: slashUnavailable, run: runSlash }}
				onChange={(value, mentions, scope) => {
					setInstruction(value); setSkillMentions(mentions);
					if (scope || !value) setSkillScope(scope);
				}}
				onSubmit={submitDraft}
				queueDuringRun
				onContinueQueue={queue.paused && head && !head.request.selection ? continueQueue : undefined}
				queueContinuingDisabled={queue.rows.some(({ pending }) => pending)}
				onResume={!busy && !loading && !editing && !quotes.length && resumable && (!planned || resumable.request.intent)
					? () => void perform(undefined, resumable) : undefined}
				onStop={stop}
			/>
			{landing && conversations.some(({ archived }) => !archived) && <section className="scribe-chat-recents" aria-label={text.chatRecentConversations}>
				<h2>{text.chatRecentConversations}</h2>
				<ConversationList conversations={conversations.filter(({ archived }) => !archived)} conversationId={conversationId} disabled={managingHistory}
					onSelect={(id) => void switchConversation(id)} onRename={manageConversation} onDelete={confirmDeleteConversation} />
			</section>}
			{landing && conversations.some(({ archived }) => archived) && <details className="scribe-chat-recents">
				<summary>{tr('已归档的聊天', 'Archived chats')}</summary>
				<ConversationList conversations={conversations.filter(({ archived }) => archived)}
					conversationId={conversationId} disabled={managingHistory} onSelect={(id) => void switchConversation(id)}
					onRename={manageConversation} onDelete={confirmDeleteConversation} />
			</details>}
		</div>
	</MetricPopoverProvider>;
}
