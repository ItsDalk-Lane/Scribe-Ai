import { memo, useId, useMemo, useState } from 'react';
import type { RunStatus, ToolCall, ToolResult } from '../../types';
import { toolCardDetails, toolTextPreview } from '../toolCardDetails';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';
import FileChanges from './FileChanges';

type ToolDetails = ReturnType<typeof toolCardDetails>;

const toolIcons = {
	read: 'file-text',
	search: 'search',
	write: 'file-plus',
	edit: 'file-pen',
	notebook: 'notebook-pen',
	terminal: 'terminal',
	generic: 'wrench',
} satisfies Record<ToolDetails['kind'], string>;

const toolStatusIcons = {
	running: 'loader-circle',
	waiting: 'clock',
	success: 'check',
	error: 'x',
	skipped: 'circle-stop',
	stopped: 'circle-stop',
};

export const ToolActivityRow = memo(function ToolActivityRow({
	call, result, skipped, status, statusLabel,
}: { call: ToolCall; result?: ToolResult; skipped?: boolean; status: RunStatus; statusLabel: string }) {
	const text = uiText();
	const details = useMemo(() => toolCardDetails(call), [call]);
	const [opened, setOpened] = useState(false);
	const state = skipped ? 'skipped' : result ? (result.isError ? 'error' : 'success')
		: status === 'awaiting-approval' ? 'waiting' : status === 'running' ? 'running' : 'stopped';
	const label = skipped ? text.chatToolSkipped : result ? (result.isError ? text.phaseError : text.phaseDone) : statusLabel;
	const target = details.kind === 'search' ? details.pattern ?? details.target
		: details.kind === 'terminal' ? details.description ?? details.command ?? details.target : details.target;
	const headline = {
		read: text.chatToolRead,
		search: text.chatToolSearch,
		write: text.chatToolWrite,
		edit: text.chatToolEdit,
		notebook: text.chatToolEdit,
		terminal: text.chatToolRun,
		generic: `${call.name} {target}`,
	}[details.kind];
	const summary = target ? headline.replace('{target}', () => target) : call.name;
	return (
		<details className="scribe-tool-card" data-state={state} onToggle={({ currentTarget }) => setOpened(currentTarget.open)}>
			<summary className="scribe-activity-heading">
				<ChatIcon name={toolIcons[details.kind]} />
				<span className="scribe-activity-label" title={summary} dir="auto">{summary}</span>
				<span className="scribe-tool-status" role="img" aria-label={label} title={label}>
					<ChatIcon name={toolStatusIcons[state]} />
				</span>
			</summary>
			{opened && <div className="scribe-activity-body scribe-tool-body">
				<section aria-label={text.chatToolArguments}>
					<strong>{text.chatToolArguments}</strong>
					{details.target && <div className="scribe-chat-path" title={details.target} dir="auto">{details.target}</div>}
					<ToolInputDetails details={details} />
				</section>
				<section aria-label={text.chatToolOutput}>
					<strong>{text.chatToolOutput}</strong>
					{result?.content ? <ToolText value={result.content} /> : (
						<div className="scribe-tool-meta">
							{state === 'running' || state === 'waiting' ? text.chatToolWaitingOutput : text.chatToolNoOutput}
						</div>
					)}
				</section>
			</div>}
		</details>
	);
});

function ToolInputDetails({ details }: { details: ToolDetails }) {
	const text = uiText();
	switch (details.kind) {
		case 'terminal':
			return details.command !== undefined && <ToolText label={text.chatCommand} value={details.command} />;
		case 'read':
			return <div className="scribe-tool-meta">
				{details.offset !== undefined && <span>{text.chatToolFromLine.replace('{line}', Math.max(1, details.offset).toLocaleString())}</span>}
				{details.limit !== undefined && <span>{text.chatToolMaxLines.replace('{count}', details.limit.toLocaleString())}</span>}
			</div>;
		case 'search':
			return <>
				{details.pattern !== undefined && <ToolText label={text.chatToolPattern} value={details.pattern} />}
				{details.glob !== undefined && <ToolText label={text.chatToolFileFilter} value={details.glob} />}
			</>;
		case 'write':
			return details.content !== undefined && <ToolText label={text.chatToolRequestedContent} value={details.content} />;
		case 'edit':
			return details.before !== undefined && details.after !== undefined && <div className="scribe-tool-change">
				<strong>{text.chatToolRequestedEdit}</strong>
				<FileChanges before={details.before} after={details.after} fragment />
			</div>;
		case 'notebook': {
			const action = details.mode && {
				insert: text.chatToolCellInsert, replace: text.chatToolCellReplace, delete: text.chatToolCellDelete,
			}[details.mode];
			return <>
				<div className="scribe-tool-meta">
					{action && <span>{action}</span>}
					{details.cellId && <span>{text.chatToolCell}: <code>{details.cellId}</code></span>}
				</div>
				{details.source !== undefined && <ToolText label={text.chatToolRequestedContent} value={details.source} />}
			</>;
		}
		case 'generic':
			return details.input !== undefined && <ToolText value={details.input} />;
	}
}

function ToolText({ label, value }: { label?: string; value: string }) {
	const text = uiText();
	const id = useId();
	const [full, setFull] = useState(false);
	const preview = useMemo(() => toolTextPreview(value), [value]);
	return (
		<div>
			{label && <strong>{label}</strong>}
			{value ? <pre id={id} className="scribe-chat-pre" tabIndex={0}>
				{full || preview === null ? value : preview + '\n…'}
			</pre> : <div className="scribe-tool-meta">{text.chatToolEmptyText}</div>}
			{preview !== null && <button type="button" className="scribe-tool-more" aria-expanded={full} aria-controls={id}
				onClick={() => setFull(!full)}>{full ? text.chatToolLessText : text.chatToolMoreText}</button>}
		</div>
	);
}
