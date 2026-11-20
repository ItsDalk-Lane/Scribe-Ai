import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { RunState } from '../../types';
import { formatWorkingElapsed } from '../formatWorkingElapsed';
import { uiText } from '../uiText';
import { workingIntent } from '../workingIntent';
import ChatIcon from './ChatIcon';
import ShimmerText from './ShimmerText';

export default memo(function WorkingRow({ state, modelIntent, override }: { state: RunState; modelIntent?: string; override?: string }) {
	const text = uiText();
	const element = useRef<HTMLDivElement>(null);
	const [mountedAt] = useState(Date.now);
	const start = state.createdAt ?? mountedAt;
	const [now, setNow] = useState(Date.now);
	const messages = state.messages;
	const pendingId = state.pendingCalls[0]?.id;
	const toolIntent = useMemo(() => pendingId ? workingIntent(messages, pendingId) : undefined, [messages, pendingId]);
	const label = override ?? (pendingId ? toolIntent ?? text.chatResponding : modelIntent ?? text.chatWorkingThinking);

	useEffect(() => {
		const win = element.current?.ownerDocument.defaultView;
		if (!win) return;
		const timer = win.setInterval(() => setNow(Date.now()), 100);
		return () => win.clearInterval(timer);
	}, []);

	return <div ref={element} className="scribe-timeline-activity" role="status">
		<ChatIcon name="loader-circle" />
		<span className="scribe-working-elapsed" aria-hidden="true">{formatWorkingElapsed(Math.max(0, now - start), text)}</span>
		<span className="scribe-working-separator" aria-hidden="true">·</span>
		<ShimmerText text={label} />
		<span className="scribe-working-announcement">{label}</span>
	</div>;
});
