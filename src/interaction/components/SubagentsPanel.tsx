import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Menu, type App } from 'obsidian';
import type { ExecutionMode, SubagentController, SubagentSnapshot, SubagentView } from '../../types';
import { toggleTimelineExpansion } from '../chatTimeline';
import { questionBody, subagentChatTurns } from '../subagentTranscript';
import { subagentUiText } from '../subagentUiText';
import { thinkingLabel, uiText } from '../uiText';
import ChatIcon from './ChatIcon';
import { chatDuration } from './ChatMetrics';
import ChatTurn, { UserMessage } from './ChatTurn';
import AnswerContent from './AnswerContent';
import CollaborationActivity from './CollaborationActivity';

export function subagentIsActive({ status }: SubagentView) {
	return status === 'running' || status === 'awaiting-approval';
}

function statusLabel(agent: Pick<SubagentView, 'status' | 'closed'>) {
	const text = subagentUiText();
	const chat = uiText();
	if (agent.closed) return text.closed;
	switch (agent.status) {
		case 'idle': return text.starting;
		case 'running': return text.working;
		case 'awaiting-approval': return chat.chatTimelineApproval;
		case 'failed': return chat.chatFailed;
		case 'cancelled': return chat.chatStopped;
		case 'interrupted': return chat.chatInterrupted;
		case 'partial': return text.partial;
		case 'limit': return text.limit;
		default: return text.done;
	}
}

export type InspectSubagent = (id: string, trigger: HTMLButtonElement) => void;
export function renderSubagentsActivity({ agents, taskId, onSelect, received }: {
	agents: readonly SubagentView[]; taskId: string; onSelect: InspectSubagent; received: ReadonlySet<string>;
}) {
	const text = subagentUiText();
	const rows = agents.flatMap((agent) => agent.parentId ? [] : agent.runs.flatMap((run) =>
		run.finalized && (run.request.subagentCallerTaskId ?? agent.parentTaskId ?? agent.rootTaskId) === taskId
			&& !received.has(run.state.taskId) ? [{ agent, state: run.state }] : []));
	rows.sort((a, b) => (a.state.finishedAt ?? 0) - (b.state.finishedAt ?? 0));
	if (!rows.length) return null;
	return <div className="scribe-subagent-activity" aria-label={text.title} role="group" aria-live="polite">
		{rows.map(({ agent, state }) => state.status === 'done' || state.status === 'file-changes-done'
			? <CollaborationActivity key={state.taskId} action="completed" agentId={agent.id} name={agent.name} inspect={onSelect} />
			: <div key={state.taskId} className="scribe-timeline-notice" data-tone="warning">
				<ChatIcon name="triangle-alert" /><span>{statusLabel(state)} · <bdi>{agent.name}</bdi></span>
			</div>)}
	</div>;
}

export function SubagentDetail({ agent, app, submissions, inspectSubagent, subagentNames, onCloseTab }: {
	agent: SubagentView; app: App; submissions?: SubagentSnapshot['submissions'];
	inspectSubagent?: InspectSubagent; subagentNames?: ReadonlyMap<string, string>; onCloseTab: () => void;
}) {
	const text = subagentUiText();
	const chat = uiText();
	const id = useId();
	const log = useRef<HTMLDivElement>(null);
	const follow = useRef(!agent.runs.at(-1)?.finalized);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const { turns, pending } = useMemo(() => subagentChatTurns(agent, text.questionPrefix), [agent, text.questionPrefix]);
	const model = agent.runs.at(-1)?.model ?? agent.model;
	const reasoning = model.reasoning ? thinkingLabel(chat, model.reasoning) : text.defaultReasoning;
	useLayoutEffect(() => {
		if (log.current && follow.current) log.current.scrollTop = log.current.scrollHeight;
	}, [turns, pending]);
	return <section className="scribe-subagent-detail" aria-labelledby={id}>
		<div className="scribe-subagent-header">
			<h3 id={id} className="scribe-subagent-name"><bdi>{agent.name}</bdi></h3>
			<span className="scribe-subagent-model"><bdi>{model.model} · {reasoning}</bdi></span>
			<button type="button" className="scribe-chat-icon-button" title={chat.chatCloseTab}
				aria-label={`${chat.chatCloseTab} · ${agent.name}`} onClick={onCloseTab}><ChatIcon name="x" /></button>
		</div>
		<div className="scribe-chat-scroll scribe-subagent-log" ref={log} role="region" aria-label={text.trace} tabIndex={0}
			onScroll={({ currentTarget: element }) => {
				follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
			}}>
			<div className="scribe-chat-column">
				{turns.map(({ key, request, execution, model: turnModel }, index) => <ChatTurn key={key} app={app}
					execution={execution} request={request} model={turnModel} readOnly childChat parentAgentId={agent.parentId ?? 'root'}
					live={subagentIsActive(agent) && index === turns.length - 1} expanded={expanded}
					toggleExpanded={(row) => setExpanded((previous) => toggleTimelineExpansion(previous, row))}
					submissions={submissions} inspectSubagent={inspectSubagent} subagentNames={subagentNames} />)}
				{pending.map((note) => note.to === agent.id
					? <UserMessage key={note.id} app={app} content={note.text} readOnly />
					: <AnswerContent key={note.id} app={app} content={note.kind === 'question'
						? questionBody('', note.text, text.questionPrefix) : note.text} />)}
			</div>
		</div>
	</section>;
}

function badgeTone(agent: SubagentView) {
	if (agent.status === 'done' || agent.status === 'file-changes-done') return 'done';
	if (agent.status === 'cancelled' || agent.status === 'interrupted') return 'stopped';
	if (agent.status === 'failed') return 'error';
	if (!agent.closed && (agent.status === 'idle' || subagentIsActive(agent))) return 'active';
	return 'neutral';
}

function AgentBadge({ tone }: { tone: ReturnType<typeof badgeTone> }) {
	return <span className="scribe-agent-badge" data-tone={tone} aria-hidden="true">
		{tone !== 'active' && tone !== 'neutral' && <span className="scribe-agent-mark">{tone === 'done' && <ChatIcon name="check" />}</span>}
	</span>;
}

function capsuleStatus(agents: readonly SubagentView[], activeCount: number): { label: string; count: string; tone: ReturnType<typeof badgeTone> } {
	const text = subagentUiText();
	const [first] = agents;
	if (activeCount) return { label: text.active, count: activeCount.toLocaleString(), tone: 'active' };
	if (!first) return { label: text.title, count: '', tone: 'neutral' };
	const label = statusLabel(first);
	const tone = badgeTone(first);
	if (agents.length === 1 && first.status === 'cancelled' && !first.closed) return { label: text.activity, count: label, tone };
	return {
		label: agents.every((agent) => statusLabel(agent) === label) ? label : text.finished,
		count: agents.length.toLocaleString(),
		tone: agents.every((agent) => badgeTone(agent) === tone) ? tone : 'neutral',
	};
}

function rowStatus(agent: SubagentView, active: boolean, now: number) {
	const run = agent.runs.at(-1);
	const start = run?.state.createdAt;
	const end = active ? now : run?.state.finishedAt;
	const label = statusLabel(agent);
	if (start === undefined || end === undefined || (active && run?.finalized)) return label;
	const duration = chatDuration(Math.max(0, end - start));
	if (!duration) return label;
	return agent.status === 'running' ? uiText().chatBackgroundDurationLive.replace('{duration}', duration) : `${label} ${duration}`;
}

export default function SubagentsPanel({ controller, conversationId, snapshot, onSelect, executionMode }: {
	controller?: SubagentController; conversationId: string; snapshot: SubagentSnapshot; executionMode?: ExecutionMode; onSelect: InspectSubagent;
}) {
	const text = subagentUiText();
	const id = useId();
	const panel = useRef<HTMLElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const openMenu = useRef<Menu | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [now, setNow] = useState(Date.now);
	const [error, setError] = useState('');
	const [writing, setWriting] = useState<string>();
	const [instruction, setInstruction] = useState('');
	const [sending, setSending] = useState(false);
	const { agents } = snapshot;
	const activeCount = agents.filter((agent) => badgeTone(agent) === 'active').length;
	useEffect(() => {
		if (!expanded || !activeCount) return;
		const win = panel.current?.ownerDocument.defaultView;
		const timer = win?.setInterval(() => setNow(Date.now()), 1000);
		return () => win?.clearInterval(timer);
	}, [expanded, activeCount]);
	useEffect(() => {
		const element = panel.current;
		if (!expanded || !element) return;
		const doc = element.ownerDocument;
		const outside = (event: PointerEvent) => {
			if (!openMenu.current && !event.composedPath().includes(element)) setExpanded(false);
		};
		function escape(event: KeyboardEvent) {
			if (openMenu.current || event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			event.stopPropagation();
			setExpanded(false);
			trigger.current?.focus({ preventScroll: true });
		}
		doc.addEventListener('pointerdown', outside, true);
		doc.addEventListener('keydown', escape, true);
		return () => {
			doc.removeEventListener('pointerdown', outside, true);
			doc.removeEventListener('keydown', escape, true);
			openMenu.current?.hide();
		};
	}, [expanded]);
	if (!controller || (!agents.length && !snapshot.error)) return null;
	const summary = capsuleStatus(agents, activeCount);

	async function act(action: () => Promise<void>) {
		setError('');
		try {
			await action();
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : text.error);
			return false;
		}
	}
	function menu(agent: SubagentView, button: HTMLButtonElement) {
		if (!controller) return;
		const actions = new Menu();
		openMenu.current = actions;
		actions.onHide(() => { openMenu.current = null; });
		if (!agent.closed) actions.addItem((item) => item.setTitle(text.instruction).onClick(() => {
			if (writing !== agent.id) setInstruction('');
			setWriting(agent.id);
		}));
		if (agent.closed) actions.addItem((item) => item.setTitle(text.reopen)
			.onClick(() => { void act(() => controller.reopen(conversationId, agent.id)); }));
		else {
			if (agent.status === 'interrupted') actions.addItem((item) => item.setTitle(uiText().chatResume)
				.onClick(() => { void act(() => controller.resume(conversationId, agent.id, executionMode)); }));
			actions.addItem((item) => item.setTitle(text.close)
				.onClick(() => { void act(() => controller.close(conversationId, agent.id)); }));
		}
		if (activeCount > 1) actions.addItem((item) => item.setTitle(text.stopAll)
			.onClick(() => { void act(() => controller.stop(conversationId)); }));
		const at = button.getBoundingClientRect();
		actions.showAtPosition({ x: at.left, y: at.bottom }, button.ownerDocument);
	}
	return <section className="scribe-subagents-panel" ref={panel} aria-labelledby={`${id}-label`}>
		<span id={`${id}-label`} hidden>{text.title}</span>
		<button type="button" ref={trigger} id={`${id}-toggle`} className="scribe-subagent-toggle" aria-expanded={expanded} aria-haspopup="dialog"
			aria-labelledby={`${id}-label ${id}-toggle`} aria-controls={expanded ? id : undefined}
			onClick={() => { setNow(Date.now()); setExpanded(!expanded); }}>
			<AgentBadge tone={summary.tone} /><span>{summary.label}</span>{summary.count && <span className="scribe-subagent-count">{summary.count}</span>}
		</button>
		{expanded && <div id={id} className="scribe-subagent-popover" role="dialog" aria-label={text.title}>
		{(error || snapshot.error) && <p className="scribe-chat-error" role="alert">{error || snapshot.error}</p>}
		<ul className="scribe-subagent-list">{agents.map((agent) => {
			const tone = badgeTone(agent);
			const parent = agent.parentId && agents.find(({ id }) => id === agent.parentId);
			return <li key={agent.id} className="scribe-subagent-entry">
				<button type="button" className="scribe-subagent-row" data-agent-id={agent.id}
					onClick={(event) => { onSelect(agent.id, event.currentTarget); setExpanded(false); }}
					onContextMenu={(event) => { event.preventDefault(); menu(agent, event.currentTarget); }}>
					<AgentBadge tone={tone} />
					<span className="scribe-subagent-copy"><bdi className="scribe-subagent-row-name">{agent.name}{parent && <small> · {parent.name}</small>}</bdi>
						{agent.status === 'cancelled' && <span className="scribe-subagent-note">{text.stoppedNote}</span>}
						<span className="scribe-subagent-status">{rowStatus(agent, tone === 'active', now)}</span>
					</span>
				</button>
				{tone === 'active' && <button type="button" className="scribe-subagent-stop" aria-label={`${text.stop} · ${agent.name}`}
					onClick={() => { void act(() => controller.stop(conversationId, agent.id)); }}><ChatIcon name="circle-stop" />{text.stop}</button>}
				<button type="button" className="scribe-subagent-more" aria-haspopup="menu"
					aria-label={text.manage.replace('{agent}', () => agent.name)} onClick={(event) => menu(agent, event.currentTarget)}>
					<ChatIcon name="ellipsis" />
				</button>
			</li>;
		})}</ul>
		{writing && agents.some((agent) => agent.id === writing && !agent.closed) &&
			<form className="scribe-subagent-compose" onSubmit={(event) => {
				event.preventDefault();
				if (sending || !instruction.trim()) return;
				setSending(true);
				void act(() => controller.addInstruction(conversationId, writing, instruction.trim(), executionMode))
					.then((sent) => { if (sent) { setWriting(undefined); setInstruction(''); } })
					.finally(() => setSending(false));
			}}>
				<textarea rows={2} value={instruction} onChange={(event) => setInstruction(event.currentTarget.value)}
					aria-label={text.instruction} placeholder={text.instruction} />
				<button type="button" disabled={sending} onClick={() => setWriting(undefined)}>{uiText().cancel}</button>
				<button type="submit" className="mod-cta" disabled={sending || !instruction.trim()}>{text.send}</button>
			</form>}
		</div>}
	</section>;
}
