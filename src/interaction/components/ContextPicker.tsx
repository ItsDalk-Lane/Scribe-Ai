import { basename, isAbsolute } from 'node:path';
import { FuzzySuggestModal, TFile, TFolder } from 'obsidian';
import type { App, TAbstractFile } from 'obsidian';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { NoteRef, NoteSelection } from '../../types';
import { composerShortcut } from '../composerKeyboard';
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
	onAttachSelection: () => boolean;
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

interface ContextActionsProps extends Pick<ContextPickerProps, 'onAttachSelection' | 'disabled'> {
	onPick: () => void;
	selectionOnly: boolean;
	externalOpen: boolean;
	externalId: string;
	onToggleExternal: (trigger: HTMLButtonElement | null) => void;
}

export function ContextActions({ onPick, onAttachSelection, disabled, selectionOnly, externalOpen, externalId, onToggleExternal }: ContextActionsProps) {
	const text = uiText();
	const trigger = useRef<HTMLButtonElement>(null);
	const id = useId();
	const [menu, setMenu] = useState<'closed' | 'open' | 'no-selection'>('closed');
	const menuOpen = menu !== 'closed' && !disabled;

	useEffect(() => setMenu('closed'), [disabled, selectionOnly]);

	return (
		<div className="scribe-context-actions" onBlur={(event) => {
			if (menuOpen && !event.currentTarget.contains(event.relatedTarget)) setMenu('closed');
		}} onKeyDown={(event) => {
			if (!menuOpen || event.defaultPrevented || composerShortcut(event.nativeEvent) !== 'escape') return;
			event.preventDefault();
			event.stopPropagation();
			setMenu('closed');
			trigger.current?.focus({ preventScroll: true });
		}}>
			<button type="button" ref={trigger} className="scribe-compose-action" disabled={disabled}
				aria-label={text.chatAddContext} title={text.chatAddContext}
				aria-expanded={menuOpen} aria-controls={menuOpen ? id : undefined}
				onClick={(event) => {
					event.currentTarget.focus({ preventScroll: true });
					setMenu(menuOpen ? 'closed' : 'open');
				}}><ChatIcon name="plus" /></button>
			{menuOpen && <div className="scribe-context-popover" id={id} role="group" aria-label={text.chatAddContext}>
				{!selectionOnly && <button type="button" onClick={() => {
					setMenu('closed');
					onPick();
				}}>
					<ChatIcon name="folder-open" />
					<span>{text.chatPickVaultItem}</span>
				</button>}
				<button type="button" onClick={() => setMenu(onAttachSelection() ? 'closed' : 'no-selection')}>
					<ChatIcon name="text-select" />
					<span>{text.chatAttachSelection}</span>
				</button>
				{!selectionOnly && <button type="button" aria-expanded={externalOpen}
					aria-controls={externalOpen ? externalId : undefined}
					onClick={() => { setMenu('closed'); onToggleExternal(trigger.current); }}>
					<ChatIcon name="folder-plus" />
					<span>{text.chatAddExternalPath}</span>
				</button>}
				{menu === 'no-selection' && <div className="scribe-chat-error" role="alert">{text.chatSelectionUnavailable}</div>}
			</div>}
		</div>
	);
}

export function ExternalPath({ onAdd, disabled, id }: Pick<ContextPickerProps, 'onAdd' | 'disabled'> & { id: string }) {
	const text = uiText();
	const [path, setPath] = useState('');
	const [kind, setKind] = useState<'file' | 'folder'>('file');
	const [invalidPath, setInvalidPath] = useState(false);
	const pathInput = useRef<HTMLInputElement>(null);
	useEffect(() => pathInput.current?.focus(), []);

	function addPath() {
		const entered = path.trim();
		if (!entered) return;
		pathInput.current?.focus();
		const firstCharacter = entered[0];
		const fullPath = firstCharacter && ['"', "'"].includes(firstCharacter) && entered.endsWith(firstCharacter)
			? entered.slice(1, -1)
			: entered;
		if (!isAbsolute(fullPath)) {
			setInvalidPath(true);
			return;
		}
		onAdd({ path: fullPath, kind });
		setPath('');
		setInvalidPath(false);
	}

	return (
		<form id={id} className="scribe-context-path" aria-label={text.chatAddExternalPath} onSubmit={(event) => {
			event.preventDefault();
			event.stopPropagation();
			if (!disabled) addPath();
		}} onKeyDown={(event) => {
			if (event.key === 'Enter') event.stopPropagation();
		}}>
			<div>{text.chatScopeDescription}</div>
			<input
				ref={pathInput}
				type="text"
				value={path}
				placeholder={text.chatAbsolutePath}
				aria-label={text.chatAbsolutePath}
				aria-invalid={invalidPath}
				aria-describedby={invalidPath ? `${id}-error` : undefined}
				disabled={disabled}
				onChange={(event) => {
					setPath(event.currentTarget.value);
					setInvalidPath(false);
				}}
			/>
			<div className="scribe-chat-actions">
				<select
					value={kind}
					onChange={(event) => setKind(event.currentTarget.value === 'folder' ? 'folder' : 'file')}
					aria-label={text.chatPathKind}
					disabled={disabled}
				>
					<option value="file">{text.chatFile}</option>
					<option value="folder">{text.chatFolder}</option>
				</select>
				<button type="submit" disabled={disabled || !path.trim()}>{text.add}</button>
			</div>
			{invalidPath && <div id={`${id}-error`} className="scribe-chat-error" role="alert">{text.chatInvalidPath}</div>}
		</form>
	);
}
