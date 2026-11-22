import { useCallback, useRef } from 'react';
import type { ConversationStore, ConversationSummary } from '../../types';
import { conversationPreview } from '../context';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';
import EditableConversation from './EditableConversation';
import { tr } from '../skills/dialog';
import type { EditableConversationProps } from './EditableConversation';
import HistoryPreviewCard from './HistoryPreviewCard';
import type { HistoryExcerpt } from './HistoryPreviewCard';
import JumpNavigator from './JumpNavigator';

interface ConversationListProps extends Omit<EditableConversationProps, 'conversation'> {
	conversations: ConversationSummary[];
	conversationId: string;
	onSelect: (id: string) => void;
}

export function ConversationList({ conversations, conversationId, disabled, onSelect, onRename, onDelete }: ConversationListProps) {
	const text = uiText();
	return <ul className="scribe-conversation-list">
		{conversations.map((conversation) => <li key={conversation.id}>
			<EditableConversation conversation={conversation} disabled={disabled} onRename={onRename} onDelete={onDelete}>
				<button type="button" className="scribe-conversation-row" disabled={disabled}
					aria-current={conversation.id === conversationId || undefined} onClick={() => onSelect(conversation.id)}>
					<ChatIcon name="message-circle" />
					<span className="scribe-conversation-title">{conversation.title || text.chatUntitled}
						{conversation.archived ? ` · ${tr('已归档', 'Archived')}` : ''}</span>
					<time>{new Date(conversation.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
				</button>
			</EditableConversation>
		</li>)}
	</ul>;
}

interface HistoryProps extends ConversationListProps {
	store: Pick<ConversationStore, 'load'>;
	onRefresh: () => Promise<void>;
}

export default function ChatNavigation({ conversations, conversationId, disabled,
	store, onSelect, onRename, onDelete, onRefresh }: HistoryProps) {
	const text = uiText();
	const refreshing = useRef(false);
	const cache = useRef(new Map<string, { updatedAt: number; value: Promise<HistoryExcerpt> }>());

	function refresh() {
		if (refreshing.current || disabled) return;
		refreshing.current = true;
		void onRefresh().finally(() => { refreshing.current = false; });
	}

	const readExcerpt = useCallback((id: string, updatedAt: number) => {
		const last = cache.current.get(id);
		if (last?.updatedAt === updatedAt) return last.value;
		const value = store.load(id).then(conversationPreview).catch((error: unknown) => {
			if (cache.current.get(id)?.value === value) cache.current.delete(id);
			throw error;
		});
		cache.current.set(id, { updatedAt, value });
		return value;
	}, [store]);

	const entries = conversations.map((row) => ({ ...row, label: `${row.title || text.chatUntitled}${row.archived ? ` · ${tr('已归档', 'Archived')}` : ''}` }));

	function card(row: ConversationSummary, onChoose: () => void, compact: boolean) {
		return <HistoryPreviewCard key={row.id} conversation={row} current={row.id === conversationId}
			compact={compact} disabled={disabled}
			readExcerpt={readExcerpt} onChoose={onChoose} onRename={onRename} onDelete={onDelete} />;
	}

	return <JumpNavigator side="right" icon="history" label={text.chatHistory} entries={entries} current={conversationId}
		onJump={onSelect} onInteract={refresh} disabled={disabled}
		renderPreview={(row, choose) => card(row, choose, false)} renderCompactEntry={(row, choose) => card(row, choose, true)}
		emptyLabel={text.chatNoSavedConversations} renderEmpty={() => <div className="scribe-history-empty">
			<p role="status">{text.chatNoSavedConversations}</p>
		</div>} />;
}
