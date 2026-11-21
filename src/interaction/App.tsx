import { isAbsolute } from 'node:path';
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { canResumeRun, ResumeThinkingUnavailable } from '../orchestration/runResume';
import { composerShortcut, sideChatCommand } from './composerKeyboard';
import { confirmAction } from './ConfirmModal';
import ApprovalView from './components/ApprovalView';
import { ActivityMetric, ContextMetric, UsagePopover, useChatMetrics } from './components/ChatMetrics';
import ChatNavigation, { ConversationList } from './components/ChatNavigation';
import ExecutionView from './components/ExecutionView';
import { MetricPopoverProvider } from './components/MetricPopover';
import QueuedMessages from './components/QueuedMessages';
import TaskInput from './components/TaskInput';
import { confirmResume } from './ResumeConfirmModal';
import { openSideChat, SideChatHandoffError } from './SideChatView';
import { emptyExecution, restoreExecution, updateExecution } from './context';
import type { ChatApproval, DisplayedRun } from './context';
import { thinkingLabel, uiText } from './uiText';
import { useChatModel } from './useChatModel';
import { useMessageQueue } from './useMessageQueue';
import type { ChatTabActivity } from './ChatTabs';
import type ScribeAiPlugin from '../main';
import { MissingConversationError } from '../types';
import type { ConversationSnapshot, ConversationSummary, ExecutionMode, NoteRef, NoteSelection, QueuedMessage, ResumePreview, RunObserver, RunEvent, SavedRun, TaskRequest, ToolApproval } from '../types';

interface ActiveSubmission {
	executionMode: ExecutionMode;
	taskId?: string;
	queuedId?: string;
	stopped?: boolean;
	retryConnection?: () => void;
}

interface EditDraft {
	taskId: string;
	original: ComposerDraft;
}

interface ComposerDraft {
	instruction: string;
	refs: NoteRef[];
	selection: NoteSelection | null;
	quotes: string[];
}

function draftRequest(draft: ComposerDraft, conversationId: string): TaskRequest {
	return {
		conversationId,
		instruction: draft.instruction,
		refs: draft.selection ? [] : draft.refs,
		...(draft.selection ? { selection: draft.selection } : {}),
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
	conversations: ConversationSummary[];
	initialError: string;
	onNew: () => void;
	onOpen: (id: string) => Promise<void>;
	onRename: (id: string, title: string) => Promise<boolean>;
	onDelete: (id: string) => Promise<void>;
	onRefresh: () => Promise<void>;
	onFork: (conversation: ConversationSnapshot) => void;
	onActivity: (id: string, activity: ChatTabActivity) => void;
}

export default function App({ plugin, conversation, mode, onModeChange, selected, conversations, initialError,
	onNew, onOpen, onRename, onDelete, onRefresh, onFork, onActivity }: ChatPaneProps) {
	const text = uiText();
	const services = plugin.services;
	const sessions = services.orchestration.sessions;
	const conversationId = conversation.id;
	const chatModel = useChatModel(plugin, conversation.runs.at(-1)?.model, true);
	const [refs, setRefs] = useState(() => vaultRefs(conversation.runs.at(-1)?.request.refs ?? []));
	const [attachedSelection, setAttachedSelection] = useState<NoteSelection | null>(null);
	const [quotes, setQuotes] = useState<string[]>([]);
	const [history, setHistory] = useState<DisplayedRun[]>(conversation.runs);
	const [instruction, setInstruction] = useState('');
	const [execution, setExecution] = useState(emptyExecution);
	const [liveRequest, setLiveRequest] = useState<TaskRequest>();
	const [liveModel, setLiveModel] = useState<SavedRun['model']>();
	const [editing, setEditing] = useState<EditDraft>();
	const [approval, setApproval] = useState<ChatApproval | null>(null);
	const [reviewing, setReviewing] = useState(false);
	const [error, setError] = useState(initialError);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(false);
	const [managingHistory, setManagingHistory] = useState(false);
	const queue = useMessageQueue(services.orchestration.conversations, () => setError(text.queueSendFailed), conversation.queue);
	const active = useRef<ActiveSubmission | null>(null);
	const pending = useRef<ChatApproval | null>(null);
	const mounted = useRef(false);
	const navigating = useRef(false);
	const visible = useRef(selected);
	const showResume = useRef<() => void>(undefined);
	const openingSideChat = useRef(false);
	const input = useRef<HTMLTextAreaElement>(null);
	const lastRun = history.at(-1);
	const resumable = canResumeRun(lastRun) ? lastRun : undefined;
	const liveTaskId = execution.state?.taskId;
	const editIndex = editing ? history.findIndex(({ state }) => state.taskId === editing.taskId) : -1;
	const metricHistory = useMemo(() => editIndex < 0 ? history : history.slice(0, editIndex), [history, editIndex]);
	const metrics = useChatMetrics(metricHistory, execution.state);
	const visibleHistory = useMemo(() => {
		const visible = editIndex < 0 ? history : liveTaskId ? history.slice(0, editIndex) : history.slice(0, editIndex + 1);
		return visible.filter((run) => run.state.taskId !== liveTaskId);
	}, [history, liveTaskId, editIndex]);
	const landing = !loading && !history.length && !execution.state && !queue.rows.length;
	const referenceShape = (refs: NoteRef[]) => JSON.stringify(refs.map(({ path, kind, lines }) => [path, kind, lines]));
	const expectedRefs = vaultRefs((liveTaskId ? liveRequest : lastRun?.request)?.refs ?? []);
	const dirty = Boolean(instruction.trim() || attachedSelection || quotes.length || referenceShape(refs) !== referenceShape(expectedRefs));

	const tabTitle = (history[0]?.request.instruction ?? liveRequest?.instruction)?.replace(/\s+/gu, ' ').trim().slice(0, 120);
	const tabStatus = approval || reviewing || execution.modelRetry === 'manual' ? 'attention'
		: busy ? 'running' : (execution.state ?? lastRun?.state)?.status === 'failed' ? 'error' : undefined;
	const tabHasDraft = dirty || Boolean(editing) || Boolean(queue.rows.length);
	useLayoutEffect(() => {
		onActivity(conversationId, { status: tabStatus, title: tabTitle, hasDraft: tabHasDraft });
	}, [conversationId, onActivity, tabStatus, tabTitle, tabHasDraft]);
	useLayoutEffect(() => {
		visible.current = selected;
		if (selected) showResume.current?.();
	}, [selected]);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			const submission = active.current;
			active.current = null;
			if (submission?.taskId) sessions.pause(submission.taskId);
			pending.current?.decide(false);
		};
	}, [sessions]);

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
			&& !active.current && !navigating.current && !queue.rows.length;
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
		const chat = trigger.closest('.scribe-app');
		confirmAction(services.app, {
			title: text.chatDeleteConversation,
			message: text.chatDeleteConfirm.replace('{title}', () => conversation.title || text.chatUntitled),
			confirmText: text.chatDeleteConversation,
			cancelText: text.cancel,
			onConfirm: async () => { if (mounted.current) await manageConversation(conversation.id); },
			onClose: () => trigger.ownerDocument.defaultView?.requestAnimationFrame(() => {
				if (!mounted.current) return;
				const target = trigger.isConnected && !trigger.disabled ? trigger
					: chat?.querySelector<HTMLButtonElement>('.scribe-chat-history > button:not(:disabled)') ?? input.current;
				target?.focus({ preventScroll: true });
			}),
		});
	}

	function editTurn(taskId: string) {
		if (active.current || navigating.current) return;
		if (editing?.taskId === taskId) {
			setInstruction(editing.original.instruction);
			setRefs(editing.original.refs);
			setAttachedSelection(editing.original.selection);
			setQuotes(editing.original.quotes);
			setEditing(undefined);
		} else {
			const request = history.find(({ state }) => state.taskId === taskId)?.request;
			if (!request) return;
			setEditing({ taskId, original: editing?.original ?? { instruction, refs, selection: attachedSelection, quotes } });
			setInstruction(request.instruction);
			setRefs(request.refs);
			setAttachedSelection(request.selection ?? null);
			setQuotes(request.chatQuotes ?? []);
			setExecution(emptyExecution);
			setLiveRequest(undefined);
		}
		setError('');
		input.current?.focus({ preventScroll: true });
	}

	async function forkTurn(taskId: string) {
		if (active.current || navigating.current) return;
		navigating.current = true;
		setLoading(true);
		setError('');
		let errorMessage = text.chatForkFailed;
		try {
			const branch = await sessions.forkConversation(conversationId, taskId, false);
			errorMessage = text.chatHistoryError;
			if (mounted.current) onFork(branch);
			await onRefresh();
		} catch {
			if (mounted.current) setError(errorMessage);
		} finally {
			navigating.current = false;
			if (mounted.current) setLoading(false);
		}
	}

	function clearDraft(draft: ComposerDraft, keepVaultRefs = false) {
		setInstruction((previous) => previous === draft.instruction ? '' : previous);
		setRefs((previous) => previous === draft.refs ? keepVaultRefs ? vaultRefs(previous) : [] : previous);
		setAttachedSelection((previous) => previous === draft.selection ? null : previous);
		setQuotes((previous) => previous === draft.quotes ? [] : previous);
	}

	async function askSideChat(request: TaskRequest, prompt = request.instruction) {
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
			const { selection, chatQuotes = [] } = request;
			const excerpts = selection ? [...chatQuotes,
				`${selection.title} (${selection.path}, ${selection.lines.join('–')})\n\n${selection.text}`] : chatQuotes;
			await openSideChat(plugin, conversationId, parentRuns, {
				prompt,
				refs: request.refs.map((ref) => isAbsolute(ref.path) ? { ...ref, addedExternal: true } : ref),
				quotes: excerpts,
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

	async function changeModel(value: string): Promise<boolean> {
		if (active.current || navigating.current || chatModel.isSaving()) return false;
		setError('');
		try {
			await chatModel.selectModel(value);
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

	function requestApproval(submission: ActiveSubmission, details: ToolApproval, signal: AbortSignal): Promise<boolean> {
		if (signal.aborted || active.current !== submission) return Promise.resolve(false);
		return new Promise((resolve) => {
			const decide = (allow: boolean) => {
				if (pending.current?.decide !== decide) return;
				signal.removeEventListener('abort', onAbort);
				pending.current = null;
				if (active.current === submission) setApproval(null);
				resolve(allow && !signal.aborted);
			};
			const onAbort = () => decide(false);
			const request = { ...details, decide };
			pending.current = request;
			signal.addEventListener('abort', onAbort, { once: true });
			setApproval(request);
		});
	}

	function waitForConnection(submission: ActiveSubmission, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			signal.throwIfAborted();
			const onAbort = () => {
				delete submission.retryConnection;
				reject(new Error('任务已停止。'));
			};
			submission.retryConnection = () => {
				signal.removeEventListener('abort', onAbort);
				delete submission.retryConnection;
				resolve();
			};
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	async function reviewResume(preview: ResumePreview, signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) return false;
		setReviewing(true);
		try {
			if (!visible.current) await new Promise<void>((resolve) => {
				const ready = () => {
					signal.removeEventListener('abort', ready);
					showResume.current = undefined;
					resolve();
				};
				showResume.current = ready;
				signal.addEventListener('abort', ready, { once: true });
			});
			return await confirmResume(services.app, preview, signal);
		} finally {
			if (mounted.current) setReviewing(false);
		}
	}

	async function perform(draft?: ComposerDraft, resume?: DisplayedRun, queued?: QueuedMessage) {
		if (active.current || navigating.current || chatModel.isSaving()) return;
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
		const submission: ActiveSubmission = { queuedId: queued?.id, executionMode: mode };
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
				approve: (details: ToolApproval, signal: AbortSignal) => requestApproval(submission, details, signal),
				retryConnection: (signal: AbortSignal) => waitForConnection(submission, signal),
				confirmResume: reviewResume,
			};
			setExecution(displayed);
			const request = resume?.request ?? queued?.request ?? (draft && draftRequest(draft, conversationId));
			if (!request) return;
			const options = { model: choice, rememberConversation: false, executionMode: submission.executionMode };
			const run = resume ? sessions.resume(conversationId, resume.state.taskId, observer, options)
				: queued ? sessions.submitQueued(queued, observer, () => { if (active.current === submission) queue.remove(queued.id); }, options)
					: sessions.submit(request, observer, replaceFrom, options);
			submission.taskId = run.taskId;
			setLiveRequest(request);
			setLiveModel(resume?.model ?? choice);
			if (draft && !replaceFrom) clearDraft(draft, true);
			onEvent({ type: 'state', state: await run.result });
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
		} catch (cause) {
			if (active.current === submission) {
				if (resume || replaceFrom || queued) {
					setExecution(emptyExecution);
					setLiveRequest(undefined);
					setLiveModel(undefined);
				}
				if (queued) queue.pause();
				if (!submission.stopped) {
					setError(queued ? text.queueStartFailed : cause instanceof ResumeThinkingUnavailable
						? text.chatResumeThinkingUnavailable.replace('{level}', () => thinkingLabel(text, cause.level))
						: cause instanceof Error ? cause.message : text.chatFailed);
				}
			}
		} finally {
			if (active.current === submission) {
				pending.current?.decide(false);
				active.current = null;
				setBusy(false);
			}
		}
	}

	function stop() {
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
		if (navigating.current || attachedSelection) return;
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
				clearDraft(draft);
				setError('');
			}
		} catch (cause) {
			if (mounted.current) setError(cause instanceof SideChatHandoffError ? cause.message : text.sideChatOpenFailed);
		}
	}

	function submitDraft(value: string) {
		if (navigating.current) return;
		const draft = { instruction: value, refs, selection: attachedSelection, quotes };
		const prompt = sideChatCommand(value);
		if (prompt !== null) {
			if (!openingSideChat.current) void sendSideCommand(draft, prompt);
		} else if (value.trim()) {
			const current = active.current;
			if (current) {
				queue.add(draftRequest(draft, conversationId), Promise.resolve(conversationId));
				clearDraft(draft);
				setError('');
			} else {
				void perform(draft);
			}
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
			|| !head || head.pending || head.failed) return;
		startNext(head);
	}, [busy, loading, managingHistory, chatModel.saving, chatModel.selecting, queue.paused, queue.updating, head]);

	function queuedMessage(id: string) {
		const message = queue.rows.find((row) => row.id === id && !row.pending && !row.failed);
		if (!message || active.current?.queuedId === id) throw new Error(text.queueMessageChanged);
		return message;
	}

	const activeTaskId = active.current?.taskId;
	const status = execution.state?.status;
	const canSteer = (!status || status === 'idle' || status === 'running' || status === 'awaiting-approval')
		&& !loading && !managingHistory && busy && Boolean(activeTaskId
		&& sessions.canSteer(conversationId, activeTaskId));

	return <MetricPopoverProvider>
		<div className="scribe-app" data-layout={landing ? 'landing' : 'conversation'} onKeyDown={(event) => {
			if (!busy || event.defaultPrevented || composerShortcut(event.nativeEvent) !== 'escape'
				|| !(event.target instanceof Element) || !event.currentTarget.contains(event.target)
				|| event.target.closest('select, [role="dialog"]')) return;
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
				history={visibleHistory} loading={loading} conversationId={conversationId} editingId={editing?.taskId}
				automaticReview={active.current?.executionMode === 'auto-review'}
				onQuoteSelection={loading || managingHistory || attachedSelection ? undefined : addQuote}
				onSideChatSelection={loading || managingHistory ? undefined : (quote) => void askSideChatQuote(quote)}
				onEdit={busy || loading ? undefined : editTurn} onFork={busy || loading ? undefined : (id) => void forkTurn(id)} />}
			<ApprovalView approval={approval} />
			<QueuedMessages app={services.app} rows={queue.rows} canSteer={canSteer} inputRef={input}
				onEdit={async (id, value) => queue.edit(queuedMessage(id), value)}
				onDelete={async (id) => queue.delete(queuedMessage(id))}
				onSteer={async (id) => {
					const taskId = active.current?.taskId;
					if (!taskId || queue.sentToSide(id)) throw new Error(text.queueSteerFailed);
					await sessions.steer(taskId, queuedMessage(id));
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
				conversationId={conversationId}
				context={{
					app: services.app, refs, quotes, selection: attachedSelection, onAdd: addRef,
					onRemove: (path) => setRefs((previous) => previous.filter((ref) => ref.path !== path)),
					onRemoveSelection: () => setAttachedSelection(null),
					onRemoveQuotes: () => setQuotes([]),
				}}
				contextMetric={!loading && metrics.context && <ContextMetric context={metrics.context} busy={busy} />}
				executionMode={{ value: active.current?.executionMode ?? mode, queuePending: Boolean(queue.rows.length), onChange: changeExecutionMode }}
				modelGroups={chatModel.groups}
				modelValue={chatModel.value}
				modelSaving={chatModel.saving}
				modelSelecting={chatModel.selecting}
				thinking={chatModel.thinking}
				onModelChange={changeModel}
				onThinkingChange={(level) => void changeThinking(level)}
				error={error}
				instruction={instruction}
				onChange={setInstruction}
				onSubmit={submitDraft}
				queueDuringRun
				onContinueQueue={queue.paused && queue.rows.length ? continueQueue : undefined}
				queueContinuingDisabled={queue.rows.some(({ pending }) => pending)}
				onResume={!busy && !loading && !editing && !attachedSelection && !quotes.length && resumable ? () => void perform(undefined, resumable) : undefined}
				onStop={stop}
				onRetryConnection={execution.modelRetry === 'manual' ? () => active.current?.retryConnection?.() : undefined}
				toolbar={!landing && <>
					{!loading && (metrics.count > 0 || metrics.usage) && <div className="scribe-composer-metrics">
						<ActivityMetric metrics={metrics} busy={busy} />
						{metrics.usage && <UsagePopover usage={metrics.usage} busy={busy} />}
					</div>}
					<ChatNavigation conversations={conversations} conversationId={conversationId} disabled={loading}
						managing={managingHistory} onRename={manageConversation} onDelete={confirmDeleteConversation}
						onSelect={(id) => void switchConversation(id)} onNew={() => void switchConversation()} onRefresh={refreshConversations} />
				</>}
			/>
			{landing && conversations.length > 0 && <section className="scribe-chat-recents" aria-label={text.chatRecentConversations}>
				<h2>{text.chatRecentConversations}</h2>
				<ConversationList conversations={conversations} conversationId={conversationId} disabled={managingHistory} onSelect={(id) => void switchConversation(id)}
					onRename={manageConversation} onDelete={confirmDeleteConversation} />
			</section>}
		</div>
	</MetricPopoverProvider>;
}
