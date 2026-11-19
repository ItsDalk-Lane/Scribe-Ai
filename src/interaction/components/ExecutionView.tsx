import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { App } from 'obsidian';
import type { SavedRun, TaskRequest } from '../../types';
import { chatTurnPreview } from '../chatTurnContent';
import { restoredTimelineExpansion, toggleTimelineExpansion } from '../chatTimeline';
import { restoreExecution } from '../context';
import type { ChatExecution, DisplayedRun } from '../context';
import { uiText } from '../uiText';
import ChatTurn from './ChatTurn';
import ChatIcon from './ChatIcon';
import TurnNavigator from './TurnNavigator';

const expansionKey = 'scribe-ai:timeline-expanded';

function turnAtScroll(column: HTMLDivElement | null, top: number) {
	const rows = column?.children;
	if (!rows?.length) return undefined;
	let lo = 0;
	let hi = rows.length;
	while (lo + 1 < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if ((rows.item(mid) as HTMLElement).offsetTop <= top) lo = mid;
		else hi = mid;
	}
	return rows.item(lo)?.getAttribute('data-task-id') ?? undefined;
}

export default function ExecutionView({
	app, execution, history, loading, conversationId, liveRequest, liveModel, editingId, onEdit, onFork,
}: {
	app: App; execution: ChatExecution; history: DisplayedRun[]; loading: boolean; conversationId: string | null;
	liveRequest?: TaskRequest; liveModel?: SavedRun['model']; editingId?: string;
	onEdit?: (taskId: string) => void; onFork?: (taskId: string) => void;
}) {
	const text = uiText();
	const scroll = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const jumpedTop = useRef<number | undefined>(undefined);
	const [away, setAway] = useState(false);
	const [current, setCurrent] = useState<string>();
	const [expanded, setExpanded] = useState(() => restoredTimelineExpansion(app.loadLocalStorage(expansionKey)));
	const toggleExpanded = useCallback((id: string) => setExpanded((previous) => toggleTimelineExpansion(previous, id)), []);
	const restored = useMemo(() => history.map((run) => ({
		id: run.state.taskId, execution: restoreExecution(run), request: run.request, step: run.step, model: run.model,
	})), [history]);
	const savedEntries = useMemo(() => restored.map((run) => ({
		id: run.id, ...chatTurnPreview(run.execution, run.request.instruction),
	})), [restored]);
	const last = execution.state?.taskId ?? restored.at(-1)?.id;
	const entries = execution.state
		? [...savedEntries, { id: execution.state.taskId, ...chatTurnPreview(execution, liveRequest?.instruction) }]
		: savedEntries;

	useEffect(() => {
		app.saveLocalStorage(expansionKey, [...expanded]);
	}, [app, expanded]);

	useLayoutEffect(() => {
		follow.current = true;
		jumpedTop.current = undefined;
		setAway(false);
	}, [conversationId]);
	useLayoutEffect(() => {
		if (!follow.current || !scroll.current) return;
		scroll.current.scrollTop = scroll.current.scrollHeight;
		setCurrent(last);
	}, [execution, restored, loading, conversationId, last]);
	useLayoutEffect(() => {
		const element = scroll.current;
		const inner = content.current;
		if (!element || !inner) return;
		const ownerWindow = element.ownerDocument.defaultView;
		if (!ownerWindow) return;
		const resize = new ownerWindow.ResizeObserver(() => {
			if (follow.current) element.scrollTop = element.scrollHeight;
		});
		resize.observe(element);
		resize.observe(inner);
		return () => resize.disconnect();
	}, []);

	const turns = restored.map(({ id, ...run }) =>
		<ChatTurn key={id} app={app} expanded={expanded} toggleExpanded={toggleExpanded} editing={editingId === id}
			onEdit={onEdit && (() => onEdit(id))} onFork={onFork && (() => onFork(id))} {...run} />);
	if (execution.state) turns.push(<ChatTurn key={execution.state.taskId} app={app} execution={execution}
		request={liveRequest} model={liveModel} expanded={expanded} toggleExpanded={toggleExpanded} live />);

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
					if (currentTarget.scrollTop === jumpedTop.current) return;
					jumpedTop.current = undefined;
					follow.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 32;
					setAway(!follow.current);
					setCurrent(follow.current ? last : turnAtScroll(content.current, currentTarget.scrollTop + 16));
				}}
			>
				<div className="scribe-chat-column" ref={content}>
					{loading ? <p className="scribe-chat-loading" role="status">{text.chatLoadingHistory}</p> : turns}
				</div>
			</div>
			{!loading && entries.length > 1 && <TurnNavigator key={conversationId} entries={entries} current={current} onJump={jumpTo} />}
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
