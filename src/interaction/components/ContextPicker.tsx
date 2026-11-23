import { basename, isAbsolute } from 'node:path';
import { Platform, TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import type { ConversationStore, ConversationSummary, NoteRef } from '../../types';
import { composerShortcut, isImeComposing, referenceQuery, removeReferenceQuery } from '../composerKeyboard';
import { conversationReference, conversationReferenceTitle } from '../conversationReference';
import { externalReferenceAt, pickExternalReference } from '../externalReferencePicker';
import type { ExternalReferenceMode } from '../externalReferencePicker';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';
import { useComposerPopoverPosition } from './useComposerPopoverPosition';

export interface ContextPickerProps {
	app: App;
	conversationStore: Pick<ConversationStore, 'list' | 'load'>;
	conversationIndex?: ConversationSummary[];
	refs: NoteRef[];
	quotes?: string[];
	disabled: boolean;
	onAdd: (ref: NoteRef) => void;
	onAddQuote: (quote: string) => void;
	onRemove: (path: string) => void;
	onRemoveQuotes: (quotes: string[]) => void;
	onFocusInput?: () => void;
}

export function ContextChips({ refs, quotes, disabled, onRemove, onRemoveQuotes, onFocusInput }: Pick<
	ContextPickerProps, 'refs' | 'quotes' | 'disabled' | 'onRemove' | 'onRemoveQuotes' | 'onFocusInput'
>) {
	const text = uiText();
	if (!quotes?.length && refs.length === 0) return null;
	const historyQuotes = quotes?.flatMap((quote) => {
		const title = conversationReferenceTitle(quote);
		return title ? [{ title, quotes: [quote], history: true }] : [];
	}) ?? [];
	const excerpts = quotes?.filter((quote) => !conversationReferenceTitle(quote)) ?? [];
	const quoteGroups = excerpts.length ? [
		{ title: text.chatQuotedText.replace('{n}', String(excerpts.length)), quotes: excerpts, history: false }, ...historyQuotes,
	] : historyQuotes;
	return (
		<ul className="scribe-context-chips" aria-label={text.chatContextLabel}>
			{quoteGroups.map((group) => <li key={group.history ? group.quotes[0] : 'excerpts'} className="scribe-context-chip scribe-chat-quote-chip">
				<details className="scribe-selection-preview">
					<summary><ChatIcon name={group.history ? 'message-circle' : 'quote'} />{group.title}</summary>
					<pre className="scribe-chat-pre" tabIndex={0} aria-label={text.chatSelectionPreview}>{group.quotes.join('\n\n')}</pre>
				</details>
				<button type="button" className="scribe-context-chip-remove" aria-label={group.history ? `${text.remove} ${group.title}` : text.chatRemoveQuotes}
					disabled={disabled} onClick={() => {
						onFocusInput?.();
						onRemoveQuotes(group.quotes);
					}}><ChatIcon name="x" /></button>
			</li>)}
			{refs.map((ref) => {
				const label = `${text.remove} ${ref.path}`;
				return (
					<li className="scribe-context-chip" key={ref.path}>
						<ChatIcon name={ref.kind === 'folder' ? 'folder' : 'file-text'} />
						<span className="scribe-context-name" title={ref.path}>
							{isAbsolute(ref.path) ? ref.path : basename(ref.path) || ref.path}
						</span>
						<button
							type="button"
							className="scribe-context-chip-remove"
							aria-label={label}
							title={label}
							disabled={disabled}
							onClick={(event) => {
								const chip = event.currentTarget.closest('li');
								const neighbor = chip?.nextElementSibling ?? chip?.previousElementSibling;
								const removeButton = neighbor?.querySelector<HTMLButtonElement>('.scribe-context-chip-remove:not(:disabled)');
								if (removeButton) removeButton.focus({ preventScroll: true });
								else onFocusInput?.();
								onRemove(ref.path);
							}}
						><ChatIcon name="x" /></button>
					</li>
				);
			})}
		</ul>
	);
}

export interface ReferenceSuggestionOptions extends Pick<ContextPickerProps, 'app' | 'conversationStore' | 'conversationIndex' | 'onAdd' | 'onAddQuote' | 'disabled'> {
	conversationId: string | null;
	vaultOnly?: boolean;
}

export interface ReferenceLauncher {
	id: string;
	open: boolean;
	close: () => void;
}

interface ReferenceChoice {
	key: string;
	label: string;
	detail?: string;
	icon: string;
	select: () => void;
}

function referenceRank({ label, detail }: ReferenceChoice, needle: string) {
	const name = label.toLocaleLowerCase();
	if (name === needle) return 4;
	if (name.startsWith(needle)) return 3;
	if (name.includes(needle)) return 2;
	return detail?.toLocaleLowerCase().includes(needle) ? 1 : 0;
}

export function useReferenceSuggestions({ options, launcher, inputRef, instruction, caret, onComplete }: {
	options?: ReferenceSuggestionOptions;
	launcher?: ReferenceLauncher;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	instruction: string;
	caret: number | null;
	onComplete: (instruction: string, caret: number) => void;
}) {
	const text = uiText();
	const { app, conversationStore, conversationIndex, conversationId, onAdd, onAddQuote, vaultOnly } = options ?? {};
	const manual = launcher?.open === true;
	const range = !manual && caret !== null ? referenceQuery(instruction, caret) : undefined;
	const search = useRef<HTMLInputElement>(null);
	const popover = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const pending = useRef<{ native: boolean } | null>(null);
	const generatedId = useId();
	const id = launcher?.id ?? generatedId;
	const [category, setCategory] = useState<'all' | 'vault'>('all');
	const [manualQuery, setManualQuery] = useState('');
	const [selection, setSelection] = useState<{ query: string; index: number }>();
	const [dismissed, setDismissed] = useState<{ instruction: string; caret: number | null }>();
	const [history, setHistory] = useState<ConversationSummary[]>();
	const [historyFailed, setHistoryFailed] = useState(false);
	const [selectionError, setSelectionError] = useState('');
	const [busy, setBusy] = useState(false);
	const [outside, setOutside] = useState<ExternalReferenceMode>();
	const menuOpen = Boolean(options && !options.disabled && (manual || range
		&& (dismissed?.instruction !== instruction || dismissed.caret !== caret)));
	const typedDraft = range ? instruction : undefined;
	const typedCaret = range?.end;

	useLayoutEffect(() => {
		setBusy(false);
		setSelectionError('');
		return () => { pending.current = null; };
	}, [menuOpen, manual, typedDraft, typedCaret]);
	useEffect(() => {
		if (menuOpen) return;
		setCategory('all');
		setManualQuery('');
		setSelection(undefined);
		setOutside(undefined);
	}, [menuOpen]);
	useEffect(() => setDismissed(undefined), [instruction, caret]);
	useEffect(() => {
		if (!menuOpen || conversationIndex || !conversationStore) return;
		let current = true;
		setHistory(undefined);
		setHistoryFailed(false);
		void conversationStore.list().then((rows) => {
			if (current) setHistory(rows);
		}, () => {
			if (current) setHistoryFailed(true);
		});
		return () => { current = false; };
	}, [menuOpen, conversationIndex, conversationStore]);
	useEffect(() => {
		if (menuOpen && manual && !outside) search.current?.focus({ preventScroll: true });
	}, [menuOpen, manual, category, outside]);
	useComposerPopoverPosition(popover, menuOpen, true);

	function dismiss(focus = false) {
		pending.current = null;
		if (range) setDismissed({ instruction, caret });
		launcher?.close();
		if (focus) inputRef.current?.focus({ preventScroll: true });
	}

	function complete(ref?: NoteRef) {
		if (ref) onAdd?.(ref);
		dismiss(true);
		if (range) {
			const next = removeReferenceQuery(instruction, range);
			onComplete(next.instruction, next.caret);
		}
	}

	function changeCategory(next: typeof category) {
		setCategory(next);
		setManualQuery('');
		setSelection(undefined);
		setSelectionError('');
	}

	async function quoteChat(conversation: ConversationSummary) {
		if (!conversationStore || pending.current) return;
		const token = { native: false };
		pending.current = token;
		setBusy(true);
		setSelectionError('');
		try {
			const snapshot = await conversationStore.load(conversation.id);
			if (pending.current !== token) return;
			const quote = conversationReference(conversation.title || text.chatUntitled, snapshot.runs);
			if (!quote) {
				setSelectionError(text.chatNoReferenceText);
				return;
			}
			onAddQuote?.(quote);
			complete();
		} catch {
			if (pending.current === token) setSelectionError(text.chatHistoryError);
		} finally {
			if (pending.current === token) {
				pending.current = null;
				setBusy(false);
			}
		}
	}

	async function pickOutside(mode: ExternalReferenceMode, title: string) {
		const document = inputRef.current?.ownerDocument;
		if (!document || pending.current) return;
		const token = { native: true };
		pending.current = token;
		setBusy(true);
		let ref: NoteRef | null;
		try {
			ref = await pickExternalReference(document, mode, title);
		} catch {
			if (pending.current === token) {
				pending.current = null;
				setBusy(false);
				setOutside(mode);
			}
			return;
		}
		if (pending.current === token) {
			if (ref) complete(ref);
			else dismiss(true);
		}
	}

	const query = manual ? manualQuery : range?.term ?? '';
	const needle = query.trim().toLocaleLowerCase();
	const browsing = category !== 'all' || Boolean(needle);
	const chats = conversationIndex ?? history;
	const choices: ReferenceChoice[] = [];
	if (menuOpen && !outside) {
		if (browsing && app) {
			const configDir = app.vault.configDir;
			for (const item of app.vault.getAllLoadedFiles()) {
				if (item.path === '/' || item.path === configDir || item.path.startsWith(`${configDir}/`)) continue;
				if (item instanceof TFile || item instanceof TFolder) {
					const kind = item instanceof TFolder ? 'folder' : 'file';
					choices.push({ key: item.path, label: item.name, detail: item.path !== item.name ? item.path : undefined,
						icon: kind === 'folder' ? 'folder' : 'file-text', select: () => complete({ path: item.path, kind }) });
				}
			}
		} else if (!browsing) {
			choices.push({ key: 'vault', label: text.chatVaultReference, icon: 'folder-open', select: () => changeCategory('vault') });
			if (!vaultOnly) {
				const external = (mode: ExternalReferenceMode, label: string, icon: string) => ({
					key: mode, label, icon, select: () => void pickOutside(mode, label),
				});
				if (Platform.isMacOS) choices.push(external('path', text.chatAddExternalPath, 'folder-plus'));
				else choices.push(external('file', text.chatPickExternalFile, 'file-text'), external('folder', text.chatPickExternalFolder, 'folder'));
			}
		}
		if (category === 'all') {
			for (const chat of chats ?? []) {
				if (chat.archived || chat.id === conversationId) continue;
				choices.push({ key: `chat:${chat.id}`, label: chat.title || text.chatUntitled,
					detail: new Date(chat.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }),
					icon: 'message-circle', select: () => void quoteChat(chat) });
			}
		}
	}
	const rows = (needle ? choices.map((choice) => ({ choice, rank: referenceRank(choice, needle) }))
		.filter(({ rank }) => rank).sort((a, b) => b.rank - a.rank).map(({ choice }) => choice) : choices).slice(0, 40);
	const active = Math.min(selection?.query === query ? selection.index : 0, rows.length - 1);
	const activeKey = rows[active]?.key;
	useEffect(() => {
		if (activeKey) list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [activeKey]);
	const searchLabel = category === 'vault' ? text.chatPickVaultItem : text.chatSearchReferences;
	const showHistoryStatus = category === 'all' && !chats;
	const activeId = active >= 0 && !busy ? `${id}-${active}` : undefined;

	function onKeyDown(event: KeyboardEvent<HTMLElement>): boolean {
		if (!menuOpen || event.defaultPrevented || isImeComposing(event.nativeEvent)) return false;
		if (composerShortcut(event.nativeEvent) === 'escape') {
			event.preventDefault();
			event.stopPropagation();
			dismiss(true);
			return true;
		}
		if (outside || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
			|| (event.target !== inputRef.current && event.target !== search.current)) return false;
		if (event.key === 'Enter' || (event.key === 'Tab' && !manual && active >= 0 && !busy)) {
			event.preventDefault();
			if (!busy && !event.repeat) rows[active]?.select();
		} else if (rows.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			if (!busy) setSelection({ query, index: (active + step + rows.length) % rows.length });
		} else return false;
		return true;
	}

	return {
		visible: menuOpen,
		optionsId: menuOpen && !outside ? `${id}-options` : undefined,
		activeId,
		dismiss,
		onKeyDown,
		keepOnBlur: () => pending.current?.native === true,
		menu: menuOpen && <div ref={popover} className="scribe-context-popover scribe-reference-menu" id={id}
			role="group" aria-label={text.chatAddContext}>
			{outside ? <ExternalPathFallback mode={outside} onAdd={complete} /> : <>
				{(manual || category !== 'all') && <div className="scribe-reference-search">
					{category !== 'all' && <button type="button" aria-label={text.back} disabled={busy}
						onMouseDown={(event) => event.preventDefault()} onClick={() => changeCategory('all')}>
						<ChatIcon name="arrow-left" />
					</button>}
					{manual && <input ref={search} type="text" role="combobox" aria-autocomplete="list" aria-expanded={true}
						aria-controls={`${id}-options`} aria-activedescendant={activeId}
						aria-label={searchLabel} placeholder={searchLabel} value={manualQuery} readOnly={busy}
						onChange={(event) => {
							setManualQuery(event.currentTarget.value);
							setSelection(undefined);
							setSelectionError('');
						}} />}
				</div>}
				{selectionError && <p className="scribe-chat-error" role="alert">{selectionError}</p>}
				{showHistoryStatus ? <p className="scribe-chat-loading" role="status">
					{historyFailed ? text.chatHistoryError : text.chatLoadingHistory}
				</p> : !rows.length && <p className="scribe-chat-loading" role="status">{text.chatNoReferences}</p>}
				<div ref={list} id={`${id}-options`} role="listbox" aria-label={searchLabel}>
					{rows.map((row, index) => <button key={row.key} type="button" role="option" id={`${id}-${index}`} tabIndex={-1}
						aria-selected={active === index} disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={row.select}>
						<ChatIcon name={row.icon} /><span>{row.label}</span>{row.detail && <small>{row.detail}</small>}
					</button>)}
				</div>
			</>}
		</div>,
	};
}

function ExternalPathFallback({ mode, onAdd }: Pick<ContextPickerProps, 'onAdd'> & { mode: ExternalReferenceMode }) {
	const text = uiText();
	const [path, setPath] = useState('');
	const [invalidPath, setInvalidPath] = useState(false);
	const id = useId();
	const pathInput = useRef<HTMLInputElement>(null);
	useEffect(() => pathInput.current?.focus(), []);

	async function addPath() {
		const entered = path.trim();
		const input = pathInput.current;
		if (!entered || !input) return;
		input.focus();
		const firstCharacter = entered[0];
		const fullPath = firstCharacter && ['"', "'"].includes(firstCharacter) && entered.endsWith(firstCharacter)
			? entered.slice(1, -1)
			: entered;
		try {
			const ref = await externalReferenceAt(fullPath, mode);
			if (pathInput.current === input && input.value.trim() === entered) onAdd(ref);
		} catch {
			if (pathInput.current === input && input.value.trim() === entered) setInvalidPath(true);
		}
	}

	return (
		<div className="scribe-context-path">
			<div className="scribe-chat-error" role="alert" id={`${id}-failed`}>{text.chatExternalPickerFailed}</div>
			<input
				ref={pathInput}
				type="text"
				value={path}
				placeholder={text.chatAbsolutePath}
				aria-label={text.chatAbsolutePath}
				aria-invalid={invalidPath}
				aria-describedby={invalidPath ? `${id}-failed ${id}-error` : `${id}-failed`}
				onChange={(event) => {
					setPath(event.currentTarget.value);
					setInvalidPath(false);
				}}
				onKeyDown={(event) => {
					if (event.key !== 'Enter' || isImeComposing(event.nativeEvent)) return;
					event.preventDefault();
					if (composerShortcut(event.nativeEvent) === 'send') void addPath();
				}}
			/>
			<button type="button" disabled={!path.trim()} onClick={() => void addPath()}>{text.add}</button>
			{invalidPath && <div id={`${id}-error`} className="scribe-chat-error" role="alert">{text.chatInvalidPath}</div>}
		</div>
	);
}
