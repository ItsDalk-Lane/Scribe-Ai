import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RunStep, SavedRun, SkillRegistry, SubagentSnapshot, TaskRequest } from '../../types';
import type { SkillReadReceipt } from '../../skills/readReceipt';
import { abbreviatedNumber, completedMessages, messageTime, runUsage } from '../chatMetrics';
import { chatTurnContent } from '../chatTurnContent';
import type { NoticeRow, TimelineItem } from '../chatTimeline';
import type { ChatExecution } from '../context';
import { updateOverflowTitle } from '../overflowTitle';
import { collaborationRows } from '../subagentTimeline';
import { subagentUiText } from '../subagentUiText';
import { actionTarget } from '../toolCardDetails';
import { uiText } from '../uiText';
import ActivityDisclosure from './ActivityDisclosure';
import AnswerContent from './AnswerContent';
import ChatIcon from './ChatIcon';
import ChatMarkdown from './ChatMarkdown';
import CollaborationActivity from './CollaborationActivity';
import { chatDuration, UsagePopover } from './ChatMetrics';
import type { InspectSubagent } from './SubagentsPanel';
import { SkillActivityRow } from './SkillActivityRow';
import { ToolActivityGroup, ToolActivityRow } from './ToolActivityRow';
import WorkingRow from './WorkingRow';

type SubmittedPrompt = Pick<TaskRequest, 'instruction' | 'refs' | 'selection' | 'chatQuotes' | 'skillMentions' | 'skillScope'>;

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

export function UserMessage({ app, content, request, timestamp, editing, onEdit, readOnly }: {
	app: App; content: string; request?: SubmittedPrompt; timestamp?: number; editing?: boolean; onEdit?: () => void; readOnly?: boolean;
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
	const quotes = request?.chatQuotes ?? [];
	const skills = [...new Map(request?.skillMentions?.map((item) => [item.id, item])).values()];
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
			{(selection || refs.length > 0 || quotes.length > 0 || skills.length > 0) && (
				<ul className="scribe-message-context" aria-label={text.chatContextLabel}>
					{skills.map((skill) => <li className="scribe-message-chip" key={skill.id} title={skill.id}>
						<ChatIcon name="book-open" /><span>${skill.name} · {skill.sourceLabel ?? skill.id}</span>
					</li>)}
					{quotes.length > 0 && <li>
						<details className="scribe-message-selection">
							<summary className="scribe-message-chip"><ChatIcon name="quote" />
								<span>{text.chatQuotedText.replace('{n}', String(quotes.length))}</span>
							</summary>
							<pre className="scribe-chat-pre" tabIndex={0} aria-label={text.chatSelectionPreview}>{quotes.join('\n\n')}</pre>
						</details>
					</li>}
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
				<AnswerContent app={app} content={content} media={false} />
			</div>
			{clampable && <button type="button" className="scribe-expand-message" aria-controls={id} aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}>{expanded ? text.chatCollapseMessage : text.chatExpandMessage}</button>}
			<div className="scribe-message-actions scribe-user-actions">
				<button type="button" className="scribe-message-action" onClick={() => void copy()}>
					<ChatIcon name={copied ? 'check' : 'copy'} /><span aria-live="polite">{copied ? text.chatMessageCopied : text.chatCopyMessage}</span>
				</button>
				{!readOnly && <button type="button" className="scribe-message-action" disabled={!onEdit} onClick={onEdit}>
					<ChatIcon name={editing ? 'x' : 'pencil'} /><span>{editing ? text.chatCancelEdit : text.chatEditFromHere}</span>
				</button>}
				<Timestamp timestamp={timestamp} />
			</div>
		</div>
	);
}

function TurnProcess({ summary, initiallyOpen, render }: { summary: string; initiallyOpen: boolean; render: () => ReactNode }) {
	const [open, setOpen] = useState(initiallyOpen);
	const id = useId();
	return <div className="scribe-turn-process">
		<button type="button" className="scribe-process-summary" aria-expanded={open} aria-controls={open ? id : undefined}
			onClick={() => setOpen(!open)}
			onPointerEnter={({ currentTarget }) => updateOverflowTitle(currentTarget, currentTarget.querySelector('span:last-child'))}>
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
		failed: text.chatFailed,
		cancelled: text.chatStopped,
		interrupted: text.chatInterrupted,
		limit: text.chatRunLimit,
		collaboration: subagentUiText().error,
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
	app, skills, execution, live, request, step, model, editing, onEdit, onFork, expanded, toggleExpanded, readOnly, automaticReview,
	completedActivity, subagentReport, submissions, inspectSubagent, subagentNames, childChat = false, parentAgentId = 'root',
}: {
	app: App; skills: SkillRegistry; execution: ChatExecution; live?: boolean; request?: SubmittedPrompt; step?: RunStep;
	model?: SavedRun['model']; editing?: boolean; onEdit?: () => void; onFork?: () => void; readOnly?: boolean; automaticReview?: boolean;
	expanded: ReadonlySet<string>; toggleExpanded: (id: string) => void;
	completedActivity?: ReactNode; childChat?: boolean; parentAgentId?: string;
	subagentReport?: SavedRun['subagentReport'];
	submissions?: SubagentSnapshot['submissions']; inspectSubagent?: InspectSubagent;
	subagentNames?: ReadonlyMap<string, string>;
}) {
	const text = uiText();
	const { state, modelRetry } = execution;
	const skillContext = useRef({ request, messages: state?.messages });
	skillContext.current = { request, messages: state?.messages };
	const loadSkill = useCallback((receipt: SkillReadReceipt) => {
		const { request, messages } = skillContext.current;
		const scope = request?.skillScope ?? skills.scope(request?.refs, '');
		const folders = new Set([...scope, ...(messages ?? []).flatMap((message) =>
			message.role === 'user' ? message.skillScope ?? [] : [])]);
		return skills.readRecorded(receipt, [...folders]);
	}, [skills]);
	const content = useMemo(() => chatTurnContent(execution), [execution]);
	const { user, answer, copyText, answerMessage } = content;
	const rows = useMemo(() => collaborationRows(content.rows, submissions, childChat ? parentAgentId : undefined),
		[childChat, content.rows, submissions, parentAgentId]);
	const messages = useMemo(() => completedMessages(state?.messages ?? []), [state?.messages]);
	const usage = useMemo(() => state ? runUsage(state) : undefined, [state]);
	const status = state?.status ?? 'idle';
	const running = status === 'running' || status === 'awaiting-approval';
	const lateActivity = !running && completedActivity;
	const hasProcess = rows.length > 0 || Boolean(lateActivity);
	const hasReply = Boolean(answer.trim());
	// 子 Agent 聊天的提问要和收到的答复一起直接可见。
	const showChildCollaboration = rows.some((row) => row.kind === 'subagent' || row.kind === 'to-parent');
	const foldProcess = !showChildCollaboration && (hasReply && !running || rows.some((row) => row.kind === 'collaboration') || Boolean(lateActivity));
	const showActivity = state && running && live;
	const statusLabel = status === 'awaiting-approval' ? (automaticReview ? text.chatTimelineAutoReview : text.chatTimelineApproval)
		: modelRetry === 'manual' ? text.chatTimelineWaitingConnection
		: modelRetry === 'automatic' ? text.chatReconnecting : text.chatResponding;
	const end = state?.finishedAt ?? messageTime(answerMessage);
	const duration = state?.createdAt && end ? chatDuration(end - state.createdAt) : undefined;
	const summary = childChat && duration ? subagentUiText().workedFor.replace('{duration}', duration)
		: [text.chatProcessSummary.replace('{messages}', abbreviatedNumber(messages.length))
			.replace('{tools}', abbreviatedNumber(messages.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0))),
		duration].filter(Boolean).join(' · ');

	async function copyReply(content: string) {
		try {
			await navigator.clipboard.writeText(content);
			new Notice(text.chatCopiedReply);
		} catch {
			new Notice(text.chatCopyFailed);
		}
	}

	const renderTimeline = () => <div className="scribe-chat-timeline">
		{rows.map((row) => {
			switch (row.kind) {
				case 'collaboration':
					return <CollaborationActivity key={row.id} action={row.action} agentId={row.agentId}
						name={subagentNames?.get(row.agentId) ?? row.agentName ?? row.agentId} inspect={inspectSubagent} />;
				case 'to-parent':
					return <AnswerContent key={row.id} app={app}
						content={row.question ? subagentUiText().questionPrefix + row.content : row.content} />;
				case 'text':
					return <AnswerContent key={row.id} app={app} content={row.content} />;
				case 'notice':
					return <TimelineNotice key={row.id} item={row} live={live}
						lastStep={step && state?.status === row.code && row === rows.at(-1)
							? lastStepLabel(step, execution.items) : undefined} />;
				case 'subagent':
					return <UserMessage key={row.id} app={app} content={row.content} readOnly />;
				case 'skill-steering':
					return <UserMessage key={row.id} app={app} content={row.content} readOnly
						request={{ instruction: row.content, refs: [], skillMentions: row.mentions }} />;
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
					if (row.kind === 'tool' && row.call.name === 'read_skill') return <SkillActivityRow key={row.id}
						call={row.call} result={row.result} skipped={row.skipped} status={status}
						load={loadSkill} expanded={expanded.has(row.id)} onToggle={() => toggleExpanded(row.id)} />;
					const members = row.kind === 'tool' ? [row] as const : row.members;
					const first = members[0];
					const groupExpanded = expanded.has(row.id);
					const showRows = row.kind === 'tool' || groupExpanded;
					const showShellOutput = live && status === 'running';
					return (
						<ToolActivityGroup key={first.id} call={first.call} count={members.length}
							shellOutput={showShellOutput && !showRows ? members.at(-1)?.shellOutput : undefined}
							expanded={groupExpanded} onToggle={() => toggleExpanded(row.id)}>
							{members.map((item) => <ToolActivityRow key={item.id} app={app}
								call={item.call} result={item.result} skipped={item.skipped} resolved={item.resolved}
									shellOutput={showShellOutput && showRows ? item.shellOutput : undefined}
								status={status} statusLabel={running ? statusLabel : text.chatInterrupted}
								expanded={expanded.has(item.id)} onToggle={() => toggleExpanded(item.id)} />)}
						</ToolActivityGroup>
					);
				}
			}
		})}
		{lateActivity}
	</div>;

	return (
		<article className="scribe-chat-run" data-task-id={state?.taskId} tabIndex={-1}>
			{(request?.instruction || user) && <UserMessage app={app} request={request} content={request?.instruction || user}
				timestamp={state?.createdAt} editing={editing} onEdit={onEdit} readOnly={readOnly || Boolean(request?.selection)} />}
			{!editing && (hasProcess || hasReply || showActivity || usage) && <div className="scribe-assistant-turn" role="group" aria-label={text.chatAssistant}>
				{hasProcess && (foldProcess
					? <TurnProcess key={running ? 'live' : 'finished'} summary={summary} initiallyOpen={running} render={renderTimeline} />
					: renderTimeline())}
				{hasReply && <AnswerContent app={app} content={answer} />}
				{showActivity && <WorkingRow key={state.taskId} state={state}
					modelIntent={execution.modelIntent}
					override={status === 'awaiting-approval' || modelRetry ? statusLabel : undefined} />}
				{!running && (Boolean(copyText.trim()) || usage) && <div className="scribe-message-actions scribe-assistant-actions">
					<Timestamp timestamp={messageTime(answerMessage) ?? answerMessage?.rawAssistant?.timestamp} />
					{hasReply && !readOnly && <button type="button" className="scribe-message-action"
						disabled={!onFork} onClick={onFork}><ChatIcon name="git-branch" /><span>{text.chatForkReply}</span></button>}
					{usage && <UsagePopover usage={usage} model={model} turn />}
					{Boolean(copyText.trim()) && <button type="button" className="scribe-message-action scribe-reply-copy"
						aria-label={text.chatCopyReply}
						onClick={() => void copyReply(copyText)}><ChatIcon name="copy" /></button>}
				</div>}
			</div>}
			{!editing && subagentReport && <div className="scribe-assistant-turn scribe-subagent-report" role="group"
				aria-label={text.chatSubagentReport}>
				<AnswerContent app={app} content={subagentReport.content} />
				<div className="scribe-message-actions scribe-assistant-actions">
					<Timestamp timestamp={subagentReport.sentAt} />
					<button type="button" className="scribe-message-action scribe-reply-copy" aria-label={text.chatCopyReply}
						onClick={() => void copyReply(subagentReport.content)}><ChatIcon name="copy" /></button>
				</div>
			</div>}
		</article>
	);
});
