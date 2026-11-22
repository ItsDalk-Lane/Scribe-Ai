import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SavedShellJob, ShellJobs, ShellJobView } from '../../tools/external/shellJobs';
import { uiText } from '../uiText';
import type { UiText } from '../uiText';
import ChatIcon from './ChatIcon';

const KILL_ARM_MS = 3_000;
const KILL_FAILED_MS = 4_000;
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 120;
const OUTPUT_POLL_MS = 1_000;
const FOCUSABLE = 'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

type JobRow = { job: ShellJobView; current: boolean };
type MenuMode = 'closed' | 'hover' | 'pinned';
type KillState = 'idle' | 'armed' | 'pending' | 'failed';
type DotState = 'running' | 'done' | 'warning' | 'error';

function isLive(job: ShellJobView): boolean {
	return job.status === 'running' || job.status === 'stopping';
}

function isObservable(job: ShellJobView): boolean {
	return isLive(job) || job.content !== undefined;
}

function jobLabel(job: ShellJobView): string {
	return job.command || `${job.name} ${job.id}`;
}

function dotState(job: ShellJobView): DotState {
	switch (job.status) {
		case 'running': return 'running';
		case 'stopping':
		case 'timed-out':
		case 'stopped': return 'warning';
		case 'success': return 'done';
		case 'failed': return job.exitCode === undefined || job.exitCode === null ? 'error' : 'warning';
		case 'start-failed': return 'error';
	}
}

function jobDetail(job: ShellJobView, text: UiText): string {
	if (job.status === 'running') return text.chatBackgroundRunning;
	if (job.status === 'stopping') return text.chatBackgroundStopping;
	if ((job.status === 'success' || job.status === 'failed')
		&& job.exitCode !== undefined && job.exitCode !== null) {
		return text.chatBackgroundExitCode.replace('{code}', String(job.exitCode));
	}
	return text.chatShellStatus[job.status];
}

function formatDuration(elapsedMs: number, text: UiText): string {
	const total = Math.max(0, Math.floor(elapsedMs / 1_000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3_600);
	if (hours > 0) {
		return text.chatBackgroundDurationHours.replace('{hours}', String(hours)).replace('{minutes}', String(minutes));
	}
	if (minutes > 0) {
		return text.chatBackgroundDurationMinutes.replace('{minutes}', String(minutes)).replace('{seconds}', String(seconds));
	}
	return text.chatBackgroundDurationSeconds.replace('{seconds}', String(seconds));
}

function ordered(rows: JobRow[]): JobRow[] {
	return [...rows].sort((left, right) => {
		const liveLeft = isLive(left.job);
		if (liveLeft !== isLive(right.job)) return liveLeft ? -1 : 1;
		if (liveLeft) return (left.job.startedAt ?? 0) - (right.job.startedAt ?? 0);
		const finished = (right.job.finishedAt ?? right.job.startedAt ?? 0)
			- (left.job.finishedAt ?? left.job.startedAt ?? 0);
		return finished !== 0 ? finished : (left.job.startedAt ?? 0) - (right.job.startedAt ?? 0);
	});
}

function durationOf(job: ShellJobView, now: number, text: UiText): { value: string; title: string } | undefined {
	const elapsed = isLive(job)
		? job.startedAt === undefined ? undefined : now - job.startedAt
		: job.startedAt === undefined || job.finishedAt === undefined ? undefined : job.finishedAt - job.startedAt;
	if (elapsed === undefined) return;
	const value = formatDuration(elapsed, text);
	const title = (isLive(job) ? text.chatBackgroundDurationLive : text.chatBackgroundDurationDone)
		.replace('{duration}', () => value);
	return { value, title };
}

function JobItem({ row, expanded, output, now, kill, copied, onToggle, onCopy }: {
	row: JobRow;
	expanded: boolean;
	output: string;
	now: number;
	copied: boolean;
	onToggle: () => void;
	onCopy: () => void;
	kill?: { state: KillState; onPress: () => void };
}) {
	const text = uiText();
	const { job } = row;
	const live = isLive(job);
	const observable = isObservable(job);
	const label = jobLabel(job);
	const detail = jobDetail(job, text);
	const duration = durationOf(job, now, text);
	const dot = <span className="scribe-job-dot" data-state={dotState(job)} aria-hidden="true" />;
	const chevron = observable
		? (
			<span className="scribe-job-chevron-box" aria-hidden="true">
				<ChatIcon name={expanded ? 'chevron-up' : 'chevron-down'} />
			</span>
		)
		: null;
	const durationCell = duration
		? <span className="scribe-job-duration" title={duration.title}>{duration.value}</span>
		: null;
	const killTitle = kill === undefined
		? undefined
		: kill.state === 'armed' ? text.chatBackgroundConfirm
			: kill.state === 'failed' ? text.chatBackgroundStopFailed
				: text.chatBackgroundStop.replace('{label}', () => label);
	const body = live
		? (
			<>
				{dot}
				<span className="scribe-job-main">
					<span className="scribe-job-primary">
						<span className="scribe-job-label" title={label}>{label}</span>
					</span>
					<span className="scribe-job-secondary">
						<span className="scribe-job-kind">{job.name.toLowerCase()}</span>
						<span className="scribe-job-status" title={detail}>{detail}</span>
						{durationCell}
					</span>
				</span>
				{chevron}
			</>
		)
		: (
			<>
				{dot}
				<span className="scribe-job-kind">{job.name.toLowerCase()}</span>
				<span className="scribe-job-label" title={label}>{label}</span>
				<span className="scribe-job-status" title={detail}>{detail}</span>
				{durationCell}
				{chevron}
			</>
		);
	const rowContent = observable
		? (
			<button
				type="button"
				className={`scribe-job-row${live ? ' is-live' : ' is-settled'}`}
				aria-expanded={expanded}
				aria-label={text[expanded ? 'chatBackgroundCollapse' : 'chatBackgroundExpand'].replace('{label}', () => label)}
				onClick={onToggle}
			>
				{body}
			</button>
		)
		: <span className={`scribe-job-row is-settled is-static`}>{body}</span>;
	return (
		<li className="scribe-job-item">
			<div className={`scribe-job-row-line${live ? ' is-live' : ''}`}>
				{rowContent}
				{kill !== undefined && (
					<button
						type="button"
						className={`scribe-job-stop${kill.state === 'armed' ? ' is-armed' : ''}${kill.state === 'failed' ? ' is-failed' : ''}`}
						disabled={kill.state === 'pending'}
						aria-label={killTitle}
						title={killTitle}
						onClick={kill.onPress}
					>
						<ChatIcon name="square" />
						{kill.state === 'armed' ? <span>{text.chatBackgroundConfirmAction}</span> : null}
						{kill.state === 'failed' ? <span>{text.chatBackgroundStopFailedLabel}</span> : null}
					</button>
				)}
			</div>
			{job.saveFailed && <div className="scribe-job-notice" role="alert">{text.chatBackgroundSaveFailed}</div>}
			{expanded && observable && (
				<div className="scribe-job-panel">
					<div className="scribe-job-terminal">
						<div className="scribe-job-terminal-command">
							<span className="scribe-job-prompt" aria-hidden="true">$</span>
							<code>{label}</code>
							{job.command && (
								<button type="button" className="scribe-job-copy" onClick={onCopy}>
									{copied ? text.chatMessageCopied : text.chatCopyMessage}
								</button>
							)}
						</div>
						<pre className="scribe-job-output" tabIndex={0} aria-label={text.chatBackgroundOutput}>
							{output || text.chatBackgroundNoOutput}
						</pre>
					</div>
				</div>
			)}
		</li>
	);
}

export default function BackgroundShellJobs({ jobs, conversationId }: { jobs: ShellJobs; conversationId: string }) {
	const text = uiText();
	const [currentRows, setCurrentRows] = useState<ShellJobView[]>(() => jobs.list(conversationId));
	const [savedRows, setSavedRows] = useState<SavedShellJob[]>([]);
	const [loadFailed, setLoadFailed] = useState(false);
	const [cleared, setCleared] = useState<ReadonlySet<string>>(() => new Set());
	const [settledOpen, setSettledOpen] = useState<boolean | undefined>(undefined);
	const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);
	const [mode, setMode] = useState<MenuMode>('closed');
	const [now, setNow] = useState(() => Date.now());
	const [outputView, setOutputView] = useState<{ key: string; text: string }>({ key: '', text: '' });
	const [killPhase, setKillPhase] = useState<{ key: string; state: KillState } | undefined>(undefined);
	const [copied, setCopied] = useState(false);
	const [readSaveFailed, setReadSaveFailed] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLElement>(null);
	const hoverOpenTimer = useRef<number | undefined>(undefined);
	const hoverCloseTimer = useRef<number | undefined>(undefined);
	const copiedTimer = useRef<number | undefined>(undefined);
	const menuId = useId();
	const activityId = useId();

	useEffect(() => {
		let alive = true;
		let revision = 0;
		const update = () => {
			if (!alive) return;
			setCurrentRows(jobs.list(conversationId));
			const request = ++revision;
			void jobs.listSaved(conversationId).then(
				(saved) => {
					if (!alive || request !== revision) return;
					setSavedRows(saved);
					setLoadFailed(false);
				},
				() => {
					if (alive) setLoadFailed(true);
				},
			);
		};
		const unsubscribe = jobs.subscribe(conversationId, update);
		update();
		return () => {
			alive = false;
			unsubscribe();
		};
	}, [jobs, conversationId]);

	const rows = useMemo(() => {
		const items = new Map<string, JobRow>();
		for (const job of savedRows) items.set(job.id, { job, current: false });
		for (const job of currentRows) items.set(job.id, { job, current: true });
		return ordered([...items.values()].filter(({ job }) => isLive(job) || !cleared.has(String(job.id))));
	}, [savedRows, currentRows, cleared]);
	const liveRows = useMemo(() => rows.filter(({ job }) => isLive(job)), [rows]);
	const settledRows = useMemo(() => rows.filter(({ job }) => !isLive(job)), [rows]);
	const visibleCount = liveRows.length + settledRows.length;
	const showTrigger = visibleCount > 0 || loadFailed;
	const open = showTrigger && mode !== 'closed';
	const settledExpanded = settledOpen ?? liveRows.length === 0;
	const count = liveRows.length > 0 ? liveRows.length : visibleCount;
	const countLabel = count === 0 ? text.chatBackgroundJobs : text[count === 1 ? 'chatBackgroundCountOne' : 'chatBackgroundCountOther']
		.replace('{count}', String(count));
	const expandedRow = open && expandedKey !== undefined
		? rows.find(({ job }) => String(job.id) === expandedKey)
		: undefined;
	const expandedId = expandedRow === undefined ? undefined : String(expandedRow.job.id);
	const expandedRunning = expandedRow !== undefined && isLive(expandedRow.job);
	const host = triggerRef.current?.closest<HTMLElement>('.scribe-app') ?? undefined;

	const cancelHover = useCallback((): void => {
		const view = triggerRef.current?.ownerDocument.defaultView;
		view?.clearTimeout(hoverOpenTimer.current);
		view?.clearTimeout(hoverCloseTimer.current);
		hoverOpenTimer.current = undefined;
		hoverCloseTimer.current = undefined;
	}, []);

	const changeOpen = useCallback((next: boolean): void => {
		cancelHover();
		if (next) setNow(Date.now());
		setMode(next ? 'pinned' : 'closed');
	}, [cancelHover]);

	const allowsHoverOpen = () => (triggerRef.current?.closest('.scribe-app')?.clientWidth ?? 0) > 460;

	const hoverEnter = (event: ReactPointerEvent<HTMLElement>): void => {
		if (event.pointerType === 'touch') return;
		cancelHover();
		if (mode !== 'closed' || !allowsHoverOpen()) return;
		const view = triggerRef.current?.ownerDocument.defaultView;
		if (!view) return;
		hoverOpenTimer.current = view.setTimeout(() => {
			hoverOpenTimer.current = undefined;
			if (!allowsHoverOpen()) return;
			setNow(Date.now());
			setMode('hover');
		}, HOVER_OPEN_MS);
	};

	const hoverLeave = (event: ReactPointerEvent<HTMLElement>): void => {
		if (event.pointerType === 'touch') return;
		cancelHover();
		if (!open || mode !== 'hover') return;
		const view = triggerRef.current?.ownerDocument.defaultView;
		if (!view) return;
		hoverCloseTimer.current = view.setTimeout(() => {
			hoverCloseTimer.current = undefined;
			setMode('closed');
		}, HOVER_CLOSE_MS);
	};

	useEffect(() => cancelHover, [cancelHover]);
	useEffect(() => () => {
		triggerRef.current?.ownerDocument.defaultView?.clearTimeout(copiedTimer.current);
	}, []);

	useEffect(() => {
		if (!showTrigger) changeOpen(false);
	}, [showTrigger, changeOpen]);

	useEffect(() => {
		if (!open) return;
		const doc = triggerRef.current?.ownerDocument;
		if (!doc) return;
		const dismiss = (event: KeyboardEvent): void => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			changeOpen(false);
			triggerRef.current?.focus({ preventScroll: true });
		};
		const outside = (event: PointerEvent): void => {
			const target = event.target;
			const view = doc.defaultView;
			if (view !== null && target instanceof view.Node
				&& (rootRef.current?.contains(target) || menuRef.current?.contains(target))) return;
			changeOpen(false);
		};
		doc.addEventListener('keydown', dismiss);
		doc.addEventListener('pointerdown', outside, true);
		return () => {
			doc.removeEventListener('keydown', dismiss);
			doc.removeEventListener('pointerdown', outside, true);
		};
	}, [open, changeOpen]);

	useEffect(() => {
		if (!open || liveRows.length === 0) return;
		setNow(Date.now());
		const view = triggerRef.current?.ownerDocument.defaultView;
		if (!view) return;
		const timer = view.setInterval(() => setNow(Date.now()), 1_000);
		return () => view.clearInterval(timer);
	}, [open, liveRows.length]);

	useEffect(() => {
		if (expandedId === undefined) {
			setOutputView({ key: '', text: '' });
			return;
		}
		const snapshot = (): void => {
			const next = jobs.outputSnapshot(conversationId, expandedId) ?? expandedRow?.job.content ?? '';
			setOutputView((previous) => previous.key === expandedId && previous.text === next
				? previous : { key: expandedId, text: next });
		};
		snapshot();
		if (!expandedRunning) return;
		const view = triggerRef.current?.ownerDocument.defaultView;
		if (!view) return;
		const timer = view.setInterval(snapshot, OUTPUT_POLL_MS);
		return () => view.clearInterval(timer);
	}, [jobs, conversationId, expandedId, expandedRunning, expandedRow?.current, expandedRow?.job.content]);

	useEffect(() => {
		setCopied(false);
		triggerRef.current?.ownerDocument.defaultView?.clearTimeout(copiedTimer.current);
	}, [expandedKey]);

	useEffect(() => {
		if (expandedKey !== undefined && !rows.some(({ job }) => String(job.id) === expandedKey)) {
			setExpandedKey(undefined);
		}
	}, [rows, expandedKey]);

	useEffect(() => {
		if (killPhase === undefined || killPhase.state === 'pending') return;
		const view = triggerRef.current?.ownerDocument.defaultView;
		if (!view) return;
		const timer = view.setTimeout(() => setKillPhase(undefined),
			killPhase.state === 'armed' ? KILL_ARM_MS : KILL_FAILED_MS);
		return () => view.clearTimeout(timer);
	}, [killPhase]);

	useEffect(() => {
		if (killPhase !== undefined && !rows.some(({ job }) => String(job.id) === killPhase.key && job.status === 'running')) {
			setKillPhase(undefined);
		}
	}, [rows, killPhase]);

	useLayoutEffect(() => {
		const trigger = triggerRef.current;
		const menu = menuRef.current;
		if (!open || !host || !trigger || !menu) return;
		const doc = host.ownerDocument;
		const win = doc.defaultView;
		if (!win) return;
		const position = (): void => {
			const bounds = host.getBoundingClientRect();
			const anchor = trigger.getBoundingClientRect();
			const width = Math.max(0, Math.min(500, bounds.width - 16));
			menu.style.width = `${width}px`;
			menu.style.left = `${Math.max(8, Math.min(anchor.left - bounds.left, bounds.width - width - 8))}px`;
			const above = Math.max(0, anchor.top - bounds.top - 12);
			const below = Math.max(0, bounds.bottom - anchor.bottom - 12);
			const opensAbove = above >= 160 || below < 160;
			const height = Math.min(480, opensAbove ? above : below);
			menu.style.maxHeight = `${height}px`;
			menu.style.top = opensAbove ? '' : `${anchor.bottom - bounds.top + 5}px`;
			menu.style.bottom = opensAbove ? `${bounds.bottom - anchor.top + 5}px` : '';
		};
		const resize = new win.ResizeObserver(position);
		resize.observe(host);
		resize.observe(trigger);
		resize.observe(menu);
		position();
		doc.addEventListener('scroll', position, true);
		return () => {
			resize.disconnect();
			doc.removeEventListener('scroll', position, true);
		};
	}, [open, host]);

	const markRead = (id: string): void => {
		setReadSaveFailed(false);
		void jobs.markRead(conversationId, id).catch(() => setReadSaveFailed(true));
	};

	const clearSettled = (): void => {
		setCleared((previous) => {
			const next = new Set(previous);
			for (const { job } of settledRows) next.add(String(job.id));
			return next;
		});
		if (expandedKey !== undefined && settledRows.some(({ job }) => String(job.id) === expandedKey)) {
			setExpandedKey(undefined);
		}
	};

	const copyCommand = (): void => {
		const command = expandedRow?.job.command;
		if (command === undefined) return;
		const view = triggerRef.current?.ownerDocument.defaultView;
		if (!view?.navigator.clipboard) return;
		void view.navigator.clipboard.writeText(command).then(() => {
			setCopied(true);
			view.clearTimeout(copiedTimer.current);
			copiedTimer.current = view.setTimeout(() => setCopied(false), 1_500);
		}, () => {});
	};

	const pressKill = (job: ShellJobView): void => {
		const key = String(job.id);
		if (killPhase?.key !== key || killPhase.state !== 'armed') {
			setKillPhase({ key, state: 'armed' });
			return;
		}
		setKillPhase({ key, state: 'pending' });
		void jobs.stop(conversationId, key).catch(() => {
			setKillPhase((current) => current?.key === key ? { key, state: 'failed' } : current);
		});
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		const trigger = triggerRef.current;
		if (event.key === 'Escape') {
			event.preventDefault();
			changeOpen(false);
			trigger?.focus({ preventScroll: true });
			return;
		}
		if (!open || event.key !== 'Tab') return;
		const menu = menuRef.current;
		if (!menu || !trigger) return;
		const focusable = Array.from(menu.querySelectorAll<HTMLElement>(FOCUSABLE));
		if (event.target === trigger) {
			if (event.shiftKey) return;
			event.preventDefault();
			focusable[0]?.focus();
		} else if (event.shiftKey ? event.target === focusable[0] : event.target === focusable.at(-1)) {
			if (event.shiftKey) event.preventDefault();
			trigger.focus();
		}
	};

	if (!showTrigger) return null;

	const output = expandedRow !== undefined && outputView.key === String(expandedRow.job.id) ? outputView.text : '';
	return (
		<div
			ref={rootRef}
			className="scribe-job-control"
			onPointerEnter={hoverEnter}
			onPointerLeave={hoverLeave}
			onKeyDown={onKeyDown}
		>
			<button
				ref={triggerRef}
				type="button"
				className="scribe-job-trigger"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				aria-label={countLabel}
				aria-describedby={liveRows.length > 0 ? activityId : undefined}
				title={countLabel}
				data-live={liveRows.length > 0 ? true : undefined}
				onClick={() => {
					if (!open) changeOpen(true);
					else if (allowsHoverOpen() && mode !== 'pinned') changeOpen(true);
					else changeOpen(false);
				}}
				onKeyDown={(event) => {
					if (event.key !== 'ArrowDown') return;
					event.preventDefault();
					changeOpen(true);
					queueMicrotask(() => menuRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus());
				}}
			>
				<span className="scribe-job-activity" aria-hidden="true">
					<ChatIcon name="layers" />
					{liveRows.length > 0 && <span className="scribe-job-indicator" />}
				</span>
				<span className="scribe-job-count">{countLabel}</span>
			</button>
			{liveRows.length > 0 && <span id={activityId} hidden>{text.chatBackgroundSectionLive}</span>}
			{open && host && createPortal(
				<section
					id={menuId}
					ref={menuRef}
					className="scribe-job-menu"
					role="dialog"
					aria-label={text.chatBackgroundJobs}
					onPointerEnter={hoverEnter}
					onPointerLeave={hoverLeave}
					onPointerDownCapture={() => changeOpen(true)}
					onFocusCapture={() => changeOpen(true)}
				>
					{loadFailed && <div className="scribe-job-notice" role="alert">{text.chatBackgroundLoadFailed}</div>}
					<ul className="scribe-job-menu-body" aria-label={text.chatBackgroundJobs}>
						{liveRows.length > 0 && <li className="scribe-job-section" aria-hidden="true">{text.chatBackgroundSectionLive}</li>}
						{liveRows.map((row) => {
							const key = String(row.job.id);
							return (
								<JobItem
									key={key}
									row={row}
									expanded={expandedKey === key}
									output={expandedKey === key ? output : ''}
									now={now}
									copied={copied}
									onToggle={() => {
										if (expandedKey === key) setExpandedKey(undefined);
										else {
											setExpandedKey(key);
											markRead(key);
										}
									}}
									onCopy={copyCommand}
									{...row.job.status === 'running'
										? {
											kill: {
												state: killPhase?.key === key ? killPhase.state : 'idle' as const,
												onPress: () => pressKill(row.job),
											},
										}
										: {}}
								/>
							);
						})}
						{settledRows.length > 0 && (
							<li className="scribe-job-section">
								<button
									type="button"
									className="scribe-job-section-toggle"
									aria-expanded={settledExpanded}
									onClick={() => setSettledOpen(!settledExpanded)}
								>
									<span className={`scribe-job-section-chevron${settledExpanded ? ' is-open' : ''}`} aria-hidden="true">
										<ChatIcon name="chevron-down" />
									</span>
									{text.chatBackgroundSettledCount.replace('{count}', String(settledRows.length))}
								</button>
								<button type="button" className="scribe-job-clear" onClick={clearSettled}>
									{text.chatBackgroundClear}
								</button>
							</li>
						)}
						{settledExpanded && settledRows.map((row) => {
							const key = String(row.job.id);
							return (
								<JobItem
									key={key}
									row={row}
									expanded={expandedKey === key}
									output={expandedKey === key ? output : ''}
									now={now}
									copied={copied}
									onToggle={() => {
										if (expandedKey === key) setExpandedKey(undefined);
										else {
											setExpandedKey(key);
											markRead(key);
										}
									}}
									onCopy={copyCommand}
								/>
							);
						})}
					</ul>
					{readSaveFailed && <div className="scribe-job-notice" role="alert">{text.chatBackgroundReadSaveFailed}</div>}
				</section>,
				host,
			)}
		</div>
	);
}
