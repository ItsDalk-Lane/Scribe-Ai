import { isAbsolute } from 'node:path';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canResumeRun, ResumeThinkingUnavailable } from '../orchestration/runResume';
import { composerShortcut } from './composerKeyboard';
import { confirmAction } from './ConfirmModal';
import ApprovalView from './components/ApprovalView';
import ChatMetrics from './components/ChatMetrics';
import ChatNavigation, { ConversationList } from './components/ChatNavigation';
import ExecutionView from './components/ExecutionView';
import { MetricPopoverProvider } from './components/MetricPopover';
import TaskInput from './components/TaskInput';
import { confirmResume } from './ResumeConfirmModal';
import { emptyExecution, restoreExecution, updateExecution } from './context';
import type { ChatApproval, DisplayedRun } from './context';
import { uiText } from './uiText';
import { useChatModel } from './useChatModel';
import type ScribeAiPlugin from '../main';
import type { ConversationSnapshot, ConversationSummary, NoteRef, NoteSelection, RunObserver, RunEvent, SavedRun, TaskRequest, ToolApproval } from '../types';

interface ActiveSubmission {
	taskId?: string;
	retryConnection?: () => void;
}

interface EditDraft {
	taskId: string;
	original: { instruction: string; refs: NoteRef[]; selection: NoteSelection | null };
}

function vaultRefs(refs: NoteRef[]): NoteRef[] {
	return refs.filter(({ path }) => !isAbsolute(path));
}

export default function App({ plugin }: { plugin: ScribeAiPlugin }) {
	const text = uiText();
	const services = plugin.services;
	const sessions = services.orchestration.sessions;
	const chatModel = useChatModel(plugin);
	const [refs, setRefs] = useState<NoteRef[]>([]);
	const [attachedSelection, setAttachedSelection] = useState<NoteSelection | null>(null);
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [history, setHistory] = useState<DisplayedRun[]>([]);
	const [instruction, setInstruction] = useState('');
	const [execution, setExecution] = useState(emptyExecution);
	const [liveRequest, setLiveRequest] = useState<TaskRequest>();
	const [liveModel, setLiveModel] = useState<SavedRun['model']>();
	const [editing, setEditing] = useState<EditDraft>();
	const [approval, setApproval] = useState<ChatApproval | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [managingHistory, setManagingHistory] = useState(false);
	const active = useRef<ActiveSubmission | null>(null);
	const pending = useRef<ChatApproval | null>(null);
	const mounted = useRef(false);
	const navigating = useRef(true);
	const input = useRef<HTMLTextAreaElement>(null);
	const lastRun = history.at(-1);
	const resumable = canResumeRun(lastRun) ? lastRun : undefined;
	const liveTaskId = execution.state?.taskId;
	const editIndex = editing ? history.findIndex(({ state }) => state.taskId === editing.taskId) : -1;
	const metricHistory = useMemo(() => editIndex < 0 ? history : history.slice(0, editIndex), [history, editIndex]);
	const visibleHistory = useMemo(() => {
		const visible = editIndex < 0 ? history : liveTaskId ? history.slice(0, editIndex) : history.slice(0, editIndex + 1);
		return visible.filter((run) => run.state.taskId !== liveTaskId);
	}, [history, liveTaskId, editIndex]);
	const landing = !loading && !history.length && !execution.state;
	const referenceShape = (refs: NoteRef[]) => JSON.stringify(refs.map(({ path, kind, lines }) => [path, kind, lines]));
	const expectedRefs = vaultRefs((liveTaskId ? liveRequest : lastRun?.request)?.refs ?? []);
	const dirty = Boolean(instruction.trim() || attachedSelection || referenceShape(refs) !== referenceShape(expectedRefs));

	const applyConversation = useCallback((conversation: ConversationSnapshot | null) => {
		setConversationId(conversation?.id ?? null);
		setHistory(conversation?.runs ?? []);
		setRefs(vaultRefs(conversation?.runs.at(-1)?.request.refs ?? []));
		setAttachedSelection(null);
		setExecution(emptyExecution);
		setLiveRequest(undefined);
		setLiveModel(undefined);
		setEditing(undefined);
		setInstruction('');
	}, []);

	useEffect(() => {
		mounted.current = true;
		navigating.current = true;
		setLoading(true);
		let closed = false;
		void Promise.allSettled([sessions.listConversations(), sessions.openConversation()]).then(([index, previous]) => {
			if (closed) return;
			if (index.status === 'fulfilled') setConversations(index.value);
			if (previous.status === 'fulfilled') applyConversation(previous.value);
			if (index.status === 'rejected' || previous.status === 'rejected') setError(text.chatHistoryError);
			navigating.current = false;
			setLoading(false);
		});
		return () => {
			closed = true;
			mounted.current = false;
			const submission = active.current;
			active.current = null;
			if (submission?.taskId) sessions.pause(submission.taskId);
			pending.current?.decide(false);
		};
	}, [applyConversation, sessions, text.chatHistoryError]);

	async function switchConversation(id?: string) {
		if (active.current || navigating.current) return;
		navigating.current = true;
		setLoading(true);
		setError('');
		try {
			const conversation = id
				? await sessions.openConversation(id)
				: { id: await sessions.createConversation(), runs: [] };
			if (mounted.current) applyConversation(conversation);
		} catch {
			if (mounted.current) setError(text.chatHistoryError);
		} finally {
			navigating.current = false;
			if (mounted.current) setLoading(false);
		}
	}

	async function manageConversation(id: string, title?: string): Promise<boolean> {
		if (active.current || navigating.current) return false;
		navigating.current = true;
		setManagingHistory(true);
		setError('');
		try {
			if (title !== undefined) {
				await sessions.renameConversation(id, title);
				if (mounted.current) setConversations((rows) => rows.map((row) => row.id === id ? { ...row, title } : row));
			} else {
				await sessions.deleteConversation(id);
				if (mounted.current) setConversations((rows) => rows.filter((row) => row.id !== id));
				if (id === conversationId) {
					if (mounted.current) applyConversation(null);
					const next = await sessions.createConversation().catch(() => {
						if (mounted.current) setError(text.saveFailed);
						return null;
					});
					if (mounted.current) setConversationId(next);
				}
			}
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
		if (active.current || navigating.current) return;
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
			setEditing(undefined);
		} else {
			const request = history.find(({ state }) => state.taskId === taskId)?.request;
			if (!request) return;
			setEditing({ taskId, original: editing?.original ?? { instruction, refs, selection: attachedSelection } });
			setInstruction(request.instruction);
			setRefs(request.refs);
			setAttachedSelection(request.selection ?? null);
			setExecution(emptyExecution);
			setLiveRequest(undefined);
		}
		setError('');
		input.current?.focus({ preventScroll: true });
	}

	async function forkTurn(taskId: string) {
		if (!conversationId || active.current || navigating.current) return;
		navigating.current = true;
		setLoading(true);
		setError('');
		let errorMessage = text.chatForkFailed;
		try {
			const branch = await sessions.forkConversation(conversationId, taskId);
			errorMessage = text.chatHistoryError;
			if (mounted.current) applyConversation(branch);
			const index = await sessions.listConversations();
			if (mounted.current) setConversations(index);
		} catch {
			if (mounted.current) setError(errorMessage);
		} finally {
			navigating.current = false;
			if (mounted.current) setLoading(false);
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

	async function changeThinking(level: ModelThinkingLevel) {
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

	async function perform(prompt: string, resume?: DisplayedRun) {
		if (active.current || navigating.current || chatModel.isSaving()) return;
		if (!chatModel.refreshSelection()) {
			setError(text.chatModelChanged);
			return;
		}
		const submission: ActiveSubmission = {};
		active.current = submission;
		setBusy(true);
		setError('');
		const replaceFrom = !resume ? editing?.taskId : undefined;
		let appliedEdit = false;
		let displayed = resume ? restoreExecution(resume) : emptyExecution;
		const onEvent = (event: RunEvent) => {
			if (active.current !== submission) return;
			displayed = updateExecution(displayed, event);
			setExecution(displayed);
			if (replaceFrom && !appliedEdit && event.type === 'state' && event.state.messages.some(({ role }) => role === 'user')) {
				appliedEdit = true;
				setRefs(vaultRefs);
				setInstruction('');
				setAttachedSelection(null);
			}
		};
		try {
			const id = conversationId ?? await sessions.createConversation();
			if (active.current !== submission) return;
			if (!chatModel.refreshSelection()) throw new Error(text.chatModelChanged);
			const observer: RunObserver = {
				onEvent,
				approve: (details: ToolApproval, signal: AbortSignal) => requestApproval(submission, details, signal),
				retryConnection: (signal: AbortSignal) => waitForConnection(submission, signal),
				confirmResume: (preview, signal) => confirmResume(services.app, preview, signal),
			};
			setExecution(displayed);
			const request = resume?.request ?? {
				conversationId: id,
				instruction: prompt,
				refs: attachedSelection ? [] : refs,
				...(attachedSelection ? { selection: attachedSelection } : {}),
			};
			const { providerId, model } = services.settings;
			const run = resume ? sessions.resume(id, resume.state.taskId, observer) : sessions.submit(request, observer, replaceFrom);
			submission.taskId = run.taskId;
			setLiveRequest(request);
			setLiveModel(resume?.model ?? { providerId, model });
			if (!resume && !replaceFrom) {
				setRefs(vaultRefs);
				setInstruction('');
				setAttachedSelection(null);
			}
			setConversationId(id);
			onEvent({ type: 'state', state: await run.result });
			if (active.current !== submission) return;
			if (replaceFrom) {
				setHistory((previous) => previous.slice(0, editIndex));
				setEditing(undefined);
				setRefs(vaultRefs);
				setInstruction('');
				setAttachedSelection(null);
			}
			const [index, current] = await Promise.allSettled([sessions.listConversations(), sessions.openConversation(id)]);
			if (active.current !== submission) return;
			if (index.status === 'fulfilled') setConversations(index.value);
			if (current.status === 'fulfilled' && current.value?.runs.some(({ state }) => state.taskId === run.taskId)) {
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
				if (!resume) {
					setRefs(vaultRefs(runs.at(-1)?.request.refs ?? []));
					setAttachedSelection(null);
					setInstruction('');
				}
			}
			if (index.status === 'rejected' || current.status === 'rejected') setError(text.chatHistoryError);
		} catch (cause) {
			if (active.current === submission) {
				if (resume || replaceFrom) {
					setExecution(emptyExecution);
					setLiveRequest(undefined);
					setLiveModel(undefined);
				}
				setError(cause instanceof ResumeThinkingUnavailable
					? text.chatResumeThinkingUnavailable.replace('{level}', text.thinkingLevelNames[cause.level])
					: cause instanceof Error ? cause.message : text.chatFailed);
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
		if (submission?.taskId) {
			void sessions.cancel(submission.taskId).catch((cause: unknown) => {
				if (active.current === submission) setError(cause instanceof Error ? cause.message : text.chatFailed);
			});
		} else if (submission) {
			active.current = null;
			setBusy(false);
		}
	}

	function addRef(ref: NoteRef) {
		if (active.current || navigating.current || attachedSelection) return;
		setRefs((previous) => previous.some((existing) => existing.path === ref.path)
			? previous.map((existing) => existing.path === ref.path ? ref : existing)
			: [...previous, ref]);
	}


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
				onEdit={busy || loading ? undefined : editTurn} onFork={busy || loading ? undefined : (id) => void forkTurn(id)} />}
			<ApprovalView approval={approval} />
			{!landing && <div className="scribe-composer-bar">
				{!loading && <ChatMetrics history={metricHistory} live={execution.state} busy={busy} dirty={dirty} />}
				<ChatNavigation conversations={conversations} conversationId={conversationId} disabled={loading || busy}
					managing={managingHistory} onRename={manageConversation} onDelete={confirmDeleteConversation}
					onSelect={(id) => void switchConversation(id)} onNew={() => void switchConversation()} />
			</div>}
			<TaskInput
				inputRef={input}
				busy={busy}
				disabled={loading || managingHistory}
				conversationId={conversationId}
				context={{
					app: services.app, refs, selection: attachedSelection, onAdd: addRef,
					onRemove: (path) => setRefs((previous) => previous.filter((ref) => ref.path !== path)),
					onRemoveSelection: () => setAttachedSelection(null),
				}}
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
				onSubmit={(instruction) => void perform(instruction)}
				onResume={!busy && !loading && !editing && !attachedSelection && resumable ? () => void perform('', resumable) : undefined}
				onStop={stop}
				onRetryConnection={execution.modelRetry === 'manual' ? () => active.current?.retryConnection?.() : undefined}
			/>
			{landing && conversations.length > 0 && <section className="scribe-chat-recents" aria-label={text.chatRecentConversations}>
				<h2>{text.chatRecentConversations}</h2>
				<ConversationList conversations={conversations} disabled={busy || managingHistory} onSelect={(id) => void switchConversation(id)}
					onRename={manageConversation} onDelete={confirmDeleteConversation} />
			</section>}
		</div>
	</MetricPopoverProvider>;
}
