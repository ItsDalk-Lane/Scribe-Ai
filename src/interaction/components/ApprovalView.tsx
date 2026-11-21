import { useId } from 'react';
import type { ChatApproval } from '../context';
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

export default function ApprovalView({ approval }: { approval: ChatApproval | null }) {
	const headingId = useId();
	const warningId = useId();
	if (!approval) return null;
	const text = uiText();
	const shell = approval.kind === 'shell';
	const access = approval.kind === 'access';
	const title = access ? text.chatApprovalAccess : approval.title === '创建文件' ? text.chatApprovalCreate
		: approval.title === '修改文件' ? text.chatApprovalEdit : approval.title;
	return (
		<section className="scribe-approval-view" ref={preserveApprovalFocus} aria-labelledby={headingId} aria-describedby={warningId}>
			<div className="scribe-approval-warning" id={warningId}>
				<ChatIcon name="shield-question" />
				{text.chatApprovalHeading}
			</div>
			<div className="scribe-approval-body" role="group" aria-labelledby={headingId} tabIndex={0}>
				<h3 id={headingId}>{title}</h3>
				{shell && <div>{text.chatWorkingFolder}</div>}
				<div className="scribe-chat-path" title={approval.target} dir="auto">{approval.target}</div>
				{approval.reason && <p className="scribe-chat-disclosure">{approval.reason}</p>}
				{shell && <p className="scribe-chat-disclosure">{text.chatShellDisclosure}</p>}
				{access && <p className="scribe-chat-disclosure">{text.chatApprovalPathDisclosure}</p>}
				{approval.after !== undefined && (shell ? <div>
					<strong>{text.chatCommand}</strong>
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
