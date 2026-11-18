import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { App } from 'obsidian';
import type { SavedRun, TaskRequest } from '../../types';
import { restoreExecution } from '../context';
import type { ChatExecution } from '../context';
import { uiText } from '../uiText';
import ChatTurn from './ChatTurn';
import ChatIcon from './ChatIcon';

export default function ExecutionView({
	app, execution, history, loading, conversationId, liveRequest,
}: { app: App; execution: ChatExecution; history: SavedRun[]; loading: boolean; conversationId: string | null; liveRequest?: TaskRequest }) {
	const text = uiText();
	const scroll = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const [away, setAway] = useState(false);
	const restored = useMemo(() => history.map((run) => ({
		execution: restoreExecution(run), step: run.step, request: run.request,
	})), [history]);

	useLayoutEffect(() => {
		follow.current = true;
		setAway(false);
	}, [conversationId]);
	useLayoutEffect(() => {
		if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [execution, restored, loading, conversationId]);
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

	const turns = restored.map((run) => <ChatTurn key={run.execution.state?.taskId} app={app} {...run} />);
	if (execution.state) turns.push(<ChatTurn key={execution.state.taskId} app={app} execution={execution} request={liveRequest} live />);
	return (
		<div className="scribe-execution-view">
			<div
				className="scribe-chat-scroll"
				role="region"
				aria-label={text.chatTranscript}
				tabIndex={0}
				ref={scroll}
				onScroll={({ currentTarget }) => {
					follow.current = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 32;
					setAway(!follow.current);
				}}
			>
				<div className="scribe-chat-column" ref={content}>
					{loading ? <p className="scribe-chat-loading" role="status">{text.chatLoadingHistory}</p> : turns}
				</div>
			</div>
			{!loading && away && (
				<button type="button" className="scribe-chat-jump" aria-label={text.chatLatest} title={text.chatLatest} onClick={() => {
					const element = scroll.current;
					if (!element) return;
					element.focus({ preventScroll: true });
					follow.current = true;
					element.scrollTop = element.scrollHeight;
					setAway(false);
				}}><ChatIcon name="arrow-down" /></button>
			)}
		</div>
	);
}
