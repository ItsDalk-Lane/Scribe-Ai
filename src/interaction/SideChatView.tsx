import { ItemView } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SIDE_CHAT_ICON, SIDE_CHAT_VIEW_TYPE } from '../constants';
import type ScribeAiPlugin from '../main';
import { chatModelKey } from '../orchestration/settings/thinking';
import type { NoteRef, RunContext, SavedRun, SideChat, SkillMention } from '../types';
import { composerShortcut } from './composerKeyboard';
import { exportSlash, showSlashMcp, showSlashWarnings } from './slashActions';
import { tr } from './skills/dialog';
import ExecutionView from './components/ExecutionView';
import { MetricPopoverProvider } from './components/MetricPopover';
import TaskInput from './components/TaskInput';
import { emptyExecution, updateExecution } from './context';
import type { DisplayedRun } from './context';
import { uiText } from './uiText';
import { useChatModel } from './useChatModel';

export interface SideChatOpening {
	prompt?: string;
	refs?: NoteRef[];
	quotes?: string[];
	skillMentions?: SkillMention[];
	skillScope?: string[];
}

interface SideChatHandle {
	check(opening: SideChatOpening): void;
	receive(opening: SideChatOpening): void;
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
	const thinking = model ? communication.models.thinkingOptions(model,
		(value === localValue ? localEffort : undefined) ?? settings.thinkingByModel[value]) : { levels: [] };
	const [draft, setDraft] = useState('');
	const [skillMentions, setSkillMentions] = useState<SkillMention[]>([]);
	const [parentScope, setParentScope] = useState<string[]>();
	const [refs, setRefs] = useState<NoteRef[]>([]);
	const skills = plugin.services.orchestration.skills;
	const draftScope = parentScope && [...new Set([...parentScope, ...skills.scope(refs, '')])];
	const [quotes, setQuotes] = useState<string[]>([]);
	const [error, setError] = useState('');
	const [history, setHistory] = useState<DisplayedRun[]>([]);
	const [execution, setExecution] = useState(emptyExecution);
	const [live, setLive] = useState<Pick<DisplayedRun, 'request' | 'model'>>();
	const input = useRef<HTMLTextAreaElement>(null);
	const mounted = useRef(false);
	const running = useRef(false);
	function requireModel() {
		if (!model || !settings.providerModels[model.providerId]?.includes(model.model)) {
			throw new SideChatHandoffError(text.chatModelMissing);
		}
		return model;
	}
	function submit(question: string, references: NoteRef[], excerpts: string[], mentions: SkillMention[], scope?: string[]) {
		if (running.current) throw new SideChatHandoffError(text.sideChatBusy);
		const selectedModel = requireModel();
		let displayed = emptyExecution;
		const run = chat.submit({ instruction: question, refs: references, chatQuotes: excerpts,
			skillMentions: mentions, skillScope: scope ?? skills.scope(references),
			model: { ...selectedModel, reasoning: thinking.level } }, { onEvent: (event) => {
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
	}

	function check({ prompt = '', refs = [], quotes = [] }: SideChatOpening) {
		if (running.current && (prompt.trim() || refs.length || quotes.length)) throw new SideChatHandoffError(text.sideChatBusy);
		if (prompt.trim()) requireModel();
	}

	useImperativeHandle(handoff, () => ({
		check,
		receive(opening) {
			check(opening);
			const { prompt = '', refs: incomingRefs = [], quotes: incomingQuotes = [] } = opening;
			if (opening.skillScope) setParentScope(opening.skillScope);
			if (prompt.trim()) {
				submit(prompt, incomingRefs, incomingQuotes, opening.skillMentions ?? [], opening.skillScope);
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
		<div className="scribe-app scribe-side-chat" data-layout="conversation" onKeyDown={(event) => {
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
				}} onSubmit={(question, mentions, scope) => {
					if (!question.trim()) return;
					try {
						submit(question, refs, quotes, mentions, scope);
						setDraft('');
						setSkillMentions([]);
						setQuotes([]);
						setRefs((previous) => previous.filter(({ addedExternal }) => !addedExternal));
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
	private parentId?: string;
	private handoff: RefObject<SideChatHandle | null> = { current: null };

	constructor(leaf: WorkspaceLeaf, private plugin: ScribeAiPlugin) {
		super(leaf);
	}

	override getViewType() { return SIDE_CHAT_VIEW_TYPE; }
	override getDisplayText() { return uiText().sideChatTitle; }
	override getIcon() { return SIDE_CHAT_ICON; }

	belongsTo(conversationId: string) { return this.parentId === conversationId; }

	showChat(chat: SideChat, parentId: string, initialModel?: RunContext['model']) {
		this.chat = chat;
		this.parentId = parentId;
		this.root = createRoot(this.contentEl);
		flushSync(() => this.root?.render(<SideChatPanel plugin={this.plugin} chat={chat} handoff={this.handoff}
			initialModel={initialModel} onClose={() => this.leaf.detach()} />));
	}

	async receiveDraft(opening: SideChatOpening) {
		this.handoff.current?.check(opening);
		await this.app.workspace.revealLeaf(this.leaf);
		const handoff = this.handoff.current;
		if (!handoff) throw new Error(uiText().sideChatOpenFailed);
		handoff.receive(opening);
	}

	override async onClose() {
		this.chat?.close();
		this.chat = undefined;
		this.parentId = undefined;
		this.root?.unmount();
		this.root = undefined;
	}
}

export async function openSideChat(plugin: ScribeAiPlugin, parentId: string, parentRuns: SavedRun[], opening: SideChatOpening, model?: RunContext['model']) {
	const workspace = plugin.app.workspace;
	const existing = workspace.getLeavesOfType(SIDE_CHAT_VIEW_TYPE).find(({ view }) => view instanceof SideChatView && view.belongsTo(parentId));
	if (existing?.view instanceof SideChatView) {
		await existing.view.receiveDraft(opening);
		return;
	}
	const leaf = workspace.getRightLeaf(false);
	if (!leaf) throw new Error(uiText().sideChatOpenFailed);
	try {
		await leaf.setViewState({ type: SIDE_CHAT_VIEW_TYPE, active: true });
		await leaf.loadIfDeferred();
		if (!(leaf.view instanceof SideChatView)) throw new Error(uiText().sideChatOpenFailed);
		leaf.view.showChat(plugin.services.orchestration.sessions.createSideChat(parentRuns), parentId, model);
		await leaf.view.receiveDraft(opening);
	} catch (error) {
		leaf.detach();
		throw error;
	}
}
