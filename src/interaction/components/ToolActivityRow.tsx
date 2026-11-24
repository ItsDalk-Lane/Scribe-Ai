import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Keymap } from 'obsidian';
import type { App, FileSystemAdapter } from 'obsidian';
import { memo, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { TOOL_NOT_APPROVED } from '../../types';
import type { RunStatus, ShellOutputPreview, ToolCall, ToolResult } from '../../types';
import { formatToolInput, formatToolOutput, toolHeadingTarget, toolKind, toolTarget, toolTextPreview } from '../toolCardDetails';
import { uiText } from '../uiText';
import ActivityDisclosure from './ActivityDisclosure';
import ChatIcon from './ChatIcon';

const toolIcons = {
	read: 'file-text',
	search: 'search',
	write: 'file-plus',
	edit: 'file-pen',
	notebook: 'notebook-pen',
	terminal: 'terminal',
	generic: 'wrench',
} satisfies Record<ReturnType<typeof toolKind>, string>;

const toolStatusIcons = {
	running: 'loader-circle',
	waiting: 'clock',
	success: 'check',
	error: 'x',
	resolved: 'check',
	skipped: 'circle-stop',
	stopped: 'circle-stop',
};

function findToolNote(app: App, target: string) {
	const base = (app.vault.adapter as FileSystemAdapter).getBasePath();
	const path = relative(base, resolve(base, target));
	if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return null;
	return app.vault.getFileByPath(path.split(sep).join('/'));
}

export function ToolActivityGroup({
	call, count, shellOutput, expanded, onToggle, children,
}: { call: ToolCall; count: number; shellOutput?: ShellOutputPreview; expanded: boolean; onToggle: () => void; children: ReactNode }) {
	const text = uiText();
	const kind = toolKind(call.name);
	const label = {
		read: text.chatToolGroupRead,
		search: text.chatToolGroupSearch,
		write: text.chatToolGroupWrite,
		edit: text.chatToolGroupEdit,
		notebook: text.chatToolGroupEdit,
		terminal: text.chatToolGroupRun,
		generic: text.chatToolGroupGeneric,
	}[kind].replace('{count}', count.toLocaleString()).replace('{name}', () => call.label ?? call.name);
	return (
		<ActivityDisclosure className="scribe-tool-group" label={label} expanded={expanded} onToggle={onToggle}
			plain={count === 1} keepMounted preview={shellOutput && <ShellPreview output={shellOutput} />}>
			<div className="scribe-tool-group-rows">{children}</div>
		</ActivityDisclosure>
	);
}

export const ToolActivityRow = memo(function ToolActivityRow({
	app, call, result, shellOutput, skipped, resolved, status, statusLabel, expanded, onToggle,
}: {
	app: App; call: ToolCall; result?: ToolResult; skipped?: boolean; resolved?: boolean; status: RunStatus; statusLabel: string;
	shellOutput?: ShellOutputPreview; expanded: boolean; onToggle: () => void;
}) {
	const text = uiText();
	const kind = toolKind(call.name);
	const shellStatus = result?.shellStatus;
	const approvalReview = result?.approvalReview;
	const reviewLabel = approvalReview && text.chatShellReview[approvalReview];
	const reviewPrevented = !shellStatus && (approvalReview === 'denied' || approvalReview === 'incomplete');
	const notApproved = !shellStatus && result?.isError && result.content === TOOL_NOT_APPROVED;
	const executionLabel = shellStatus ? text.chatShellStatus[shellStatus]
		: reviewPrevented ? text.chatShellNotRun : notApproved ? text.chatShellNotApproved : undefined;
	const state = resolved ? 'resolved' : skipped || notApproved || reviewPrevented ? 'skipped' : shellStatus === 'stopped' ? 'stopped'
		: result ? (result.isError ? 'error' : 'success')
		: status === 'awaiting-approval' ? 'waiting' : status === 'running' ? 'running' : 'stopped';
	const label = executionLabel ? (resolved ? `${executionLabel} · ${text.chatResolved}` : executionLabel)
		: resolved ? text.chatResolved : skipped ? text.chatToolSkipped
		: result ? (result.isError ? text.phaseError : text.phaseDone) : statusLabel;
	const outcome = reviewLabel ? `${reviewLabel} · ${label}` : label;
	const target = toolHeadingTarget(call, (app.vault.adapter as FileSystemAdapter).getBasePath());
	const name = call.label ?? call.name;
	const title = [name, target, outcome].filter(Boolean).join(' · ');
	return (
		<ActivityDisclosure className="scribe-tool-card" state={state} icon={toolIcons[kind]} label={name}
			labelContent={target && <span className="scribe-tool-heading">
				<span>{name}</span><bdi>{target}</bdi>
			</span>}
			expanded={expanded} onToggle={onToggle} title={title} accessibilityLabel={title}
			preview={state === 'running' && shellOutput && <ShellPreview output={shellOutput} />}
			end={<span className="scribe-tool-status" aria-hidden="true">
				<ChatIcon name={toolStatusIcons[state]} />{reviewLabel ? outcome : executionLabel}
			</span>}>
			<div className="scribe-tool-body">
				<ToolInput app={app} call={call} />
				{result && <ToolOutput content={result.content} terminal={kind === 'terminal'} />}
			</div>
		</ActivityDisclosure>
	);
});

function ShellPreview({ output }: { output: ShellOutputPreview }) {
	const text = uiText();
	const labels = { stdout: text.chatShellRecentOutput, stderr: text.chatShellRecentErrors };
	return (
		<div className="scribe-shell-preview">
			{(['stdout', 'stderr'] as const).map((stream) => output[stream] && (
				<section key={stream} data-stream={stream}>
					<span>{labels[stream]}</span>
					<pre className="scribe-chat-pre" tabIndex={0} aria-label={labels[stream]}>{output[stream]}</pre>
				</section>
			))}
		</div>
	);
}

function ToolInput({ app, call }: { app: App; call: ToolCall }) {
	const text = uiText();
	const value = useMemo(() => formatToolInput(call), [call]);
	const command = toolKind(call.name) === 'terminal';
	const target = command ? undefined : toolTarget(call);
	let body: ReactNode = value;
	if (target) {
		const field = `\n  ${JSON.stringify(target.field)}: `;
		const literal = JSON.stringify(target.value);
		const start = value.indexOf(field + literal);
		const note = start < 0 ? null : findToolNote(app, target.value);
		if (note) {
			const offset = start + field.length;
			const href = `obsidian://open?vault=${encodeURIComponent(app.vault.getName())}&file=${encodeURIComponent(note.path)}`;
			body = <>
				{value.slice(0, offset)}
				<a className="scribe-tool-target" href={href} draggable={false} title={target.value}
					aria-label={text.chatOpenToolTarget.replace('{target}', () => target.value)}
					onClick={(event) => {
						event.preventDefault();
						const selection = event.currentTarget.ownerDocument.getSelection();
						if (event.detail > 0 && selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true)) return;
						const current = app.vault.getFileByPath(note.path);
						if (current) void app.workspace.getLeaf(Keymap.isModEvent(event.nativeEvent) || 'tab').openFile(current);
					}}>{literal}</a>
				{value.slice(offset + literal.length)}
			</>;
		}
	}
	return (
		<section aria-label={text.chatToolArguments}>
			<pre className={command ? 'scribe-chat-pre scribe-tool-command' : 'scribe-chat-pre'} tabIndex={0}>{body}</pre>
		</section>
	);
}

function ToolOutput({ content, terminal }: { content: string; terminal: boolean }) {
	const text = uiText();
	const id = useId();
	const [full, setFull] = useState(false);
	const value = useMemo(() => formatToolOutput(content), [content]);
	const preview = useMemo(() => terminal ? null : toolTextPreview(value), [terminal, value]);
	return (
		<section aria-label={text.chatToolOutput}>
			<pre id={id} className="scribe-chat-pre" tabIndex={0}>{full || preview === null ? value : preview + '\n…'}</pre>
			{preview !== null && <button type="button" className="scribe-tool-more" aria-expanded={full} aria-controls={id}
				onClick={() => setFull(!full)}>{full ? text.chatToolLessText : text.chatToolMoreText}</button>}
		</section>
	);
}
