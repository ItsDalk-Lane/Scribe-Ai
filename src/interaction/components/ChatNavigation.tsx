import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationSummary } from '../../types';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';

interface ConversationListProps {
	conversations: ConversationSummary[];
	conversationId?: string | null;
	disabled: boolean;
	onSelect: (id: string) => void;
	onRename: (id: string, title: string) => Promise<boolean>;
	onDelete: (conversation: ConversationSummary, trigger: HTMLButtonElement) => void;
}

interface ConversationRowProps extends Omit<ConversationListProps, 'conversations' | 'conversationId'> {
	conversation: ConversationSummary;
	current: boolean;
}

function ConversationRow({ conversation, current, disabled, onSelect, onRename, onDelete }: ConversationRowProps) {
	const text = uiText();
	const { id, title, updatedAt } = conversation;
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

	if (draft !== null) {
		return <li>
			<form className="scribe-conversation-editor" onSubmit={(event) => {
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
			</form>
		</li>;
	}
	return <li className="scribe-conversation-item" data-disabled={disabled || undefined}>
		<button type="button" className="scribe-conversation-row" disabled={disabled}
			aria-current={current ? 'true' : undefined} onClick={() => onSelect(id)}>
			<ChatIcon name="message-circle" />
			<span className="scribe-conversation-title" title={label}>{label}</span>
			<time>{new Date(updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
		</button>
		<div className="scribe-conversation-actions">
			<button type="button" ref={edit} className="scribe-chat-icon-button" disabled={disabled}
				aria-label={`${text.chatRenameConversation} ${label}`} title={text.chatRenameConversation} onClick={() => {
					restoreFocus.current = true;
					setDraft(title);
				}}><ChatIcon name="pencil" /></button>
			<button type="button" className="scribe-chat-icon-button scribe-conversation-delete" disabled={disabled}
				aria-label={`${text.chatDeleteConversation} ${label}`} title={text.chatDeleteConversation}
				onClick={(event) => onDelete(conversation, event.currentTarget)}><ChatIcon name="trash-2" /></button>
		</div>
	</li>;
}

export function ConversationList({ conversations, conversationId, ...actions }: ConversationListProps) {
	return (
		<ul className="scribe-conversation-list">
			{conversations.map((conversation) => (
				<ConversationRow key={conversation.id} conversation={conversation} current={conversation.id === conversationId} {...actions} />
			))}
		</ul>
	);
}

export default function ChatNavigation({ conversations, conversationId, disabled, managing, onSelect, onNew, onRename, onDelete }:
	ConversationListProps & { managing: boolean; onNew: () => void }) {
	const text = uiText();
	const group = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const panelId = useId();
	const [open, setOpen] = useState(false);
	const showHistory = open && !disabled && conversations.length > 0;

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);
	useEffect(() => {
		const element = group.current;
		if (!showHistory || !element) return;
		const doc = element.ownerDocument;
		const dismiss = (event: PointerEvent) => {
			if (!event.composedPath().includes(element) && !(event.target as Element | null)?.closest?.('.modal-container')) setOpen(false);
		};
		doc.addEventListener('pointerdown', dismiss);
		return () => doc.removeEventListener('pointerdown', dismiss);
	}, [showHistory]);
	return (
		<nav className="scribe-chat-navigation" aria-label={text.chatConversation}>
			<button type="button" className="scribe-chat-icon-button" disabled={disabled || managing}
				aria-label={text.chatNewConversation} title={text.chatNewConversation} onClick={onNew}>
				<ChatIcon name="message-circle-plus" />
			</button>
			<div className="scribe-chat-history" ref={group} onKeyDown={(event) => {
				if (!showHistory || event.key !== 'Escape') return;
				event.preventDefault();
				event.stopPropagation();
				setOpen(false);
				trigger.current?.focus();
			}}>
				<button type="button" className="scribe-chat-icon-button" ref={trigger} disabled={disabled || !conversations.length}
					aria-label={text.chatHistory} title={text.chatHistory} aria-expanded={showHistory}
					aria-controls={showHistory ? panelId : undefined} onClick={() => setOpen(!showHistory)}>
					<ChatIcon name="history" />
				</button>
				{showHistory && <section className="scribe-history-panel" id={panelId} aria-label={text.chatHistory}>
					<ConversationList conversations={conversations} conversationId={conversationId} disabled={disabled || managing}
						onRename={onRename} onDelete={onDelete}
						onSelect={(id) => {
							setOpen(false);
							trigger.current?.focus();
							if (id !== conversationId) onSelect(id);
						}} />
				</section>}
			</div>
		</nav>
	);
}
