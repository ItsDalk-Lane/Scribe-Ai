import { useEffect, useState } from 'react';
import type { conversationPreview } from '../context';
import { uiText } from '../uiText';
import EditableConversation from './EditableConversation';
import type { EditableConversationProps } from './EditableConversation';

export type HistoryExcerpt = ReturnType<typeof conversationPreview>;

interface Props extends EditableConversationProps {
	compact: boolean;
	current: boolean;
	readExcerpt: (id: string, updatedAt: number) => Promise<HistoryExcerpt>;
	onChoose: () => void;
}

export default function HistoryPreviewCard({ conversation, compact, current, disabled,
	readExcerpt, onChoose, onRename, onDelete }: Props) {
	const text = uiText();
	const { id, title, updatedAt } = conversation;
	const label = title || text.chatUntitled;
	const [inspected, setInspected] = useState(false);
	const [excerpt, setExcerpt] = useState<HistoryExcerpt | 'error'>();
	const showExcerpt = !compact || inspected;

	useEffect(() => {
		if (!showExcerpt) return;
		let cancelled = false;
		// 略过鼠标快速掠过的对话，只为停留的短线读取正文。
		const timer = window.setTimeout(() => {
			void readExcerpt(id, updatedAt).then(
				(value) => { if (!cancelled) setExcerpt(value); },
				() => { if (!cancelled) setExcerpt('error'); },
			);
		}, 100);
		return () => { cancelled = true; window.clearTimeout(timer); };
	}, [showExcerpt, id, updatedAt, readExcerpt]);

	return <div className="scribe-history-card" data-compact={compact || undefined} data-current={current || undefined}
		onMouseEnter={compact ? () => setInspected(true) : undefined} onMouseLeave={compact ? () => setInspected(false) : undefined}
		onFocus={compact ? () => setInspected(true) : undefined} onBlur={compact ? (event) => {
			if (!event.currentTarget.contains(event.relatedTarget)) setInspected(false);
		} : undefined}>
		<EditableConversation conversation={conversation} disabled={disabled} onRename={onRename} onDelete={onDelete}>
			<button type="button" className="scribe-history-choice" disabled={disabled} onClick={onChoose}
				aria-current={current || undefined}>
				<strong>{label}</strong>
				<time dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time>
				{showExcerpt && (excerpt === 'error' ? <small role="status">{text.chatHistoryError}</small> : excerpt ? <>
					{excerpt.prompt && <span className="scribe-history-question">{text.chatYou} · {excerpt.prompt}</span>}
					{excerpt.reply && <span className="scribe-history-reply">{text.chatAssistant} · {excerpt.reply}</span>}
				</> : <small role="status">{text.chatLoadingHistory}</small>)}
			</button>
		</EditableConversation>
	</div>;
}
