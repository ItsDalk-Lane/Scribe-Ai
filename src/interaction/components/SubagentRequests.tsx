import { useEffect, useEffectEvent, useRef } from 'react';
import type { App } from 'obsidian';
import type { SubagentRequest } from '../../types';
import { confirmResume } from '../ResumeConfirmModal';
import { subagentUiText } from '../subagentUiText';
import { uiText } from '../uiText';
import ApprovalView from './ApprovalView';
import ChatIcon from './ChatIcon';
import type { InspectSubagent } from './SubagentsPanel';

type RequestContent<T = SubagentRequest> = T extends SubagentRequest
	? Omit<T, 'id' | 'agentId' | 'createdAt'> : never;

export type ChatRequestContent = RequestContent;
export type ParentPrompt = ChatRequestContent & {
	id: string;
	createdAt: number;
	respond(this: void, accepted: boolean): void;
};

type ChatPrompt = ParentPrompt & { source?: { id: string; name: string } };

export default function SubagentRequests({ app, prompt, selected, onInspect }: {
	app: App; prompt?: ChatPrompt; selected: boolean; onInspect: InspectSubagent;
}) {
	const text = subagentUiText();
	const chat = uiText();
	const modal = useRef<AbortController>(undefined);
	const promptId = prompt?.id;
	const autoReview = prompt?.kind === 'send' && !prompt.source;
	const review = () => {
		if (!selected || prompt?.kind !== 'send' || modal.current) return;
		const controller = modal.current = new AbortController();
		const source = prompt.source;
		const options = source && {
			title: text.sendTitle.replace('{agent}', () => source.name),
			confirm: text.approveSend, disclosure: text.sendNotice, scope: text.sendScope,
		};
		void confirmResume(app, prompt.preview, controller.signal, options).then(
			(approved) => { if (!controller.signal.aborted) prompt.respond(approved); },
			() => { if (!controller.signal.aborted) prompt.respond(false); },
		).finally(() => { if (modal.current === controller) modal.current = undefined; });
	};
	const autoOpen = useEffectEvent(review);

	useEffect(() => {
		if (selected && autoReview) autoOpen();
		return () => {
			modal.current?.abort();
			modal.current = undefined;
		};
	}, [promptId, selected, autoReview]);

	if (!prompt) return null;
	const source = prompt.source;
	const sourceButton = source && <button type="button" className="scribe-message-action scribe-subagent-request-source"
		data-agent-id={source.id}
		aria-label={`${text.inspect} · ${source.name}`} onClick={(event) => onInspect(source.id, event.currentTarget)}>
		<ChatIcon name="workflow" /><span><bdi>{text.request.replace('{agent}', () => source.name)}</bdi></span>
	</button>;
	if (prompt.kind === 'approval') {
		return <ApprovalView key={prompt.id} approval={{ ...prompt.approval, decide: prompt.respond }} source={sourceButton} />;
	}
	const retry = prompt.kind === 'retry';
	return <section className="scribe-approval-view" aria-label={retry ? chat.chatTimelineWaitingConnection : text.reviewSend}>
		<div className="scribe-approval-warning">
			<ChatIcon name={retry ? 'rotate-cw' : 'shield-question'} />
			<span>{retry ? chat.chatTimelineWaitingConnection : text.reviewSend}</span>
			{sourceButton}
		</div>
		{prompt.kind === 'send' && <div className="scribe-approval-body"><bdi>{prompt.preview.address}</bdi></div>}
		<div className="scribe-chat-actions scribe-approval-actions">
			{!retry && <button type="button" onClick={() => prompt.respond(false)}>{chat.chatDeny}</button>}
			<button type="button" className="mod-cta" onClick={() => retry ? prompt.respond(true) : review()}>
				{retry ? chat.chatRetryConnection : text.reviewSend}
			</button>
		</div>
	</section>;
}
