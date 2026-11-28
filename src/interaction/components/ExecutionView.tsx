import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { LocalState } from '../../orchestration/storage/localState';
import type { SavedRun, SkillRegistry, SubagentSnapshot, TaskRequest } from '../../types';
import { chatTurnPreview } from '../chatTurnContent';
import { toggleTimelineExpansion } from '../chatTimeline';
import { restoreExecution } from '../context';
import type { ChatExecution, DisplayedRun } from '../context';
import { uiText } from '../uiText';
import ChatTurn from './ChatTurn';
import ChatIcon from './ChatIcon';
import type { InspectSubagent } from './SubagentsPanel';
import TranscriptSelection from './TranscriptSelection';
import TurnNavigator from './TurnNavigator';

function turnAtScroll(column: HTMLDivElement | null, top: number) {
	const rows = column?.children;
	if (!rows?.length) return undefined;
	let lo = 0;
	let hi = rows.length;
	while (hi && !rows.item(hi - 1)?.hasAttribute('data-task-id')) hi--;
	if (!hi) return undefined;
	while (lo + 1 < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if ((rows.item(mid) as HTMLElement).offsetTop <= top) lo = mid;
		else hi = mid;
	}
	return rows.item(lo)?.getAttribute('data-task-id') ?? undefined;
}

export default function ExecutionView({
	app, localState, skills, execution, history, reports, loading, conversationId, liveRequest, liveModel, editingId, onEdit, onFork,
	onQuoteSelection, onSideChatSelection, temporary = false, automaticReview = false, renderActivity,
	submissions, inspectSubagent, subagentNames, trailingActivity,
}: {
	app: App; skills: SkillRegistry; execution: ChatExecution; history: DisplayedRun[]; loading: boolean; conversationId: string | null;
	localState?: LocalState;
	liveRequest?: TaskRequest; liveModel?: SavedRun['model']; editingId?: string;
	reports?: SubagentSnapshot['reports'];
	onEdit?: (taskId: string) => void; onFork?: (taskId: string) => void;
	onQuoteSelection?: (quote: string) => void; onSideChatSelection?: (quote: string) => void; temporary?: boolean;
	automaticReview?: boolean; renderActivity?: (taskId: string) => ReactNode;
	submissions?: SubagentSnapshot['submissions']; inspectSubagent?: InspectSubagent; subagentNames?: ReadonlyMap<string, string>;
	trailingActivity?: ReactNode;
}) {
	const text = uiText();
	const scroll = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const jumpedTop = useRef<number | undefined>(undefined);
	const [away, setAway] = useState(false);
	const [current, setCurrent] = useState<string>();
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => localState?.timelineExpanded() ?? new Set());
	const toggleExpanded = useCallback((id: string) => {
		if (!localState) {
			setExpanded((previous) => toggleTimelineExpansion(previous, id));
			return;
		}
		const next = toggleTimelineExpansion(localState.timelineExpanded(), id);
		setExpanded(next);
		void localState.saveTimelineExpanded(next).catch(() => new Notice(text.saveFailed));
	}, [localState, text.saveFailed]);
	const restored = useMemo(() => history.map((run) => ({
		id: run.state.taskId, execution: restoreExecution(run), request: run.request, step: run.step, model: run.model,
		subagentReport: run.subagentReport,
	})), [history]);
	const savedEntries = useMemo(() => restored.map((run) => ({
		id: run.id, ...chatTurnPreview(run.execution, run.request.instruction, reports?.[run.id] ?? run.subagentReport),
	})), [reports, restored]);
	const liveId = execution.state?.taskId;
	const liveReport = liveId ? reports?.[liveId] : undefined;
	const last = liveId ?? restored.at(-1)?.id;
	const entries = liveId
		? [...savedEntries, { id: liveId, ...chatTurnPreview(execution, liveRequest?.instruction, liveReport) }]
		: savedEntries;

	useLayoutEffect(() => {
		follow.current = true;
		jumpedTop.current = undefined;
		setAway(false);
	}, [conversationId]);
	useLayoutEffect(() => {
		if (!follow.current || !scroll.current?.clientHeight) return;
		scroll.current.scrollTop = scroll.current.scrollHeight;
		setCurrent(last);
	}, [execution, restored, reports, loading, conversationId, last]);
	useLayoutEffect(() => {
		const element = scroll.current;
		const inner = content.current;
		if (!element || !inner) return;
		const ownerWindow = element.ownerDocument.defaultView;
		if (!ownerWindow) return;
		const resize = new ownerWindow.ResizeObserver(() => {
			if (follow.current && element.clientHeight) element.scrollTop = element.scrollHeight;
		});
		resize.observe(element);
		resize.observe(inner);
		return () => resize.disconnect();
	}, []);

	const turns = restored.map(({ id, subagentReport, ...run }) =>
		<ChatTurn key={id} app={app} skills={skills} expanded={expanded} toggleExpanded={toggleExpanded} editing={editingId === id}
			completedActivity={renderActivity?.(id)}
			subagentReport={reports?.[id] ?? subagentReport}
			submissions={submissions} inspectSubagent={inspectSubagent} subagentNames={subagentNames}
			onEdit={onEdit && (() => onEdit(id))} onFork={onFork && (() => onFork(id))} readOnly={temporary} {...run} />);
	if (liveId) turns.push(<ChatTurn key={liveId} app={app} skills={skills} execution={execution}
		completedActivity={renderActivity?.(liveId)} subagentReport={liveReport}
		submissions={submissions} inspectSubagent={inspectSubagent} subagentNames={subagentNames}
		request={liveRequest} model={liveModel} expanded={expanded} toggleExpanded={toggleExpanded} readOnly={temporary} automaticReview={automaticReview} live />);

	function jumpTo(id: string) {
		const element = scroll.current;
		const target = Array.from(content.current?.querySelectorAll<HTMLElement>(':scope > .scribe-chat-run') ?? [])
			.find((row) => row.dataset.taskId === id);
		if (!element || !target) return;
		target.focus({ preventScroll: true });
		element.scrollTop = target.offsetTop;
		jumpedTop.current = element.scrollTop;
		follow.current = id === last && element.scrollHeight - element.scrollTop - element.clientHeight < 32;
		setAway(!follow.current);
		setCurrent(id);
	}

	return (
		<div className="scribe-execution-view">
			<div
				className="scribe-chat-scroll"
				role="region"
				aria-label={text.chatTranscript}
				tabIndex={0}
				ref={scroll}
				onScroll={({ currentTarget }) => {
					if (!currentTarget.clientHeight || currentTarget.scrollTop === jumpedTop.current) return;
					jumpedTop.current = undefined;
					follow.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 32;
					setAway(!follow.current);
					setCurrent(follow.current ? last : turnAtScroll(content.current, currentTarget.scrollTop + 16));
				}}
			>
				<div className="scribe-chat-column" ref={content}>
					{loading ? <p className="scribe-chat-loading" role="status">{text.chatLoadingHistory}</p> : turns}
					{!loading && trailingActivity}
				</div>
			</div>
			{!loading && (onQuoteSelection || onSideChatSelection) && <TranscriptSelection key={conversationId} scroll={scroll}
				content={content} onQuote={onQuoteSelection} onSideChat={onSideChatSelection} />}
			{!loading && entries.length > 1 && <TurnNavigator key={`${conversationId}:turns`} entries={entries} current={current} onJump={jumpTo} />}
			{!loading && away && (
				<button type="button" className="scribe-chat-jump" aria-label={text.chatLatest} title={text.chatLatest} onClick={() => {
					const element = scroll.current;
					if (!element) return;
					element.focus({ preventScroll: true });
					follow.current = true;
					jumpedTop.current = undefined;
					element.scrollTop = element.scrollHeight;
					setAway(false);
					setCurrent(last);
				}}><ChatIcon name="arrow-down" /></button>
			)}
		</div>
	);
}
