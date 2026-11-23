import type { Message, RunEvent, ShellOutputPreview, ToolCall, ToolResult } from '../types';
import { subagentToolNames } from '../tools/subagentTools';
import { toolKind } from './toolCardDetails';

export type TextRow = { kind: 'text'; id: string; messageId: string; content: string; draft?: boolean; abandoned?: boolean; final?: true };
export type ThinkingRow = {
	kind: 'thinking'; id: string; messageId: string; content: string; pending?: boolean; durationMs?: number; draft?: boolean;
};
export type ToolRow = {
	kind: 'tool'; id: string; call: ToolCall; result?: ToolResult; shellOutput?: ShellOutputPreview; skipped?: boolean; resolved?: boolean;
};
export type NoticeRow = {
	kind: 'notice'; id: string;
	code: 'reconnect' | 'connection' | 'context' | 'skipped' | 'failed' | 'cancelled' | 'interrupted' | 'limit' | 'collaboration';
	tone: 'info' | 'warning' | 'error'; detail?: string; resolved?: boolean; messageId?: string;
};
export type SubagentRow = { kind: 'subagent'; id: string; activity: NonNullable<Message['subagentActivity']>; content: string };
type SkillSteeringRow = { kind: 'skill-steering'; id: string; content: string; mentions: NonNullable<Message['skillMentions']> };
export type TimelineItem = TextRow | ThinkingRow | ToolRow | NoticeRow | SubagentRow | SkillSteeringRow;
export type TimelineRow = TimelineItem | { kind: 'tool-group'; id: string; members: [ToolRow, ...ToolRow[]] };

export type TimelineChange =
	| { type: 'put'; item: TimelineItem }
	| { type: 'delta'; kind: 'text' | 'thinking'; messageId: string; contentIndex: number; text: string }
	| { type: 'thinking-end'; messageId: string; contentIndex: number; durationMs: number };

export function blockId(messageId: string, kind: 'text' | 'thinking', contentIndex: number): string {
	return `${messageId}:${kind}:${contentIndex}`;
}

export function attemptGroup(messageId: string): string {
	return messageId.split(':retry:', 1)[0] ?? messageId;
}

export function retryNotice(event: Extract<RunEvent, { type: 'model-retry' }>): NoticeRow {
	const messageId = attemptGroup(event.messageId);
	const code = event.reason === 'context' ? 'context' : event.waiting ? 'connection' : 'reconnect';
	return { kind: 'notice', id: `retry:${messageId}`, code, tone: 'warning', messageId };
}

export function applyTimelineChange(items: readonly TimelineItem[], change: TimelineChange): readonly TimelineItem[] {
	const id = change.type === 'put' ? change.item.id
		: blockId(change.messageId, change.type === 'delta' ? change.kind : 'thinking', change.contentIndex);
	const index = items.findIndex((item) => item.id === id);
	const previous = items[index];
	let next: TimelineItem;
	if (change.type === 'put') {
		next = change.item;
	} else if (change.type === 'thinking-end') {
		if (previous?.kind !== 'thinking') return items;
		next = { ...previous, pending: false, durationMs: change.durationMs };
	} else {
		if (!change.text) return items;
		const content = (previous?.kind === change.kind ? previous.content : '') + change.text;
		const block = { id, messageId: change.messageId, content, draft: true };
		next = change.kind === 'thinking' ? { ...block, kind: 'thinking', pending: true } : { ...block, kind: 'text' };
	}
	return index < 0 ? [...items, next] : items.map((item, position) => position === index ? next : item);
}

function groupKind({ id, call }: ToolRow): string {
	if (call.name === 'read_skill' || subagentToolNames.has(call.name)) return `single:${id}`;
	const kind = toolKind(call.name);
	return kind === 'generic' ? 'tool:' + call.name : kind === 'notebook' ? 'edit' : kind;
}

export function timelineRows(items: readonly TimelineItem[]): TimelineRow[] {
	const rows: TimelineRow[] = [];
	let group: Extract<TimelineRow, { kind: 'tool-group' }> | undefined;
	for (const item of items) {
		const last = rows.at(-1);
		if (item.kind === 'tool' && group && groupKind(group.members[0]) === groupKind(item)) {
			group.members.push(item);
			continue;
		}
		group = undefined;
		if (item.kind === 'text' && last?.kind === 'text' && item.messageId === last.messageId && item.abandoned === last.abandoned) {
			rows[rows.length - 1] = { ...last, content: last.content + item.content };
			continue;
		}
		if (item.kind === 'tool' && last?.kind === 'tool' && groupKind(last) === groupKind(item)) {
			group = { kind: 'tool-group', id: `group:${last.id}`, members: [last, item] };
			rows[rows.length - 1] = group;
		} else {
			rows.push(item);
		}
	}
	return rows;
}

const expansionLimit = 256;

export function restoredTimelineExpansion(input: unknown): ReadonlySet<string> {
	return new Set(Array.isArray(input)
		? input.filter((value): value is string => typeof value === 'string').slice(-expansionLimit) : []);
}

export function toggleTimelineExpansion(expanded: ReadonlySet<string>, id: string): ReadonlySet<string> {
	if (expanded.has(id)) return new Set([...expanded].filter((key) => key !== id));
	return restoredTimelineExpansion([...expanded, id]);
}
