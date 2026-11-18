import { useEffect, useId, useRef, useState } from 'react';
import type { ConversationSummary } from '../../types';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';

interface ConversationListProps {
	conversations: ConversationSummary[];
	conversationId?: string | null;
	disabled: boolean;
	onSelect: (id: string) => void;
}

export function ConversationList({ conversations, conversationId, disabled, onSelect }: ConversationListProps) {
	const text = uiText();
	return (
		<ul className="scribe-conversation-list">
			{conversations.map(({ id, title, updatedAt }) => (
				<li key={id}>
					<button type="button" className="scribe-conversation-row" disabled={disabled}
						aria-current={id === conversationId ? 'true' : undefined} onClick={() => onSelect(id)}>
						<ChatIcon name="message-circle" />
						<span className="scribe-conversation-title" title={title || text.chatUntitled}>{title || text.chatUntitled}</span>
						<time>{new Date(updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
					</button>
				</li>
			))}
		</ul>
	);
}

export default function ChatNavigation({ conversations, conversationId, disabled, onSelect, onNew }: ConversationListProps & { onNew: () => void }) {
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
			if (!event.composedPath().includes(element)) setOpen(false);
		};
		doc.addEventListener('pointerdown', dismiss);
		return () => doc.removeEventListener('pointerdown', dismiss);
	}, [showHistory]);
	return (
		<nav className="scribe-chat-navigation" aria-label={text.chatConversation}>
			<button type="button" className="scribe-chat-icon-button" disabled={disabled}
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
					<ConversationList conversations={conversations} conversationId={conversationId} disabled={disabled}
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
