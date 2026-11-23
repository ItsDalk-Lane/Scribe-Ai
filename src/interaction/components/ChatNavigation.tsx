import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationSummary } from '../../types';
import { updateOverflowTitle } from '../overflowTitle';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';
import EditableConversation from './EditableConversation';
import type { EditableConversationProps } from './EditableConversation';

export interface HistoryTrigger {
	button: HTMLElement;
	registerToggle: (toggle?: () => void) => void;
}

interface ConversationListProps extends Omit<EditableConversationProps, 'conversation'> {
	conversations: ConversationSummary[];
	conversationId: string;
	onSelect: (id: string) => void;
}

export function ConversationList({ conversations, conversationId, disabled, onSelect, onRename, onArchive, onDelete }: ConversationListProps) {
	const text = uiText();
	return <ul className="scribe-conversation-list">
		{conversations.map((conversation) => <li key={conversation.id}>
			<EditableConversation conversation={conversation} disabled={disabled} onRename={onRename} onArchive={onArchive} onDelete={onDelete}>
				<button type="button" className="scribe-conversation-row" disabled={disabled}
					aria-current={conversation.id === conversationId || undefined} onClick={() => onSelect(conversation.id)}>
					<ChatIcon name="message-circle" />
					<span className="scribe-conversation-title" onPointerEnter={({ currentTarget }) => updateOverflowTitle(currentTarget)}>
						{conversation.title || text.chatUntitled}
					</span>
					<time>{new Date(conversation.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
				</button>
			</EditableConversation>
		</li>)}
	</ul>;
}

interface HistoryProps extends ConversationListProps {
	trigger: HistoryTrigger;
	onRefresh: () => Promise<void>;
}

export default function ChatNavigation({ trigger, conversations, conversationId, disabled,
	onSelect, onRename, onArchive, onDelete, onRefresh }: HistoryProps) {
	const text = uiText();
	const panelId = useId();
	const panel = useRef<HTMLElement>(null);
	const host = trigger.button.closest('.view-header');
	const [page, setPage] = useState<'history' | 'archived' | null>(null);
	const open = page !== null;
	const showArchived = page === 'archived';
	const [refreshing, setRefreshing] = useState(false);
	const refresh = useEffectEvent(onRefresh);

	useLayoutEffect(() => {
		trigger.registerToggle(() => setPage((previous) => previous ? null : 'history'));
		return () => trigger.registerToggle();
	}, [trigger]);

	useLayoutEffect(() => {
		if (!page || !panel.current) return;
		panel.current.scrollTop = 0;
		panel.current.focus({ preventScroll: true });
	}, [page]);

	useLayoutEffect(() => {
		const popup = panel.current;
		if (!open || !popup) return;
		const { button } = trigger;
		const doc = button.ownerDocument;
		button.setAttribute('aria-expanded', 'true');
		button.setAttribute('aria-controls', panelId);
		const dismiss = (event: PointerEvent) => {
			const path = event.composedPath();
			if (!path.includes(button) && !path.includes(popup) && !(event.target as Element | null)?.closest?.('.modal-container')) setPage(null);
		};
		doc.addEventListener('pointerdown', dismiss);
		return () => {
			button.setAttribute('aria-expanded', 'false');
			button.removeAttribute('aria-controls');
			doc.removeEventListener('pointerdown', dismiss);
		};
	}, [open, panelId, trigger]);

	useEffect(() => {
		if (!open) return;
		let current = true;
		setRefreshing(true);
		void refresh().finally(() => {
			if (current) setRefreshing(false);
		});
		return () => { current = false; };
	}, [open]);

	if (!open || !host) return null;
	const entries = conversations.filter(({ archived }) => Boolean(archived) === showArchived);

	function close() {
		setPage(null);
		trigger.button.focus({ preventScroll: true });
	}

	return createPortal(<section ref={panel} className="scribe-history-panel" id={panelId}
		role="dialog" aria-label={showArchived ? text.chatArchived : text.chatHistory} tabIndex={-1} onKeyDown={(event) => {
			if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			close();
		}}>
		{showArchived ? <header className="scribe-history-archive-header">
			<button type="button" className="scribe-chat-icon-button" aria-label={text.back} title={text.back} onClick={() => setPage('history')}>
				<ChatIcon name="arrow-left" />
			</button>
			<strong>{text.chatArchived}</strong>
		</header> : <button type="button" className="scribe-history-archive-entry" onClick={() => setPage('archived')}>
			<ChatIcon name="archive" /><span>{text.chatArchived}</span><ChatIcon name="chevron-right" />
		</button>}
		{refreshing || !entries.length ? <p className="scribe-chat-loading" role="status">
			{refreshing ? text.chatLoadingHistory : showArchived ? text.chatNoArchivedConversations : text.chatNoSavedConversations}
		</p> : <ConversationList conversations={entries} conversationId={conversationId} disabled={disabled}
			onRename={onRename} onArchive={onArchive} onDelete={onDelete} onSelect={(id) => {
				close();
				onSelect(id);
			}} />}
	</section>, host);
}
