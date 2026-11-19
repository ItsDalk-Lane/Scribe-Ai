import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Keymap } from 'obsidian';
import type { App, FileSystemAdapter } from 'obsidian';
import { memo, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { RunStatus, ToolCall, ToolResult } from '../../types';
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
	call, count, expanded, onToggle, children,
}: { call: ToolCall; count: number; expanded: boolean; onToggle: () => void; children: ReactNode }) {
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
	}[kind].replace('{count}', count.toLocaleString()).replace('{name}', () => call.name);
	return (
		<ActivityDisclosure className="scribe-tool-group" label={label} expanded={expanded} onToggle={onToggle}
			plain={count === 1} keepMounted>
			<div className="scribe-tool-group-rows">{children}</div>
		</ActivityDisclosure>
	);
}

export const ToolActivityRow = memo(function ToolActivityRow({
	app, call, result, skipped, resolved, status, statusLabel, expanded, onToggle,
}: {
	app: App; call: ToolCall; result?: ToolResult; skipped?: boolean; resolved?: boolean; status: RunStatus; statusLabel: string;
	expanded: boolean; onToggle: () => void;
}) {
	const text = uiText();
	const kind = toolKind(call.name);
	const state = resolved ? 'resolved' : skipped ? 'skipped' : result ? (result.isError ? 'error' : 'success')
		: status === 'awaiting-approval' ? 'waiting' : status === 'running' ? 'running' : 'stopped';
	const label = resolved ? text.chatResolved : skipped ? text.chatToolSkipped
		: result ? (result.isError ? text.phaseError : text.phaseDone) : statusLabel;
	const target = toolHeadingTarget(call, (app.vault.adapter as FileSystemAdapter).getBasePath());
	const title = [call.name, target, label].filter(Boolean).join(' · ');
	return (
		<ActivityDisclosure className="scribe-tool-card" state={state} icon={toolIcons[kind]} label={call.name}
			labelContent={target && <span className="scribe-tool-heading">
				<span>{call.name}</span><bdi>{target}</bdi>
			</span>}
			expanded={expanded} onToggle={onToggle} title={title} accessibilityLabel={title}
			end={<span className="scribe-tool-status" aria-hidden="true" title={label}><ChatIcon name={toolStatusIcons[state]} /></span>}>
			<div className="scribe-tool-body">
				<ToolInput app={app} call={call} />
				{result && <ToolOutput content={result.content} />}
			</div>
		</ActivityDisclosure>
	);
});

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

function ToolOutput({ content }: { content: string }) {
	const text = uiText();
	const id = useId();
	const [full, setFull] = useState(false);
	const value = useMemo(() => formatToolOutput(content), [content]);
	const preview = useMemo(() => toolTextPreview(value), [value]);
	return (
		<section aria-label={text.chatToolOutput}>
			<pre id={id} className="scribe-chat-pre" tabIndex={0}>{full || preview === null ? value : preview + '\n…'}</pre>
			{preview !== null && <button type="button" className="scribe-tool-more" aria-expanded={full} aria-controls={id}
				onClick={() => setFull(!full)}>{full ? text.chatToolLessText : text.chatToolMoreText}</button>}
		</section>
	);
}
