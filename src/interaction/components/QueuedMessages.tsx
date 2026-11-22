import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEventHandler, RefObject } from 'react';
import { SIDE_CHAT_ICON } from '../../constants';
import type { NoteRef, SkillRegistry, TaskRequest } from '../../types';
import { composerShortcut } from '../composerKeyboard';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';
import SkillTextArea from './SkillTextArea';
import type { SkillDraft } from './skillMentionText';

interface QueuedMessagesProps {
	app: App;
	skills: SkillRegistry;
	rows: readonly { id: string; request: TaskRequest; pending?: boolean; failed?: boolean }[];
	canSteer: boolean;
	onEdit: (id: string, draft: SkillDraft) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
	onSteer: (id: string) => Promise<void>;
	onSideChat: (id: string, beforeRemove: () => void) => Promise<void>;
	inputRef: RefObject<HTMLTextAreaElement | null>;
}

const imageTypes: Readonly<Record<string, string>> = {
	'.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

function fileSize(bytes: number): string {
	const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
	const index = Math.min(Math.floor(Math.log10(Math.max(1, bytes)) / 3), units.length - 1);
	return new Intl.NumberFormat(undefined, {
		style: 'unit', unit: units[index], maximumFractionDigits: 1,
	}).format(bytes / 1000 ** index);
}

function QueueAttachment({ app, attachment: { kind, path }, visible }: { app: App; attachment: NoteRef; visible: boolean }) {
	const text = uiText();
	const external = isAbsolute(path);
	const extension = extname(path).toLowerCase();
	const imageType = kind === 'folder' ? undefined : imageTypes[extension];
	const entry = external ? null : app.vault.getAbstractFileByPath(path);
	const file = entry instanceof TFile ? entry : null;
	const [requested, setRequested] = useState(visible);
	const [externalSize, setExternalSize] = useState<number>();
	const [externalImage, setExternalImage] = useState<string>();
	const [failedImage, setFailedImage] = useState<string>();

	useEffect(() => {
		if (visible && external) setRequested(true);
	}, [external, visible]);
	useEffect(() => {
		if (!requested || !external || kind === 'folder') return;
		const controller = new AbortController();
		const { signal } = controller;
		let url: string | undefined;
		void (async () => {
			const info = await stat(path);
			if (signal.aborted || !info.isFile()) return;
			setExternalSize(info.size);
			if (!imageType) return;
			const bytes = await readFile(path, { signal });
			if (signal.aborted) return;
			url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: imageType }));
			setExternalImage(url);
		})().catch(() => undefined);
		return () => {
			controller.abort();
			if (url) URL.revokeObjectURL(url);
		};
	}, [external, imageType, kind, path, requested]);

	const name = entry?.name ?? (basename(path) || path);
	const source = imageType && file ? app.vault.getResourcePath(file) : externalImage;
	if (source && source !== failedImage) return <img className="scribe-queue-image" src={source}
		alt={text.queueImage} title={name} loading="lazy" onError={() => setFailedImage(source)} />;

	const size = file?.stat.size ?? externalSize;
	const label = text.queueFile.replace('{name}', () => name);
	return <span className="scribe-queue-file" role="img" aria-label={label} title={label}>
		<ChatIcon name={kind === 'folder' ? 'folder' : imageType ? 'image' : 'file-text'} />
		<span className="scribe-queue-file-name">{name}</span>
		{size !== undefined && <span className="scribe-queue-file-size">{fileSize(size)}</span>}
	</span>;
}

function Action({ icon, label, reason, disabled, onClick, edit, sideChat }: {
	icon: string; label: string; reason?: string; disabled?: boolean; onClick: MouseEventHandler<HTMLButtonElement>;
	edit?: boolean; sideChat?: boolean;
}) {
	const unavailable = disabled || Boolean(reason);
	return <button type="button" className="scribe-compose-action scribe-queue-action" aria-label={label}
		aria-disabled={unavailable} aria-description={reason} title={reason ?? label} data-queue-edit={edit || undefined}
		data-queue-side-chat={sideChat || undefined}
		onClick={(event) => { if (!unavailable) onClick(event); }}><ChatIcon name={icon} /></button>;
}

export default function QueuedMessages({
	app, skills, rows, canSteer, onEdit, onDelete, onSteer, onSideChat, inputRef,
}: QueuedMessagesProps) {
	const text = uiText();
	const listId = useId();
	const [expanded, setExpanded] = useState(false);
	const [work, setWork] = useState<ReadonlySet<string>>(new Set());
	const working = useRef(new Set<string>());
	const [editing, setEditing] = useState<{ id: string; draft: SkillDraft }>();
	const editor = useRef<HTMLTextAreaElement>(null);
	const editRow = useRef<HTMLElement | null>(null);
	const single = rows.length === 1;
	const multiple = rows.length > 1;
	const currentEdit = editing && rows.some(({ id }) => id === editing.id) ? editing : undefined;
	const forced = Boolean(currentEdit) || work.size > 0;
	const showing = single || expanded || forced;
	const capturePanel = useCallback((panel: HTMLDivElement | null) => {
		if (!panel) return;
		return () => {
			if (panel.contains(panel.ownerDocument.activeElement)) inputRef.current?.focus({ preventScroll: true });
		};
	}, [inputRef]);

	useLayoutEffect(() => {
		if (!multiple) setExpanded(false);
	}, [multiple]);
	useLayoutEffect(() => {
		if (editing && !currentEdit) setEditing(undefined);
	}, [editing, currentEdit]);
	useLayoutEffect(() => {
		if (currentEdit?.id) editor.current?.focus({ preventScroll: true });
		else {
			const row = editRow.current;
			editRow.current = null;
			const focused = row?.ownerDocument.activeElement;
			if (row?.isConnected && (row.contains(focused ?? null) || focused === row.ownerDocument.body)) {
				row.querySelector<HTMLButtonElement>('[data-queue-edit]')?.focus({ preventScroll: true });
			}
		}
	}, [currentEdit?.id]);

	async function perform(id: string, failure: string | ((error: unknown) => string), operation: () => Promise<void>) {
		if (working.current.has(id)) return;
		working.current.add(id);
		setWork(new Set(working.current));
		try {
			await operation();
		} catch (error) {
			new Notice(typeof failure === 'string' ? failure : failure(error));
		} finally {
			working.current.delete(id);
			setWork(new Set(working.current));
		}
	}

	function moveSideChatFocus(trigger: HTMLButtonElement) {
		const row = trigger.closest('li');
		const document = trigger.ownerDocument;
		if (!row || !document.hasFocus() || !row.contains(document.activeElement)) return;
		const next = row.nextElementSibling?.querySelector<HTMLButtonElement>('[data-queue-side-chat]')
			?? row.previousElementSibling?.querySelector<HTMLButtonElement>('[data-queue-side-chat]');
		next?.focus({ preventScroll: true });
		if (next && document.activeElement === next) setExpanded(true);
		else inputRef.current?.focus({ preventScroll: true });
	}

	if (!rows.length) return null;
	const count = text.queueCount.replace('{n}', String(rows.length));
	return <div ref={capturePanel} className="scribe-queued-messages">
		{multiple && <button type="button" className="scribe-queue-heading" aria-expanded={showing} aria-controls={listId}
			disabled={forced} onClick={() => setExpanded((previous) => !previous)}>
			<span>{count}</span><ChatIcon name={showing ? 'chevron-down' : 'chevron-up'} />
		</button>}
		<div className="scribe-queue-expansion" data-expanded={showing} inert={!showing}>
			<ul className="scribe-queue-list" id={listId} aria-label={count}>
				{rows.map(({ id, request, pending, failed }) => {
					const edit = currentEdit?.id === id ? currentEdit : undefined;
					const locked = work.has(id);
					const status = failed ? text.queueSendFailed : pending ? text.queueSending : undefined;
					const selectionUnavailable = request.selection ? text.queueSelectionUnavailable : undefined;
					const preview = request.instruction.replace(/\s+/gu, ' ').trim();
					const attachments = request.selection ? [{ path: request.selection.path }] : request.refs;
					return <li className="scribe-queue-row" key={id} onKeyDown={(event) => {
						if (!edit || composerShortcut(event.nativeEvent) !== 'escape') return;
						event.preventDefault();
						event.stopPropagation();
						if (!working.current.has(id)) {
							editRow.current = event.currentTarget;
							setEditing(undefined);
						}
					}}>
						{single && <ChatIcon name="list-ordered" />}
						{attachments.length > 0 && <div className="scribe-queue-files">
							{attachments.map((ref) => <QueueAttachment key={ref.path} app={app} attachment={ref} visible={showing} />)}
						</div>}
						{edit ? <SkillTextArea inputRef={editor} className="scribe-queue-editor" rows={2} aria-label={text.queueEdit}
							registry={skills} refs={request.refs} scope={request.skillScope}
							draft={edit.draft} readOnly={locked} onDraftChange={(draft) => setEditing({ id, draft })} />
							: <span className="scribe-queue-preview">{preview}</span>}
						{(status || selectionUnavailable) && <span className="scribe-queue-status" role="status">{status ?? selectionUnavailable}</span>}
						<div className="scribe-queue-actions">
							{edit ? <>
								<Action icon="check" label={text.queueSave} disabled={locked || !edit.draft.instruction.trim()}
									onClick={() => void perform(id, (cause) => cause instanceof Error ? cause.message : text.queueEditFailed, async () => {
										const row = editor.current?.closest('li');
										await onEdit(id, edit.draft);
										if (row?.isConnected) editRow.current = row;
										setEditing((current) => current?.id === id ? undefined : current);
									})} />
								<Action icon="x" label={text.queueCancel} disabled={locked} onClick={() => {
									editRow.current = editor.current?.closest('li') ?? null;
									setEditing(undefined);
								}} />
							</> : <>
								<Action icon="pencil" label={text.queueEdit} edit disabled={locked || Boolean(currentEdit)}
									reason={status ?? selectionUnavailable ?? (attachments.length ? text.queueEditAttachment : undefined)}
								onClick={() => setEditing({ id, draft: { instruction: request.instruction, skillMentions: request.skillMentions } })} />
								<Action icon="trash-2" label={text.queueDelete} disabled={locked} reason={status}
									onClick={() => void perform(id, text.queueDeleteFailed, () => onDelete(id))} />
								<Action icon="send" label={text.queueSteer} disabled={locked}
									reason={status ?? selectionUnavailable ?? (!canSteer ? text.queueSteerUnavailable : undefined)}
									onClick={() => void perform(id, text.queueSteerFailed, () => onSteer(id))} />
							</>}
							{(!edit || locked) && <Action icon={SIDE_CHAT_ICON} label={text.queueSideChat} sideChat
								reason={status ?? selectionUnavailable ?? (locked ? text.queueActionPending : undefined)}
								onClick={(event) => {
									const trigger = event.currentTarget;
									void perform(id, (error) => error instanceof Error ? error.message : text.sideChatOpenFailed,
										() => onSideChat(id, () => moveSideChatFocus(trigger)));
								}} />}
						</div>
					</li>;
				})}
			</ul>
		</div>
	</div>;
}
