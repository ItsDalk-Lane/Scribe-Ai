import { useLayoutEffect, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import type { ConversationSummary } from '../../types';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';

export interface EditableConversationProps {
	conversation: ConversationSummary;
	disabled: boolean;
	onRename: (id: string, title: string) => Promise<boolean>;
	onDelete: (conversation: ConversationSummary, trigger: HTMLButtonElement) => void;
}

export default function EditableConversation({ conversation, disabled, onRename, onDelete, children }: PropsWithChildren<EditableConversationProps>) {
	const text = uiText();
	const { id, title } = conversation;
	const label = title || text.chatUntitled;
	const [draft, setDraft] = useState<string | null>(null);
	const edit = useRef<HTMLButtonElement>(null);
	const field = useRef<HTMLInputElement>(null);
	const restoreFocus = useRef(false);
	const editing = draft !== null;

	useLayoutEffect(() => {
		if (editing) {
			field.current?.focus({ preventScroll: true });
			field.current?.select();
		} else if (restoreFocus.current) {
			restoreFocus.current = false;
			edit.current?.focus({ preventScroll: true });
		}
	}, [editing]);

	if (draft !== null) return <form className="scribe-conversation-editor" onSubmit={(event) => {
		event.preventDefault();
		const name = draft.trim();
		if (!disabled && name) void onRename(id, name).then((saved) => { if (saved) setDraft(null); });
	}} onKeyDown={(event) => {
		if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
		event.preventDefault();
		event.stopPropagation();
		if (!disabled) setDraft(null);
	}}>
		<input ref={field} type="text" aria-label={text.chatConversationTitle} value={draft} maxLength={120} readOnly={disabled}
			onChange={(event) => setDraft(event.currentTarget.value)} />
		<button type="submit" className="scribe-chat-icon-button" aria-label={text.save} title={text.save}
			disabled={disabled || !draft.trim()}><ChatIcon name="check" /></button>
		<button type="button" className="scribe-chat-icon-button" aria-label={text.cancel} title={text.cancel}
			disabled={disabled} onClick={() => setDraft(null)}><ChatIcon name="x" /></button>
	</form>;

	return <>
		{children}
		<div className="scribe-history-actions">
			<button type="button" ref={edit} className="scribe-chat-icon-button" disabled={disabled}
				aria-label={`${text.chatRenameConversation} ${label}`} title={text.chatRenameConversation} onClick={() => {
					restoreFocus.current = true;
					setDraft(title);
				}}><ChatIcon name="pencil" /></button>
			<button type="button" className="scribe-chat-icon-button scribe-conversation-delete" disabled={disabled}
				aria-label={`${text.chatDeleteConversation} ${label}`} title={text.chatDeleteConversation}
				onClick={(event) => onDelete(conversation, event.currentTarget)}><ChatIcon name="trash-2" /></button>
		</div>
	</>;
}
