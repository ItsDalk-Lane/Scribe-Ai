import { useEffect, useId, useRef, useState } from 'react';
import { formatWorkingElapsed } from '../formatWorkingElapsed';
import { tr } from '../skills/dialog';
import { uiText } from '../uiText';
import { goalText } from '../useChatGoal';
import type { useChatGoal } from '../useChatGoal';
import ChatIcon from './ChatIcon';

function GoalClock({ elapsedMs, workStartedAt }: { elapsedMs: number; workStartedAt?: number }) {
	const element = useRef<HTMLTimeElement>(null);
	const [now, setNow] = useState(() => performance.now());
	useEffect(() => {
		const win = element.current?.ownerDocument.defaultView;
		if (!win || workStartedAt === undefined) return;
		const tick = () => setNow(performance.now());
		tick();
		const timer = win.setInterval(tick, 1000);
		return () => win.clearInterval(timer);
	}, [workStartedAt]);
	const elapsed = elapsedMs + (workStartedAt === undefined ? 0 : Math.max(0, now - workStartedAt));
	const duration = formatWorkingElapsed(elapsed, uiText());
	const label = tr('AI 工作时间', 'AI work time');
	return <time ref={element} className="scribe-goal-status-time" dateTime={`PT${Math.floor(elapsed / 1000)}S`}
		aria-label={`${label} · ${duration}`} title={label}>{duration}</time>;
}

export default function ChatGoalStatus({ goal, hide = false }: { goal: ReturnType<typeof useChatGoal>; hide?: boolean }) {
	const text = goalText();
	const detailsId = useId();
	const value = goal.value;
	const checks = value?.progress?.checks ?? [];
	const pending = value?.progress?.remaining ?? value?.criteria ?? [];
	function control(action: 'pause' | 'resume' | 'edit' | 'clear') {
		void goal.command(action).catch((cause: unknown) => goal.setError(cause instanceof Error ? cause.message : text.saveFailed));
	}
	return <>
		{goal.error && <div role="alert" className="scribe-chat-error">{goal.error}</div>}
		{value && !hide && <section className="scribe-goal-status" data-status={value.status} aria-label={text.title}>
			<div className="scribe-goal-status-row">
				<button type="button" className="scribe-goal-status-toggle" aria-expanded={goal.opened} aria-controls={detailsId}
					onClick={() => goal.setOpened(!goal.opened)}>
					<span className="scribe-goal-status-icon"><ChatIcon name="target" /></span>
					<strong>{text[value.status]}</strong>
					<span className="scribe-goal-status-objective" title={value.objective}>{value.objective}</span>
					<span className="scribe-goal-status-chevron"><ChatIcon name="chevron-down" /></span>
				</button>
				<GoalClock elapsedMs={goal.elapsedMs} workStartedAt={goal.workStartedAt} />
				<div className="scribe-goal-status-actions">
					<button type="button" className="scribe-chat-icon-button" aria-label={text.edit} title={text.edit}
						onClick={() => control('edit')}><ChatIcon name="square-pen" /></button>
					<button type="button" className="scribe-chat-icon-button" aria-label={text.clear} title={text.clear}
						onClick={() => control('clear')}><ChatIcon name="trash-2" /></button>
					{value.status === 'active' && <button type="button" className="scribe-chat-icon-button" aria-label={text.pause} title={text.pause}
						onClick={() => control('pause')}><ChatIcon name="circle-pause" /></button>}
					{value.status === 'paused' && <button type="button" className="scribe-chat-icon-button" aria-label={text.resume} title={text.resume}
						onClick={() => control('resume')}><ChatIcon name="circle-play" /></button>}
				</div>
			</div>
			<div id={detailsId} hidden={!goal.opened} className="scribe-goal-status-details">
				<p>{value.objective}</p>
				<p>{text.current} {value.usedRounds}/{value.maxRounds} · {text.total} {value.totalRounds}</p>
				{value.status === 'paused' && value.reason && <p>{text.reasons[value.reason]}</p>}
				{value.progress?.blocked && value.status !== 'complete' && <p>{value.progress.blocked}</p>}
				{value.status === 'active' && !goal.error && <p>{goal.working ? text.working : text.waiting}</p>}
				{checks.length > 0 && <><strong>{text.checked}</strong><ul>{checks.map(({ criterion, evidence, notePaths }) =>
					<li key={criterion}>{criterion} · {evidence}{notePaths?.length ? ` (${notePaths.join('、')})` : ''}</li>)}</ul></>}
				{pending.length > 0 && value.status !== 'complete' && <><strong>{text.remaining}</strong><ul>
					{pending.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}
				</ul></>}
				{value.evidence && !checks.length && <p><strong>{text.proof}</strong> · {value.evidence}</p>}
			</div>
		</section>}
	</>;
}
