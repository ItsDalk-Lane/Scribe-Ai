import type { Message, RunEvent, RunState, RunStep, SavedRun, ToolApproval } from '../types';
import { toolSignature } from '../tools/support/toolSignature';
import { recordedTimeline, skippedNotice, toolRowId } from './chatTurnContent';
import { applyTimelineChange, attemptGroup, blockId, retryNotice } from './chatTimeline';
import type { NoticeRow, TimelineItem, ToolRow } from './chatTimeline';

export interface ChatApproval extends ToolApproval {
	decide(allow: boolean): void;
}

export interface ChatExecution {
	state: RunState | null;
	turn: number;
	items: readonly TimelineItem[];
	messageId?: string;
	answerMessage?: Message;
	modelRetry?: 'automatic' | 'manual';
	modelIntent?: string;
}

export type DisplayedRun = SavedRun & { displayed?: ChatExecution };

export const emptyExecution: ChatExecution = { state: null, turn: 0, items: [] };

function terminalNotice(state: RunState): NoticeRow | undefined {
	const { status } = state;
	switch (status) {
		case 'failed':
		case 'cancelled':
		case 'interrupted':
		case 'limit':
			return {
				kind: 'notice', id: `status:${state.taskId}:${state.turn}:${status}`, code: status,
				tone: status === 'failed' ? 'error' : 'warning', detail: state.error,
			};
	}
	return undefined;
}

function put(items: readonly TimelineItem[], item: TimelineItem): readonly TimelineItem[] {
	return applyTimelineChange(items, { type: 'put', item });
}

function resolveTools(items: readonly TimelineItem[]): readonly TimelineItem[] {
	const failedKinds = new Set(items.flatMap((row) => row.kind === 'tool' && row.result?.isError && !row.skipped && !row.resolved
		? [row.call.name] : []));
	if (!failedKinds.size) return items;
	const succeeded = new Set<string>();
	const next = [...items];
	for (let i = items.length - 1; i >= 0; i--) {
		const row = items[i];
		if (row?.kind !== 'tool' || !row.result || row.skipped || !failedKinds.has(row.call.name)) continue;
		const key = toolSignature(row.call);
		if (!row.result.isError) succeeded.add(key);
		else if (!row.resolved && succeeded.has(key)) next[i] = { ...row, resolved: true };
	}
	return next;
}

function acceptState(previous: ChatExecution, state: RunState, step?: RunStep, retries?: SavedRun['retries']): ChatExecution {
	const { items: saved, messageId, finished, answerMessage } = recordedTimeline(state, step, retries);
	const confirmed = new Map(saved.map((row) => [row.id, row]));
	const savedIds = new Set(state.messages.flatMap((message) => message.id ? [message.id] : []));
	const answeredAttempts = new Set([...finished].map(attemptGroup));
	const successful = state.status === 'done' || state.status === 'file-changes-done';
	const existing = previous.state?.taskId === state.taskId ? previous.items : [];
	const items = existing.flatMap((row): TimelineItem[] => {
		const recorded = confirmed.get(row.id);
		if (recorded) {
			confirmed.delete(row.id);
			return [recorded];
		}
		if ((row.kind === 'text' || row.kind === 'thinking') && row.draft && savedIds.has(row.messageId)) return [];
		return [row];
	});
	items.push(...confirmed.values());
	const resolved = items.map((row): TimelineItem => {
		if (row.kind === 'notice' && !row.resolved && row.code !== 'skipped'
			&& (row.messageId ? answeredAttempts.has(row.messageId) : successful && state.resumed)) {
			return { ...row, tone: 'info', resolved: true };
		}
		return row;
	});
	const notice = terminalNotice(state);
	const next = notice ? put(resolved, notice) : resolved;
	const modelIntent = !state.pendingCalls.length && previous.state?.taskId === state.taskId && previous.turn === state.turn
		? previous.modelIntent : undefined;
	return { state, turn: state.turn, items: resolveTools(next), messageId, answerMessage, modelIntent };
}

export function restoreExecution(run: DisplayedRun): ChatExecution {
	if (run.displayed) return run.displayed;
	const hasUser = run.state.messages.some(({ role }) => role === 'user');
	const state = hasUser ? run.state : {
		...run.state,
		messages: [{ role: 'user' as const, content: run.request.instruction }, ...run.state.messages],
	};
	const retries = hasUser ? run.retries : run.retries?.map((retry) => ({ ...retry, beforeMessage: retry.beforeMessage + 1 }));
	const restored = acceptState(emptyExecution, state, run.step, retries);
	if (!run.partial) return restored;
	const messageId = `partial:${state.taskId}:${state.turn}`;
	const item = { kind: 'text' as const, id: blockId(messageId, 'text', 0), messageId, content: run.partial };
	const last = restored.items.at(-1);
	const items = last?.kind === 'notice'
		? [...restored.items.slice(0, -1), item, last] : [...restored.items, item];
	return { ...restored, items };
}

export function updateExecution(previous: ChatExecution, event: RunEvent): ChatExecution {
	switch (event.type) {
		case 'turn-start':
			return { ...previous, turn: event.turn, modelRetry: undefined, modelIntent: undefined };
		case 'model-intent':
			return previous.modelIntent === event.intent ? previous : { ...previous, modelIntent: event.intent, modelRetry: undefined };
		case 'model-retry': {
			const items = previous.items.map((row): TimelineItem => {
				if (row.kind === 'thinking' && row.messageId === event.messageId && row.pending) return { ...row, pending: false };
				if (row.kind === 'text' && row.messageId === event.messageId && row.draft) return { ...row, abandoned: true };
				return row;
			});
			return { ...previous, items: put(items, retryNotice(event)), modelRetry: event.waiting ? 'manual' : 'automatic', modelIntent: undefined };
		}
		case 'text-delta':
		case 'thinking-delta': {
			const kind = event.type === 'text-delta' ? 'text' : 'thinking';
			const items = applyTimelineChange(previous.items, { ...event, type: 'delta', kind });
			return { ...previous, items, modelRetry: undefined };
		}
		case 'thinking-end':
			return { ...previous, items: applyTimelineChange(previous.items, event) };
		case 'tool-start':
		case 'tool-end': {
			const id = toolRowId(previous.messageId ?? `assistant:${previous.state?.taskId}:${previous.turn}`, event.call.id);
			const item: ToolRow = { kind: 'tool', id, call: event.call };
			if (event.type === 'tool-start' && previous.items.some((row) => row.id === id)) return previous;
			if (event.type === 'tool-end') {
				item.result = event.result;
				if (event.skipped) item.skipped = true;
			}
			const items = put(previous.items, item);
			return {
				...previous,
				items: event.type === 'tool-start' ? items : resolveTools(item.skipped ? put(items, skippedNotice(item)) : items),
			};
		}
		case 'state':
			return event.state === previous.state ? previous : acceptState(previous, event.state);
	}
}
