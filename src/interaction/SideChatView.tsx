import { ItemView } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SIDE_CHAT_ICON, SIDE_CHAT_VIEW_TYPE } from '../constants';
import type ScribeAiPlugin from '../main';
import { isModelAvailable } from '../orchestration/settings/modelAvailability';
import { chatModelKey, chatReasoningForRequest } from '../orchestration/settings/thinking';
import type { NoteRef, QueuedMessage, RunContext, SavedRun, SideChat, SkillMention } from '../types';
import { composerShortcut } from './composerKeyboard';
import { exportSlash, showSlashMcp, showSlashWarnings } from './slashActions';
import { tr } from './skills/dialog';
import ExecutionView from './components/ExecutionView';
import { chatStatusBarSpace } from './components/chatStatusBarSpace';
import { MetricPopoverProvider } from './components/MetricPopover';
import TaskInput from './components/TaskInput';
import { emptyExecution, updateExecution } from './context';
import type { DisplayedRun } from './context';
import { uiText } from './uiText';
import { useChatModel } from './useChatModel';
import { imageLinkSource } from './composerImages';
import { draftImagePaths, retainDraftImages, retainedImagePaths } from '../orchestration/storage/retainedImages';
import { removeConversationSpills } from '../tools/support/spillCleanup';
import { isImageFile } from '../tools/support/imageData';

export interface SideChatOpening {
	prompt?: string;
	queued?: Pick<QueuedMessage, 'destination'>;
	imageSourcePath?: string;
	refs?: NoteRef[];
	quotes?: string[];
	skillMentions?: SkillMention[];
	skillScope?: string[];
	skillNotePaths?: string[];
}

interface SideChatHandle {
	check(opening: SideChatOpening): void;
	receive(opening: SideChatOpening): Promise<void>;
}

export class SideChatHandoffError extends Error {}

function SideChatPanel({ plugin, chat, handoff, onClose, initialModel }: {
	plugin: ScribeAiPlugin; chat: SideChat; handoff: RefObject<SideChatHandle | null>; onClose: () => void;
	initialModel?: RunContext['model'];
}) {
	const text = uiText();
	const { settings, communication } = plugin.services;
	const modelOptions = useChatModel(plugin);
	const [localValue, setLocalValue] = useState(() => initialModel ? chatModelKey(initialModel.providerId, initialModel.model) : '');
	const [localEffort, setLocalEffort] = useState(initialModel?.reasoning === null ? 'off' : initialModel?.reasoning);
	const value = modelOptions.groups.some(({ models }) => models.some((entry) => entry.value === localValue))
		? localValue : modelOptions.value;
	const group = modelOptions.groups.find(({ models }) => models.some((entry) => entry.value === value));
	const choice = group?.models.find((entry) => entry.value === value);
	const model = group && choice ? { providerId: group.id, model: choice.id } : undefined;
	const preferredEffort = (value === localValue ? localEffort : undefined) ?? settings.thinkingByModel[value];
	const thinking = model ? communication.models.thinkingOptions(model, preferredEffort) : { levels: [] };
	const [draft, setDraft] = useState('');
	const [skillMentions, setSkillMentions] = useState<SkillMention[]>([]);
	const [parentScope, setParentScope] = useState(chat.skillScope);
	const [refs, setRefs] = useState<NoteRef[]>([]);
	const skills = plugin.services.orchestration.skills;
	const draftScope = parentScope && [...new Set([...parentScope, ...skills.scope(refs, '')])];
	const [quotes, setQuotes] = useState<string[]>([]);
	const [error, setError] = useState('');
	const [history, setHistory] = useState<DisplayedRun[]>([]);
	const [execution, setExecution] = useState(emptyExecution);
	const [live, setLive] = useState<Pick<DisplayedRun, 'request' | 'model'>>();
	const store = plugin.services.orchestration.conversations;
	useLayoutEffect(() => retainDraftImages(store, chat.id, [
		...history.flatMap(({ request }) => request.refs), ...(live?.request.refs ?? []),
	]), [store, chat.id, history, live]);
	const input = useRef<HTMLTextAreaElement>(null);
	const mounted = useRef(false);
	const running = useRef(false);
	function requireModel() {
		if (!model || !isModelAvailable(settings, model, communication.models.modelType)) {
			throw new SideChatHandoffError(text.chatModelMissing);
		}
		return model;
	}
	function submit(question: string, references: NoteRef[], excerpts: string[], mentions: SkillMention[], scope?: string[], skillNotePaths?: string[], imageSourcePath?: string,
		queued?: SideChatOpening['queued']) {
		if (running.current) throw new SideChatHandoffError(text.sideChatBusy);
		const selectedModel = requireModel();
		let displayed = emptyExecution;
		const run = chat.submit({ instruction: question, refs: references, chatQuotes: excerpts,
			imageSourcePath: imageLinkSource(plugin.app, question, imageSourcePath),
			skillMentions: mentions, skillScope: scope, skillNotePaths,
			model: { ...selectedModel, reasoning: chatReasoningForRequest(thinking, preferredEffort) }, queued }, { onEvent: (event) => {
			if (!mounted.current) return;
			displayed = updateExecution(displayed, event);
			setExecution(displayed);
		} });
		running.current = true;
		setError('');
		setLive({ request: run.request, model: run.model });
		void run.result.then((state) => {
			if (!mounted.current) return;
			const saved = updateExecution(displayed, { type: 'state', state });
			setHistory((previous) => [...previous, { request: run.request, model: run.model, state, displayed: saved }]);
		}).catch((cause: unknown) => {
			if (mounted.current) setError(cause instanceof Error ? cause.message : text.chatFailed);
		}).finally(() => {
			running.current = false;
			if (mounted.current) {
				setLive(undefined);
				setExecution(emptyExecution);
			}
		});
		return run.prepared;
	}

	function check({ prompt = '', refs = [], quotes = [] }: SideChatOpening) {
		if (running.current && (prompt.trim() || refs.length || quotes.length)) throw new SideChatHandoffError(text.sideChatBusy);
		if (prompt.trim()) requireModel();
	}

	useImperativeHandle(handoff, () => ({
		check,
		async receive(opening) {
			check(opening);
			const { prompt = '', refs: incomingRefs = [], quotes: incomingQuotes = [] } = opening;
			if (opening.skillScope) setParentScope(opening.skillScope);
			if (prompt.trim()) {
				try {
					await submit(prompt, incomingRefs, incomingQuotes, opening.skillMentions ?? [], opening.skillScope, opening.skillNotePaths, opening.imageSourcePath, opening.queued);
				} catch (cause) {
					if (cause instanceof Error) throw new SideChatHandoffError(cause.message);
					throw cause;
				}
			} else {
				if (incomingRefs.length) setRefs((previous) => Array.from(
					new Map([...previous, ...incomingRefs].map((ref) => [ref.path, ref])).values()));
				if (incomingQuotes.length) setQuotes((previous) => Array.from(new Set([...previous, ...incomingQuotes])));
			}
			input.current?.focus({ preventScroll: true });
		},
	}));

	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);

	return <MetricPopoverProvider>
		<div ref={chatStatusBarSpace} className="scribe-app scribe-side-chat" data-layout="conversation" onKeyDown={(event) => {
			if (!running.current || event.defaultPrevented || composerShortcut(event.nativeEvent) !== 'escape') return;
			event.preventDefault();
			event.stopPropagation();
			chat.stop();
		}}>
			<ExecutionView app={plugin.app} skills={skills} conversationId={chat.id} loading={false} history={history}
				execution={execution} liveRequest={live?.request} liveModel={live?.model} temporary />
			<TaskInput inputRef={input} busy={Boolean(live)} disabled={false} conversationId={chat.id}
				slashCommands={{ surface: 'side', unavailable: (name) => running.current && ['export', 'skills'].includes(name)
					? tr('侧聊回答结束后可用。', 'Available after the side conversation finishes.') : undefined,
					run: async ({ name, args }, controls) => {
						switch (name) {
							case 'skills': return controls.openSkills();
							case 'mcp': return showSlashMcp(plugin, controls.ui);
							case 'export': return exportSlash(plugin.app, history, args, text.sideChatTitle, controls.ui);
							case 'warnings': return showSlashWarnings(plugin, controls.ui);
							default: return false;
						}
					},
				}}
				skills={skills} skillScope={draftScope} skillMentions={skillMentions}
				vaultOnly placeholder={text.sideChatPlaceholder} modelGroups={modelOptions.groups} modelValue={value} thinking={thinking}
				context={{
					app: plugin.app, refs, quotes, conversationStore: plugin.services.orchestration.conversations,
					onAdd: (ref) => {
						if (running.current) return;
						setRefs((previous) => previous.some(({ path }) => path === ref.path) ? previous : [...previous, ref]);
					},
					onAddQuote: (quote) => {
						if (!running.current) setQuotes((previous) => previous.includes(quote) ? previous : [...previous, quote]);
					},
					onRemove: (path) => setRefs((previous) => previous.filter((ref) => ref.path !== path)),
					onRemoveQuotes: (removed) => setQuotes((previous) => previous.filter((quote) => !removed.includes(quote))),
				}}
				onModelChange={(next) => {
					if (next !== value) {
						setLocalValue(next);
						setLocalEffort(undefined);
					}
					return Promise.resolve(true);
				}}
				onThinkingChange={(level) => { setLocalValue(value); setLocalEffort(level); }}
				error={error} instruction={draft} onChange={(value, mentions, scope) => {
					setDraft(value); setSkillMentions(mentions);
					if (scope) setParentScope(scope);
				}} onSubmit={async (question, mentions, scope) => {
					if (!question.trim()) return;
					try {
						await submit(question, refs, quotes, mentions, scope);
						if (!mounted.current) return;
						setDraft((previous) => previous === draft ? '' : previous);
						setSkillMentions((previous) => previous === skillMentions ? [] : previous);
						setQuotes((previous) => previous === quotes ? [] : previous);
						setRefs((previous) => previous.filter(({ addedExternal, path, kind }) => !addedExternal && (kind === 'folder' || !isImageFile(path))));
					} catch (cause) {
						setError(cause instanceof Error ? cause.message : text.chatFailed);
					}
				}}
				onStop={() => chat.stop()} onClose={onClose}
			/>
		</div>
	</MetricPopoverProvider>;
}

export class SideChatView extends ItemView {
	private root?: ReturnType<typeof createRoot>;
	private chat?: SideChat;
	private handoff: RefObject<SideChatHandle | null> = { current: null };

	constructor(leaf: WorkspaceLeaf, private plugin: ScribeAiPlugin) {
		super(leaf);
	}

	override getViewType() { return SIDE_CHAT_VIEW_TYPE; }
	override getDisplayText() { return uiText().sideChatTitle; }
	override getIcon() { return SIDE_CHAT_ICON; }

	showChat(chat: SideChat, initialModel?: RunContext['model']) {
		this.chat = chat;
		this.root = createRoot(this.contentEl);
		flushSync(() => this.root?.render(<SideChatPanel plugin={this.plugin} chat={chat} handoff={this.handoff}
			initialModel={initialModel} onClose={() => this.leaf.detach()} />));
	}

	async receiveDraft(opening: SideChatOpening) {
		this.handoff.current?.check(opening);
		await this.app.workspace.revealLeaf(this.leaf);
		const handoff = this.handoff.current;
		if (!handoff) throw new Error(uiText().sideChatOpenFailed);
		await handoff.receive(opening);
	}

	override async onClose() {
		const store = this.plugin.services.orchestration.conversations;
		const id = this.chat?.id;
		const images = id && draftImagePaths(store, id);
		this.chat?.close();
		this.chat = undefined;
		this.plugin.conversationViews.sideChatParents.delete(this.leaf);
		this.root?.unmount();
		this.root = undefined;
		if (id && images) await removeConversationSpills(this.plugin.services.paths.cache, id, images, () => retainedImagePaths(store, id));
	}
}

export async function openSideChat(plugin: ScribeAiPlugin, parentId: string, parentRuns: SavedRun[], opening: SideChatOpening, model?: RunContext['model']) {
	const workspace = plugin.app.workspace;
	const { sideChatParents } = plugin.conversationViews;
	const existing = [...sideChatParents].find(([, id]) => id === parentId)?.[0];
	if (existing) {
		if (!(existing.view instanceof SideChatView)) throw new SideChatHandoffError(uiText().sideChatBusy);
		await existing.view.receiveDraft(opening);
		return;
	}
	const leaf = workspace.getRightLeaf(false);
	if (!leaf) throw new Error(uiText().sideChatOpenFailed);
	sideChatParents.set(leaf, parentId);
	try {
		await leaf.setViewState({ type: SIDE_CHAT_VIEW_TYPE, active: true });
		await leaf.loadIfDeferred();
		if (!(leaf.view instanceof SideChatView)) throw new Error(uiText().sideChatOpenFailed);
		const { sessions, conversations } = plugin.services.orchestration;
		const { manualCompaction } = await conversations.load(parentId);
		if (!sideChatParents.has(leaf)) throw new Error(uiText().sideChatOpenFailed);
		leaf.view.showChat(sessions.createSideChat(parentRuns, manualCompaction), model);
		await leaf.view.receiveDraft(opening);
	} catch (error) {
		if (sideChatParents.delete(leaf)) leaf.detach();
		throw error;
	}
}
