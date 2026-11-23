import { useId } from 'react';
import type { ReactNode } from 'react';
import type { ChatApproval } from '../context';
import { tr } from '../skills/dialog';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';
import FileChanges from './FileChanges';

function preserveApprovalFocus(card: HTMLElement | null) {
	if (!card) return;
	const app = card.closest('.scribe-app');
	const doc = card.ownerDocument;
	return () => {
		if (!card.contains(doc.activeElement)) return;
		queueMicrotask(() => {
			if (!app?.isConnected || doc.activeElement !== doc.body) return;
			app.querySelector<HTMLTextAreaElement>('textarea.scribe-input')?.focus({ preventScroll: true });
		});
	};
}

export default function ApprovalView({ approval, source }: { approval: ChatApproval | null; source?: ReactNode }) {
	const headingId = useId();
	const warningId = useId();
	if (!approval) return null;
	const text = uiText();
	const shell = approval.kind === 'shell';
	const access = approval.kind === 'access';
	const mcp = approval.kind === 'mcp';
	const title = access ? text.chatApprovalAccess : approval.title === '创建文件' ? text.chatApprovalCreate
		: approval.title === '修改文件' ? text.chatApprovalEdit : approval.title;
	return (
		<section className="scribe-approval-view" ref={preserveApprovalFocus} aria-labelledby={headingId} aria-describedby={warningId}>
			<div className="scribe-approval-warning" id={warningId}>
				<ChatIcon name="shield-question" />
				<span>{text.chatApprovalHeading}</span>
				{source}
			</div>
			<div className="scribe-approval-body" role="group" aria-labelledby={headingId} tabIndex={0}>
				<h3 id={headingId}>{title}</h3>
				{shell && <div>{text.chatWorkingFolder}</div>}
				<div className="scribe-chat-path" dir="auto">{approval.target}</div>
				{approval.reason && <p className="scribe-chat-disclosure">{approval.reason}</p>}
				{shell && <p className="scribe-chat-disclosure">{text.chatShellDisclosure}</p>}
				{shell && approval.background && <p className="scribe-chat-disclosure">{text.chatBackgroundApproval}</p>}
				{access && <p className="scribe-chat-disclosure">{text.chatApprovalPathDisclosure}</p>}
				{approval.after !== undefined && (shell || mcp ? <div>
					<strong>{mcp ? (tr('将发送的参数', 'Arguments to send')) : text.chatCommand}</strong>
					<pre className="scribe-chat-pre" tabIndex={0}>{approval.after}</pre>
				</div> : <FileChanges before={approval.before} after={approval.after} />)}
			</div>
			<div className="scribe-chat-actions scribe-approval-actions">
				<button type="button" onClick={() => approval.decide(false)}>{text.chatDeny}</button>
				<button type="button" className={shell ? 'mod-warning' : 'mod-cta'} onClick={() => approval.decide(true)}>{text.chatApprove}</button>
			</div>
		</section>
	);
}
