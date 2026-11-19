import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RunStep, SavedRun, TaskRequest } from '../../types';
import { abbreviatedNumber, completedMessages, messageTime, usageTotals } from '../chatMetrics';
import { chatTurnContent } from '../chatTurnContent';
import type { NoticeRow, TimelineItem } from '../chatTimeline';
import type { ChatExecution } from '../context';
import { actionTarget } from '../toolCardDetails';
import { uiText } from '../uiText';
import ActivityDisclosure from './ActivityDisclosure';
import AnswerContent from './AnswerContent';
import ChatIcon from './ChatIcon';
import ChatMarkdown from './ChatMarkdown';
import { chatDuration, UsagePopover } from './ChatMetrics';
import { ToolActivityGroup, ToolActivityRow } from './ToolActivityRow';

type SubmittedPrompt = Pick<TaskRequest, 'instruction' | 'refs' | 'selection'>;

function Timestamp({ timestamp }: { timestamp?: number }) {
	if (!timestamp) return null;
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return null;
	const clock = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
	const today = date.toDateString() === new Date().toDateString();
	return <time dateTime={date.toISOString()} title={date.toLocaleString()}>
		{!today && <>{date.toLocaleDateString()} </>}{date.toLocaleTimeString(undefined, clock)}
	</time>;
}

function UserMessage({ app, content, request, timestamp, editing, onEdit }: {
	app: App; content: string; request?: SubmittedPrompt; timestamp?: number; editing?: boolean; onEdit?: () => void;
}) {
	const text = uiText();
	const id = useId();
	const prompt = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [clampable, setClampable] = useState(false);
	const [copied, setCopied] = useState(false);
	const cancelCopyTimer = useRef<() => void>(undefined);
	const mounted = useRef(false);
	const selection = request?.selection;
	const refs = request?.refs ?? [];
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			cancelCopyTimer.current?.();
		};
	}, []);

	async function copy() {
		const view = prompt.current?.ownerDocument.defaultView;
		if (!view?.navigator.clipboard) return;
		try {
			await view.navigator.clipboard.writeText(content);
		} catch {
			return;
		}
		if (!mounted.current) return;
		cancelCopyTimer.current?.();
		setCopied(true);
		const timer = view.setTimeout(() => setCopied(false), 1500);
		cancelCopyTimer.current = () => view.clearTimeout(timer);
	}

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
			<div className="scribe-message-actions scribe-user-actions">
				<button type="button" className="scribe-message-action" onClick={() => void copy()}>
					<ChatIcon name={copied ? 'check' : 'copy'} /><span aria-live="polite">{copied ? text.chatMessageCopied : text.chatCopyMessage}</span>
				</button>
				<button type="button" className="scribe-message-action" disabled={!onEdit} onClick={onEdit}>
					<ChatIcon name={editing ? 'x' : 'pencil'} /><span>{editing ? text.chatCancelEdit : text.chatEditFromHere}</span>
				</button>
				<Timestamp timestamp={timestamp} />
			</div>
		</div>
	);
}

function TurnProcess({ summary, render }: { summary: string; render: () => ReactNode }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	return <div className="scribe-turn-process">
		<button type="button" className="scribe-process-summary" aria-expanded={open} aria-controls={open ? id : undefined}
			onClick={() => setOpen(!open)} title={summary}>
			<ChatIcon name={open ? 'chevron-down' : 'chevron-right'} /><span>{summary}</span>
		</button>
		{open && <div id={id}>{render()}</div>}
	</div>;
}

function TimelineNotice({ item, live, lastStep }: { item: NoticeRow; live?: boolean; lastStep?: string }) {
	const text = uiText();
	const label = {
		reconnect: text.chatReconnecting,
		connection: text.chatWaitingForConnection,
		context: text.chatTimelineContextRetry,
		skipped: text.chatToolSkipped,
		partial: text.chatPartiallyDone,
		failed: text.chatFailed,
		cancelled: text.chatStopped,
		interrupted: text.chatInterrupted,
		limit: text.chatRunLimit,
	}[item.code];
	const icon = item.resolved ? 'circle-check'
		: { error: 'circle-alert', warning: 'triangle-alert', info: 'info' }[item.tone];
	return (
		<div className="scribe-timeline-notice" data-tone={item.tone} title={lastStep}
			role={live && item.tone === 'error' ? 'alert' : undefined}>
			<ChatIcon name={icon} />
			<span>{label}{item.detail && item.detail !== label && <> · {item.detail}</>}
				{item.resolved && <> · {text.chatResolved}</>}</span>
		</div>
	);
}

function lastStepLabel(step: RunStep, items: readonly TimelineItem[]): string {
	const text = uiText();
	const tool = [...items].reverse().find((item) => item.kind === 'tool' && item.call.id === step.call?.id
		&& item.call.name === step.call?.name);
	return [
		text.chatLastStep,
		{ starting: text.chatStepStarting, model: text.chatStepModel, tool: text.chatStepTool,
			approval: text.chatStepApproval, 'tool-result': text.chatStepResult }[step.phase],
		step.call?.name, tool?.kind === 'tool' && actionTarget(tool.call),
	].filter(Boolean).join(' · ');
}

export default memo(function ChatTurn({
	app, execution, live, request, step, model, editing, onEdit, onFork, expanded, toggleExpanded,
}: {
	app: App; execution: ChatExecution; live?: boolean; request?: SubmittedPrompt; step?: RunStep;
	model?: SavedRun['model']; editing?: boolean; onEdit?: () => void; onFork?: () => void;
	expanded: ReadonlySet<string>; toggleExpanded: (id: string) => void;
}) {
	const text = uiText();
	const { state, modelRetry } = execution;
	const { user, rows, answer, copyText, showCompletion, hasProcess, answerMessage } = useMemo(() => chatTurnContent(execution), [execution]);
	const messages = useMemo(() => completedMessages(state?.messages ?? []), [state?.messages]);
	const usage = useMemo(() => usageTotals(messages), [messages]);
	const status = state?.status ?? 'idle';
	const running = status === 'running' || status === 'awaiting-approval';
	const hasReply = Boolean(answer.trim());
	const statusLabel = status === 'awaiting-approval' ? text.chatTimelineApproval
		: modelRetry === 'manual' ? text.chatTimelineWaitingConnection
		: modelRetry === 'automatic' ? text.chatReconnecting : text.chatResponding;
	const end = state?.finishedAt ?? messageTime(answerMessage);
	const summary = [text.chatProcessSummary.replace('{messages}', abbreviatedNumber(messages.length))
		.replace('{tools}', abbreviatedNumber(messages.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0))),
	state?.createdAt && end ? chatDuration(end - state.createdAt) : undefined].filter(Boolean).join(' · ');

	async function copyReply() {
		try {
			await navigator.clipboard.writeText(copyText);
			new Notice(text.chatCopiedReply);
		} catch {
			new Notice(text.chatCopyFailed);
		}
	}

	const renderTimeline = () => <div className="scribe-chat-timeline">
		{rows.map((row) => {
			switch (row.kind) {
				case 'text':
					return <AnswerContent key={row.id} app={app} content={row.content} />;
				case 'notice':
					return <TimelineNotice key={row.id} item={row} live={live}
						lastStep={step && state?.status === row.code && row === rows.at(-1)
							? lastStepLabel(step, execution.items) : undefined} />;
				case 'thinking': {
					const open = expanded.has(row.id);
					const seconds = row.durationMs === undefined ? undefined : Math.round(row.durationMs / 1000);
					const label = row.pending ? text.chatThinkingPending : seconds === undefined ? text.chatThinking
						: text.chatThinkingDuration.replace('{n}', seconds.toLocaleString());
					return (
						<ActivityDisclosure key={row.id} className="scribe-thinking-card" icon="brain" label={label}
							labelContent={row.pending && !open && row.content.trim() ? (
								<span className="scribe-thinking-live">
									<span>{label}</span>
									<span className="scribe-thinking-preview"><bdi>{row.content}</bdi></span>
								</span>
							) : undefined}
							expanded={open} onToggle={() => toggleExpanded(row.id)}>
							<div className="scribe-turn-thinking"><ChatMarkdown app={app} content={row.content} /></div>
						</ActivityDisclosure>
					);
				}
				case 'tool':
				case 'tool-group': {
					const members = row.kind === 'tool' ? [row] as const : row.members;
					const first = members[0];
					return (
						<ToolActivityGroup key={first.id} call={first.call} count={members.length}
							expanded={expanded.has(row.id)} onToggle={() => toggleExpanded(row.id)}>
							{members.map((item) => <ToolActivityRow key={item.id} app={app}
								call={item.call} result={item.result} skipped={item.skipped} resolved={item.resolved}
								status={status} statusLabel={running ? statusLabel : text.chatInterrupted}
								expanded={expanded.has(item.id)} onToggle={() => toggleExpanded(item.id)} />)}
						</ToolActivityGroup>
					);
				}
			}
		})}
	</div>;

	return (
		<article className="scribe-chat-run" data-task-id={state?.taskId} tabIndex={-1}>
			{(request?.instruction || user) && <UserMessage app={app} request={request} content={request?.instruction || user}
				timestamp={state?.createdAt} editing={editing} onEdit={onEdit} />}
			{!editing && <div className="scribe-assistant-turn" role="group" aria-label={text.chatAssistant}>
				{hasProcess && (hasReply && !running ? <TurnProcess summary={summary} render={renderTimeline} /> : renderTimeline())}
				{hasReply && <AnswerContent app={app} content={answer} />}
				{running && live && <div className="scribe-timeline-activity" role="status">
					<ChatIcon name="loader-circle" /><span>{statusLabel}</span>
				</div>}
				{showCompletion && <div className="scribe-timeline-notice" role={live ? 'status' : undefined}>
					<ChatIcon name="circle-check" /><span>{text.phaseDone}</span>
				</div>}
				{!running && Boolean(copyText.trim()) && <div className="scribe-message-actions scribe-assistant-actions">
					<Timestamp timestamp={messageTime(answerMessage) ?? answerMessage?.rawAssistant?.timestamp} />
					{hasReply && <button type="button" className="scribe-message-action" aria-label={text.chatForkReply} title={text.chatForkReply}
						disabled={!onFork} onClick={onFork}><ChatIcon name="git-branch" /><span>{text.chatForkReply}</span></button>}
					{hasReply && usage && <UsagePopover usage={usage} model={model} turn />}
					<button type="button" className="scribe-message-action scribe-reply-copy" aria-label={text.chatCopyReply} title={text.chatCopyReply}
						onClick={() => void copyReply()}><ChatIcon name="copy" /></button>
				</div>}
			</div>}
		</article>
	);
});
