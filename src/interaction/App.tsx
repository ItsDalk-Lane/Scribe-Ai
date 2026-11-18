import { isAbsolute } from 'node:path';
import { MarkdownView } from 'obsidian';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canResumeRun } from '../orchestration/runResume';
import { composerShortcut } from './composerKeyboard';
import ApprovalView from './components/ApprovalView';
import ChatNavigation, { ConversationList } from './components/ChatNavigation';
import ExecutionView from './components/ExecutionView';
import TaskInput from './components/TaskInput';
import { confirmResume } from './ResumeConfirmModal';
import { emptyExecution, restoreExecution, updateExecution } from './context';
import type { ChatApproval } from './context';
import { uiText } from './uiText';
import type { ConversationSnapshot, ConversationSummary, NoteRef, NoteSelection, RunObserver, RunEvent, SavedRun, ScribeServices, TaskRequest, ToolApproval } from '../types';

interface ActiveSubmission {
	taskId?: string;
	retryConnection?: () => void;
}

function vaultRefs(refs: NoteRef[]): NoteRef[] {
	return refs.filter(({ path }) => !isAbsolute(path));
}

export default function App({ services }: { services: ScribeServices }) {
	const text = uiText();
	const sessions = services.orchestration.sessions;
	const { settings } = services;
	const [selection, setSelection] = useState(() => ({ providerId: settings.providerId, model: settings.model }));
	const [refs, setRefs] = useState<NoteRef[]>([]);
	const [attachedSelection, setAttachedSelection] = useState<NoteSelection | null>(null);
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [history, setHistory] = useState<SavedRun[]>([]);
	const [instruction, setInstruction] = useState('');
	const [execution, setExecution] = useState(emptyExecution);
	const [liveRequest, setLiveRequest] = useState<TaskRequest>();
	const [approval, setApproval] = useState<ChatApproval | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const active = useRef<ActiveSubmission | null>(null);
	const pending = useRef<ChatApproval | null>(null);
	const mounted = useRef(false);
	const navigating = useRef(true);
	const lastMarkdown = useRef<MarkdownView | null>(null);
	const workspace = services.app.workspace;
	const providerId = selection.providerId;
	const lastRun = history.at(-1);
	const resumable = canResumeRun(lastRun) ? lastRun : undefined;
	const liveTaskId = execution.state?.taskId;
	const visibleHistory = useMemo(() => history.filter((run) => run.state.taskId !== liveTaskId), [history, liveTaskId]);
	const landing = !loading && !history.length && !execution.state;
	const defaultProviderLabel = useMemo(() => providerId
		? services.communication.models.providers().find((provider) => provider.id === providerId)?.label
		: undefined, [providerId, services]);
	const providerLabel = settings.communication.providerNames[providerId]
		?? settings.customProviders[providerId]?.label ?? defaultProviderLabel ?? providerId;

	const applyConversation = useCallback((conversation: ConversationSnapshot | null) => {
		setConversationId(conversation?.id ?? null);
		setHistory(conversation?.runs ?? []);
		setRefs(vaultRefs(conversation?.runs.at(-1)?.request.refs ?? []));
		setAttachedSelection(null);
		setExecution(emptyExecution);
		setLiveRequest(undefined);
		setInstruction('');
	}, []);

	useEffect(() => {
		lastMarkdown.current = workspace.getActiveViewOfType(MarkdownView);
		const reference = workspace.on('active-leaf-change', (leaf) => {
			if (leaf?.view instanceof MarkdownView) lastMarkdown.current = leaf.view;
		});
		return () => workspace.offref(reference);
	}, [workspace]);

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

	function refreshSelection() {
		if (settings.providerId === selection.providerId && settings.model === selection.model) return true;
		setSelection({ providerId: settings.providerId, model: settings.model });
		return false;
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

	async function perform(prompt: string, resume?: SavedRun) {
		if (active.current || navigating.current) return;
		if (!refreshSelection()) {
			setError(text.chatModelChanged);
			return;
		}
		const submission: ActiveSubmission = {};
		active.current = submission;
		setBusy(true);
		setError('');
		const onEvent = (event: RunEvent) => {
			if (active.current !== submission) return;
			setExecution((previous) => updateExecution(previous, event));
		};
		try {
			const id = conversationId ?? await sessions.createConversation();
			if (active.current !== submission) return;
			if (!refreshSelection()) throw new Error(text.chatModelChanged);
			const observer: RunObserver = {
				onEvent,
				approve: (details: ToolApproval, signal: AbortSignal) => requestApproval(submission, details, signal),
				retryConnection: (signal: AbortSignal) => waitForConnection(submission, signal),
				confirmResume: (preview, signal) => confirmResume(services.app, preview, signal),
			};
			setExecution(resume ? restoreExecution(resume) : emptyExecution);
			const request = resume?.request ?? {
				conversationId: id,
				instruction: prompt,
				refs: attachedSelection ? [] : refs,
				...(attachedSelection ? { selection: attachedSelection } : {}),
			};
			const run = resume ? sessions.resume(id, resume.state.taskId, observer) : sessions.submit(request, observer);
			submission.taskId = run.taskId;
			setLiveRequest(request);
			if (!resume) {
				setRefs(vaultRefs);
				setInstruction('');
				setAttachedSelection(null);
			}
			setConversationId(id);
			onEvent({ type: 'state', state: await run.result });
			if (active.current !== submission) return;
			const [index, current] = await Promise.allSettled([sessions.listConversations(), sessions.openConversation(id)]);
			if (active.current !== submission) return;
			if (index.status === 'fulfilled') setConversations(index.value);
			if (current.status === 'fulfilled' && current.value?.runs.some(({ state }) => state.taskId === run.taskId)) {
				if (resume) {
					setHistory(current.value.runs);
					setExecution(emptyExecution);
					setLiveRequest(undefined);
				} else {
					applyConversation(current.value);
				}
			}
			if (index.status === 'rejected' || current.status === 'rejected') setError(text.chatHistoryError);
		} catch (cause) {
			if (active.current === submission) {
				if (resume) {
					setExecution(emptyExecution);
					setLiveRequest(undefined);
				}
				setError(cause instanceof Error ? cause.message : text.chatFailed);
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

	function attachSelection(): boolean {
		if (active.current || navigating.current) return false;
		const recent = workspace.getMostRecentLeaf()?.view;
		const previous = lastMarkdown.current;
		let view = workspace.getActiveViewOfType(MarkdownView)
			?? (previous?.leaf.view === previous ? previous : null)
			?? (recent instanceof MarkdownView ? recent : null);
		if (!view) {
			const file = workspace.getActiveFile();
			const views = workspace.getLeavesOfType('markdown').map(({ view }) => view)
				.filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === file);
			if (views.length === 1) view = views[0] ?? null;
		}
		if (!view?.file || view.getMode() !== 'source') return false;
		const selected = view.editor.getSelection();
		if (!selected) return false;
		const from = view.editor.getCursor('from');
		const to = view.editor.getCursor('to');
		setAttachedSelection({
			path: view.file.path,
			title: view.file.basename,
			text: selected,
			lines: [from.line + 1, to.line + (to.ch > 0 ? 1 : 0)],
		});
		return true;
	}

	return (
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
			</h1> : <ExecutionView app={services.app} execution={execution} liveRequest={liveRequest}
				history={visibleHistory} loading={loading} conversationId={conversationId} />}
			<ApprovalView approval={approval} />
			{!landing && <ChatNavigation conversations={conversations} conversationId={conversationId} disabled={loading || busy}
				onSelect={(id) => void switchConversation(id)} onNew={() => void switchConversation()} />}
			<TaskInput
				busy={busy}
				disabled={loading}
				conversationId={conversationId}
				context={{
					app: services.app, refs, selection: attachedSelection, onAdd: addRef,
					onRemove: (path) => setRefs((previous) => previous.filter((ref) => ref.path !== path)),
					onAttachSelection: attachSelection, onRemoveSelection: () => setAttachedSelection(null),
				}}
				destination={providerLabel && selection.model ? `${providerLabel} · ${selection.model}` : ''}
				error={error}
				instruction={instruction}
				onChange={setInstruction}
				onFocus={() => { if (!busy) refreshSelection(); }}
				onSubmit={(instruction) => void perform(instruction)}
				onResume={!busy && !loading && !attachedSelection && resumable ? () => void perform('', resumable) : undefined}
				onStop={stop}
				onRetryConnection={execution.modelRetry === 'manual' ? () => active.current?.retryConnection?.() : undefined}
			/>
			{landing && conversations.length > 0 && <section className="scribe-chat-recents" aria-label={text.chatRecentConversations}>
				<h2>{text.chatRecentConversations}</h2>
				<ConversationList conversations={conversations} disabled={busy} onSelect={(id) => void switchConversation(id)} />
			</section>}
		</div>
	);
}
