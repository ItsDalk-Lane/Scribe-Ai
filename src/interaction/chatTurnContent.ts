import type { Message, RunState, RunStep, SavedRetry, SavedRun, ToolCall } from '../types';
import { isSteeringMessage } from '../runtime/continuationText';
import { blockId, retryNotice, timelineRows } from './chatTimeline';
import type { NoticeRow, TextRow, TimelineItem, ToolRow } from './chatTimeline';
import type { ChatExecution } from './context';

export function toolRowId(messageId: string, callId: string): string {
	return `tool:${messageId}:${callId}`;
}

export function skippedNotice(item: ToolRow): NoticeRow {
	return { kind: 'notice', id: `skip:${item.id}`, code: 'skipped', tone: 'info', detail: item.result?.content };
}

function finalAnswerStart(state: RunState): number | undefined {
	if (state.status !== 'done' && state.status !== 'file-changes-done') return;
	const last = state.messages.at(-1);
	if (last?.role !== 'assistant' || last.incomplete || last.truncated || last.toolCalls?.length
		|| last.rawAssistant?.stopReason === 'length' || last.rawAssistant?.stopReason === 'toolUse') return;
	let start = state.messages.length - 1;
	while (start > 0) {
		const previous = state.messages[start - 1];
		if (isSteeringMessage(previous)) {
			start--;
			continue;
		}
		if (previous?.role !== 'assistant') break;
		// 旧版续写保留空的工具列表，但去掉原始响应。补做提示则没有工具列表。
		const legacyTruncation = !previous.metrics && !previous.rawAssistant && previous.toolCalls?.length === 0;
		if (!previous.truncated && !previous.incomplete && !legacyTruncation) break;
		start--;
	}
	return start;
}

export function recordedTimeline(state: RunState, step?: RunStep, retries?: SavedRun['retries']) {
	const items: TimelineItem[] = [];
	const occurrences = new Map<string, number>();
	const finished = new Set<string>();
	const answerStart = finalAnswerStart(state);
	const retriesAt = new Map<number, SavedRetry[]>();
	const noticePositions = new Map<string, number>();
	for (const retry of retries ?? []) {
		const position = Math.min(retry.beforeMessage, state.messages.length);
		const notices = retriesAt.get(position);
		if (notices) notices.push(retry);
		else retriesAt.set(position, [retry]);
	}
	function putRetries(index: number) {
		for (const { event, draft, blocks } of retriesAt.get(index) ?? []) {
			const { messageId } = event;
			const ordered = blocks ?? [
				...(draft?.content ? [{ type: 'text' as const, contentIndex: draft.textIndex ?? 0, text: draft.content }] : []),
				...(draft?.thinkingBlocks ?? []),
			].sort((a, b) => a.contentIndex - b.contentIndex);
			for (const block of ordered) {
				const id = blockId(messageId, block.type, block.contentIndex);
				if (block.type === 'text') {
					items.push({ kind: 'text', id, messageId, content: block.text, abandoned: true });
				} else if (!block.redacted) {
					items.push({ kind: 'thinking', id, messageId, content: block.thinking, durationMs: block.durationMs });
				}
			}
			const notice = retryNotice(event);
			const position = noticePositions.get(notice.id);
			if (position === undefined) {
				noticePositions.set(notice.id, items.length);
				items.push(notice);
			} else items[position] = notice;
		}
	}
	let assistant: Message | undefined;
	let assistantIndex = 0;
	let messageId: string | undefined;
	let results = new Map<string, Message>();
	const lastWithStep = step?.call && [...state.messages].reverse().find((message) => message.role === 'assistant'
		&& message.toolCalls?.some((call) => call.id === step.call?.id && call.name === step.call?.name));

	const flush = () => {
		if (!assistant || !messageId) return;
		const id = messageId;
		const raw = assistant.rawAssistant?.content ?? [];
		const calls = assistant.toolCalls ?? [];
		const rawCalls = raw.filter((block) => block.type === 'toolCall');
		const matchingText = raw.filter((block) => block.type === 'text').map((block) => block.text).join('') === assistant.content;
		const legacyOrder = !assistant.id && matchingText && rawCalls.length === calls.length
			&& rawCalls.every((block, index) => block.id === calls[index]?.id);
		const putTool = (call: ToolCall) => {
			const result = results.get(call.id);
			if (!result && (lastWithStep !== assistant || step?.call?.id !== call.id
				|| (step.phase !== 'tool' && step.phase !== 'approval'))) return;
			const item: ToolRow = { kind: 'tool', id: toolRowId(id, call.id), call };
			if (result) {
				item.result = { callId: call.id, content: result.content, isError: result.isError ?? false };
				if (result.skipped) item.skipped = true;
			}
			items.push(item);
			if (item.skipped) items.push(skippedNotice(item));
		};
		const putText = (content: string, index: number) => {
			if (content) items.push({
				kind: 'text', id: blockId(id, 'text', index), messageId: id, content,
				...(answerStart !== undefined && assistantIndex >= answerStart ? { final: true } : {}),
			});
		};
		raw.forEach((block, index) => {
			if (block.type === 'text' && matchingText) putText(block.text, index);
			if (block.type === 'thinking' && !block.redacted && block.thinking.trim()) {
				items.push({ kind: 'thinking', id: blockId(id, 'thinking', index), messageId: id, content: block.thinking, durationMs: block.durationMs });
			}
			if (block.type === 'toolCall' && legacyOrder) {
				const call = calls.find(({ id }) => id === block.id);
				if (call) putTool(call);
			}
		});
		const fallbackThinking = assistant.thinkingBlocks ?? [];
		const textIndex = assistant.textIndex ?? Math.max(0, raw.findIndex((block) => block.type === 'text'));
		let putFallbackText = !matchingText;
		for (const block of fallbackThinking) {
			if (putFallbackText && textIndex < block.contentIndex) {
				putText(assistant.content, textIndex);
				putFallbackText = false;
			}
			if (block.thinking.trim()) {
				items.push({
					kind: 'thinking', id: blockId(id, 'thinking', block.contentIndex), messageId: id,
					content: block.thinking, durationMs: block.durationMs,
				});
			}
		}
		if (putFallbackText) putText(assistant.content, textIndex);
		if (!legacyOrder) calls.forEach(putTool);
		if (!assistant.incomplete) finished.add(id);
		assistant = undefined;
	};

	for (const [index, message] of state.messages.entries()) {
		if (retriesAt.has(index)) {
			flush();
			putRetries(index);
		}
		if (message.role === 'assistant') {
			flush();
			assistant = message;
			assistantIndex = index;
			results = new Map();
			if (message.id) {
				messageId = message.id;
			} else {
				// 旧记录没有消息 id，内容指纹与同内容出现次数在追加记录时保持稳定。
				const content = JSON.stringify([message.rawAssistant?.timestamp, message.content, message.toolCalls?.map(({ id }) => id)]);
				let hash = 0;
				for (let i = 0; i < content.length; i++) hash = (Math.imul(31, hash) + content.charCodeAt(i)) | 0;
				const fingerprint = (hash >>> 0).toString(36);
				const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
				occurrences.set(fingerprint, occurrence);
				messageId = `legacy:${state.taskId}:${fingerprint}:${occurrence}`;
			}
		} else if (message.role === 'tool' && message.toolCallId) {
			results.set(message.toolCallId, message);
		}
	}
	flush();
	putRetries(state.messages.length);
	const answerMessage = answerStart === undefined ? undefined : state.messages.at(-1);
	return { items, messageId, finished, answerMessage };
}

function finalReply(items: readonly TimelineItem[]): string {
	return items.flatMap((item) => item.kind === 'text' && item.final ? [item.content] : []).join('');
}

export function chatTurnContent(execution: ChatExecution) {
	const messages = execution.state?.messages ?? [];
	const user = messages.filter(({ role }) => role === 'user').map(({ content }) => content).join('\n\n');
	const rows = timelineRows(execution.items.filter((item) => item.kind !== 'text' || !item.final))
		.filter((row) => row.kind !== 'text' || row.content.trim());
	const answer = finalReply(execution.items);
	const hasReply = Boolean(answer.trim());
	const copyText = hasReply ? answer : rows.flatMap((row) => row.kind === 'text' ? [row.content] : []).join('');
	return { user, rows, answer, copyText, hasProcess: rows.length > 0, answerMessage: execution.answerMessage };
}

export function chatTurnPreview(execution: ChatExecution, instruction?: string) {
	const snippet = (value = '') => {
		const text = value.trimStart().slice(0, 321);
		const end = (text.codePointAt(319) ?? 0) > 0xffff ? 319 : 320;
		return text.slice(0, end).replace(/\s+/gu, ' ').trimEnd() + (end < text.length ? '…' : '');
	};
	const prompt = instruction || execution.state?.messages.find(({ role }) => role === 'user')?.content;
	const reply = execution.items.filter((item): item is TextRow =>
		item.kind === 'text' && !item.abandoned && Boolean(item.content.trim())).at(-1);
	return { prompt: snippet(prompt), reply: snippet(finalReply(execution.items) || reply?.content) };
}
