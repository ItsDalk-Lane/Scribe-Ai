import { basename, isAbsolute } from 'node:path';
import { FuzzySuggestModal, Platform, TFile, TFolder } from 'obsidian';
import type { App, TAbstractFile } from 'obsidian';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { NoteRef, NoteSelection } from '../../types';
import { composerShortcut, isImeComposing } from '../composerKeyboard';
import { externalReferenceAt, pickExternalReference } from '../externalReferencePicker';
import type { ExternalReferenceMode } from '../externalReferencePicker';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';

class VaultPicker extends FuzzySuggestModal<TAbstractFile> {
	constructor(app: App, private readonly choose: (ref: NoteRef) => void, private readonly didClose: () => void) {
		super(app);
		this.shouldRestoreSelection = false;
		this.setPlaceholder(uiText().chatPickVaultItem);
	}

	getItems(): TAbstractFile[] {
		return this.app.vault.getAllLoadedFiles().filter((item) => item.path !== '/' && (item instanceof TFile || item instanceof TFolder));
	}

	getItemText(item: TAbstractFile): string {
		return item.path;
	}

	onChooseItem(item: TAbstractFile): void {
		this.choose({ path: item.path, kind: item instanceof TFolder ? 'folder' : 'file' });
	}

	override onClose(): void {
		super.onClose();
		this.didClose();
	}
}

export interface ContextPickerProps {
	app: App;
	refs: NoteRef[];
	selection: NoteSelection | null;
	disabled: boolean;
	onAdd: (ref: NoteRef) => void;
	onRemove: (path: string) => void;
	onRemoveSelection: () => void;
	onFocusInput?: () => void;
}

export function useVaultPicker(app: App, onAdd: ContextPickerProps['onAdd']): (afterClose?: () => void) => void {
	const picker = useRef<VaultPicker | null>(null);
	useLayoutEffect(() => () => {
		const modal = picker.current;
		picker.current = null;
		if (modal?.containerEl.isConnected) modal.close();
	}, [app]);

	return (afterClose) => {
		if (picker.current) return;
		const doc = typeof activeDocument === 'undefined' ? document : activeDocument;
		const opener = doc.activeElement;
		const modal = new VaultPicker(app, onAdd, () => {
			queueMicrotask(() => {
				if (picker.current !== modal) return;
				picker.current = null;
				const openModals = doc.querySelectorAll('.modal-container');
				const topModal = openModals[openModals.length - 1];
				if (topModal && !topModal.contains(opener)) return;
				if (opener?.isConnected && doc.defaultView && opener.instanceOf(doc.defaultView.HTMLElement)) {
					opener.focus({ preventScroll: true });
				}
				afterClose?.();
			});
		});
		picker.current = modal;
		modal.open();
	};
}

export function ContextChips({ refs, selection, disabled, onRemove, onRemoveSelection, onFocusInput }: Pick<
	ContextPickerProps, 'refs' | 'selection' | 'disabled' | 'onRemove' | 'onRemoveSelection' | 'onFocusInput'
>) {
	const text = uiText();
	if (!selection && refs.length === 0) return null;
	return (
		<ul className="scribe-context-chips" aria-label={text.chatContextLabel}>
			{selection ? (
				<li className="scribe-context-chip">
					<details className="scribe-selection-preview">
						<summary title={selection.path}><ChatIcon name="text-select" />{selection.title}</summary>
						<pre className="scribe-chat-pre" tabIndex={0} aria-label={text.chatSelectionPreview}>{selection.text}</pre>
					</details>
					<button
						type="button"
						className="scribe-context-chip-remove"
						aria-label={text.chatRemoveSelection}
						title={text.chatRemoveSelection}
						disabled={disabled}
						onClick={() => {
							onFocusInput?.();
							onRemoveSelection();
						}}
					><ChatIcon name="x" /></button>
				</li>
			) : refs.map((ref) => {
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

interface ContextActionsProps extends Pick<ContextPickerProps, 'onAdd' | 'disabled'> {
	onPick: () => void;
	onFocusInput: () => void;
}

type ContextMenu = 'closed' | 'open' | 'outside' | 'picking' | ExternalReferenceMode;

export function ContextActions({ onPick, onAdd, disabled, onFocusInput }: ContextActionsProps) {
	const text = uiText();
	const trigger = useRef<HTMLButtonElement>(null);
	const pending = useRef<symbol | null>(null);
	const id = useId();
	const [menu, setMenu] = useState<ContextMenu>('closed');
	const menuOpen = menu !== 'closed' && !disabled;
	const externalOpen = !Platform.isMacOS && menu !== 'open' && menuOpen;

	useLayoutEffect(() => () => { pending.current = null; }, [disabled]);
	useEffect(() => setMenu('closed'), [disabled]);

	function complete(ref?: NoteRef) {
		if (ref) onAdd(ref);
		setMenu('closed');
		onFocusInput();
	}

	async function pickOutside(mode: ExternalReferenceMode, title: string) {
		const document = trigger.current?.ownerDocument;
		if (!document || disabled || pending.current) return;
		const token = Symbol();
		pending.current = token;
		setMenu('picking');
		let ref: NoteRef | null;
		try {
			ref = await pickExternalReference(document, mode, title);
		} catch {
			if (pending.current === token) {
				pending.current = null;
				setMenu(mode);
			}
			return;
		}
		if (pending.current === token) {
			pending.current = null;
			complete(ref ?? undefined);
		}
	}

	return (
		<div className="scribe-context-actions" onBlur={(event) => {
			if (menuOpen && !pending.current && !event.currentTarget.contains(event.relatedTarget)) setMenu('closed');
		}} onKeyDown={(event) => {
			if (!menuOpen || event.defaultPrevented || composerShortcut(event.nativeEvent) !== 'escape') return;
			event.preventDefault();
			event.stopPropagation();
			if (pending.current) return;
			setMenu('closed');
			trigger.current?.focus({ preventScroll: true });
		}}>
			<button type="button" ref={trigger} className="scribe-compose-action" disabled={disabled || menu === 'picking'}
				aria-label={text.chatAddContext} title={text.chatAddContext}
				aria-expanded={menuOpen} aria-controls={menuOpen ? id : undefined}
				onClick={(event) => {
					event.currentTarget.focus({ preventScroll: true });
					setMenu(menuOpen ? 'closed' : 'open');
				}}><ChatIcon name="plus" /></button>
			{menuOpen && <div className="scribe-context-popover" id={id} role="group" aria-label={text.chatAddContext}>
				<button type="button" disabled={menu === 'picking'} onClick={() => {
					setMenu('closed');
					onPick();
				}}>
					<ChatIcon name="folder-open" />
					<span>{text.chatVaultReference}</span>
				</button>
				<button type="button" disabled={menu === 'picking'} aria-expanded={Platform.isMacOS ? undefined : externalOpen}
					aria-controls={externalOpen ? `${id}-outside` : undefined}
					onClick={() => {
						if (Platform.isMacOS) void pickOutside('path', text.chatAddExternalPath);
						else setMenu(externalOpen ? 'open' : 'outside');
					}}>
					<ChatIcon name="folder-plus" />
					<span>{text.chatAddExternalPath}</span>
					{!Platform.isMacOS && <ChatIcon name={externalOpen ? 'chevron-down' : 'chevron-right'} />}
				</button>
				{menu === 'path' && <ExternalPathFallback mode={menu} onAdd={complete} />}
				{externalOpen && <div className="scribe-context-outside" id={`${id}-outside`}>
					<button type="button" disabled={menu === 'picking'} onClick={() => void pickOutside('file', text.chatPickExternalFile)}>
						<ChatIcon name="file-text" /><span>{text.chatPickExternalFile}</span>
					</button>
					{menu === 'file' && <ExternalPathFallback mode={menu} onAdd={complete} />}
					<button type="button" disabled={menu === 'picking'} onClick={() => void pickOutside('folder', text.chatPickExternalFolder)}>
						<ChatIcon name="folder" /><span>{text.chatPickExternalFolder}</span>
					</button>
					{menu === 'folder' && <ExternalPathFallback mode={menu} onAdd={complete} />}
				</div>}
			</div>}
		</div>
	);
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
