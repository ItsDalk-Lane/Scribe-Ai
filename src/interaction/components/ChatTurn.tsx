import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RunStatus, RunStep, TaskRequest } from '../../types';
import { chatTurnContent } from '../chatTurnContent';
import type { ChatExecution } from '../context';
import { actionTarget } from '../toolCardDetails';
import { uiText } from '../uiText';
import AnswerContent from './AnswerContent';
import ChatIcon from './ChatIcon';
import { ToolActivityRow } from './ToolActivityRow';

type SubmittedPrompt = Pick<TaskRequest, 'instruction' | 'refs' | 'selection'>;

function UserMessage({ app, content, request }: { app: App; content: string; request?: SubmittedPrompt }) {
	const text = uiText();
	const id = useId();
	const prompt = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [clampable, setClampable] = useState(false);
	const selection = request?.selection;
	const refs = request?.refs ?? [];

	useLayoutEffect(() => {
		const element = prompt.current;
		const inner = element?.firstElementChild;
		const win = element?.ownerDocument.defaultView;
		if (!element || !inner || !win) return;
		const measure = () => {
			const lineHeight = Number.parseFloat(win.getComputedStyle(element).lineHeight);
			setClampable(inner.getBoundingClientRect().height > lineHeight * 12 + 1);
		};
		measure();
		const observer = new win.ResizeObserver(measure);
		observer.observe(inner);
		return () => observer.disconnect();
	}, [content]);

	return (
		<div className="scribe-chat-message is-user" role="group" aria-label={text.chatYou}>
			{(selection || refs.length > 0) && (
				<ul className="scribe-message-context" aria-label={text.chatContextLabel}>
					{selection ? <li>
						<details className="scribe-message-selection">
							<summary className="scribe-message-chip" title={selection.path}>
								<ChatIcon name="text-select" />
								<span>{selection.title}</span>
							</summary>
							<pre className="scribe-chat-pre" tabIndex={0} aria-label={text.chatSelectionPreview}>{selection.text}</pre>
						</details>
					</li> : refs.map((ref, index) => (
						<li key={`${ref.path}:${index}`} className="scribe-message-chip" title={ref.path}>
							<ChatIcon name={ref.kind === 'folder' ? 'folder' : 'file-text'} />
							<span>{ref.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? ref.path}</span>
						</li>
					))}
				</ul>
			)}
			<div id={id} ref={prompt} className="scribe-user-prompt" data-clamped={clampable && !expanded}
				onFocus={() => { if (clampable) setExpanded(true); }}>
				<AnswerContent app={app} content={content} />
			</div>
			{clampable && <button type="button" className="scribe-expand-message" aria-controls={id} aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}>{expanded ? text.chatCollapseMessage : text.chatExpandMessage}</button>}
		</div>
	);
}

export default memo(function ChatTurn({
	app, execution, step, live, request,
}: { app: App; execution: ChatExecution; step?: RunStep; live?: boolean; request?: SubmittedPrompt }) {
	const text = uiText();
	const { state, draft, modelRetry, turn } = execution;
	const { user, process, answer, time, tokens, lastCall, showProcessSummary } = useMemo(
		() => chatTurnContent(execution, step), [execution, step],
	);
	const status = state?.status ?? 'idle';
	const statuses: Record<RunStatus, string> = {
		idle: text.noExecution,
		running: text.chatRunning,
		'awaiting-approval': text.chatApprovalHeading,
		done: text.phaseDone,
		'file-changes-done': state?.resumed ? text.chatResumedAllDone : text.chatAllDone,
		partial: text.chatPartiallyDone,
		failed: text.chatFailed,
		cancelled: text.chatStopped,
		interrupted: text.chatInterrupted,
		limit: text.chatRunLimit,
	};
	const running = status === 'running' || status === 'awaiting-approval';
	const streaming = Boolean(live && status === 'running' && !modelRetry && draft);
	const showStep = status === 'interrupted' || status === 'cancelled' || status === 'limit' || status === 'failed';
	const statusLabel = modelRetry === 'manual' ? text.chatWaitingForConnection
		: modelRetry === 'automatic' ? text.chatReconnecting : streaming ? text.chatResponding : statuses[status];
	const tools = process.filter((item) => item.kind === 'tool');
	const failures = tools.filter(({ result, skipped }) => result?.isError && !skipped).length;
	const skipped = tools.filter((item) => item.skipped).length;
	const lastStep = step && showStep ? [
		text.chatLastStep,
		{ starting: text.chatStepStarting, model: text.chatStepModel, tool: text.chatStepTool,
			approval: text.chatStepApproval, 'tool-result': text.chatStepResult }[step.phase],
		step.call?.name, lastCall && actionTarget(lastCall),
	].filter(Boolean).join(' · ') : '';
	const copyText = answer + draft;
	const hasReply = Boolean(copyText.trim());
	const replyTime = draft ? undefined : time;
	const showStatus = status !== 'done' || !hasReply;
	const activities = process.map((item, index) => {
		if (item.kind === 'tool') {
			return <ToolActivityRow key={index} call={item.call} result={item.result} skipped={item.skipped}
				status={status} statusLabel={statuses[status]} />;
		}
		return item.kind === 'thinking' ? (
			<details key={index} className="scribe-thinking-card">
				<summary className="scribe-activity-heading">
					<ChatIcon name="brain" /><span className="scribe-activity-label">{text.chatThinking}</span>
				</summary>
				<div className="scribe-activity-body scribe-turn-thinking">{item.content}</div>
			</details>
		) : <AnswerContent key={index} app={app} content={item.content} />;
	});

	async function copyReply() {
		try {
			await navigator.clipboard.writeText(copyText);
			new Notice(text.chatCopiedReply);
		} catch {
			new Notice(text.chatCopyFailed);
		}
	}

	return (
		<article className="scribe-chat-run">
			{(request?.instruction || user) && <UserMessage app={app} request={request} content={request?.instruction || user} />}
			<div className="scribe-assistant-turn" role="group" aria-label={text.chatAssistant}>
				{showProcessSummary ? (
					<details className="scribe-turn-process">
						<summary className="scribe-activity-heading">
							<ChatIcon name="list-checks" />
							<span className="scribe-activity-label">
								<span>{text.chatProcess}</span>
								{tools.length > 0 && <span className="scribe-process-count"> · {text.chatToolCount.replace('{count}', tools.length.toLocaleString())}</span>}
							</span>
							{failures > 0 && <span className="scribe-process-count is-error">{text.chatToolFailures.replace('{count}', failures.toLocaleString())}</span>}
							{skipped > 0 && <span className="scribe-process-count">{text.chatToolSkipped} {skipped.toLocaleString()}</span>}
						</summary>
						<div className="scribe-activity-body" role="group" aria-label={text.chatToolActivity}>{activities}</div>
					</details>
				) : activities}
				{hasReply && <AnswerContent app={app} content={copyText} />}
				{showStatus && <div className="scribe-execution-status" data-status={status} role={live ? 'status' : undefined}>
					{running && !modelRetry && <ChatIcon name={status === 'awaiting-approval' ? 'clock' : 'loader-circle'} />}
					<span>{statusLabel}{turn > 0 && <> · {text.chatTurn} {turn}</>}</span>
				</div>}
				{state?.error && <div className="scribe-chat-error scribe-turn-error" role={live ? 'alert' : undefined}>{state.error}</div>}
				{lastStep && <div className="scribe-chat-last-step">{lastStep}</div>}
				{!running && hasReply && (
					<div className="scribe-turn-tail">
						<div className="scribe-turn-metadata">
							{replyTime && <time dateTime={replyTime.toISOString()} title={`${text.chatReplyTime}: ${replyTime.toLocaleString()}`}>
								{replyTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
							</time>}
							{!draft && tokens !== undefined && <span>{text.chatReplyUsage.replace('{tokens}', tokens.toLocaleString())}</span>}
						</div>
						<button type="button" aria-label={text.chatCopyReply} title={text.chatCopyReply}
							onClick={() => void copyReply()}><ChatIcon name="copy" /></button>
					</div>
				)}
			</div>
		</article>
	);
});
