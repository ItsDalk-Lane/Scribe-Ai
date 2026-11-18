import type { Message, RunStep, ToolCall, ToolResult } from '../types';
import type { ChatExecution } from './context';

export type ProcessItem =
	| { kind: 'text' | 'thinking'; content: string }
	| { kind: 'tool'; call: ToolCall; result?: ToolResult; skipped?: boolean };

type ToolItem = Extract<ProcessItem, { kind: 'tool' }>;

export function chatTurnContent(execution: ChatExecution, step?: RunStep) {
	const messages = execution.state?.messages ?? [];
	const user = messages.filter(({ role }) => role === 'user').map(({ content }) => content).join('\n\n');
	const process: ProcessItem[] = [];
	const pending: ToolItem[] = [];
	let latestCalls = new Map<string, ToolItem>();
	let answer = '';
	let reply: Message['rawAssistant'];
	const finishProcessText = () => {
		if (answer) process.push({ kind: 'text', content: answer });
		answer = '';
		reply = undefined;
	};
	for (const message of messages) {
		if (message.role === 'assistant') {
			latestCalls = new Map();
			const calls = message.toolCalls ?? [];
			const raw = message.rawAssistant?.content ?? [];
			const rawCalls = raw.filter((block) => block.type === 'toolCall');
			// 原始块与已保存正文不一致时，以已保存的文字和调用为准。
			const useRawOrder = calls.length > 0 && rawCalls.length === calls.length
				&& rawCalls.every((block, index) => block.id === calls[index]?.id)
				&& raw.filter((block) => block.type === 'text').map((block) => block.text).join('') === message.content;
			const blocks = useRawOrder ? raw : [
				...raw.filter((block) => block.type === 'thinking'),
				{ type: 'text' as const, text: message.content },
				...calls.map(() => ({ type: 'toolCall' as const })),
			];
			let callIndex = 0;
			for (const block of blocks) {
				if (block.type === 'text' && block.text) {
					answer += block.text;
					reply = message.rawAssistant;
				} else if (block.type === 'thinking' && !block.redacted && block.thinking.trim()) {
					if (useRawOrder) finishProcessText();
					process.push({ kind: 'thinking', content: block.thinking });
				} else if (block.type === 'toolCall') {
					finishProcessText();
					const call = calls[callIndex++]!;
					const item: ToolItem = { kind: 'tool', call };
					process.push(item);
					pending.push(item);
					latestCalls.set(call.id, item);
				}
			}
			if (calls.length) finishProcessText();
		} else if (message.role === 'tool' && message.toolCallId) {
			const item = latestCalls.get(message.toolCallId);
			if (item) {
				item.result = { callId: message.toolCallId, content: message.content, isError: message.isError ?? false };
				if (message.skipped) item.skipped = true;
			}
		}
	}
	const latestTool = execution.activities.filter(({ turn, result }) => turn === execution.turn && !result).at(-1);
	const active = latestTool && latestCalls.get(latestTool.call.id);
	const lastCall = step?.call && pending.filter(({ call }) => call.id === step.call?.id).at(-1)?.call;
	const visible = process.filter((item) => item.kind !== 'tool' || item.result || item === active || item.call === lastCall);
	const total = reply?.usage?.totalTokens;
	const duration = reply?.durationMs;
	const timestamp = reply && Number.isSafeInteger(reply.timestamp) && reply.timestamp > 0
		&& typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
		? reply.timestamp + duration : undefined;
	const time = timestamp === undefined ? undefined : new Date(timestamp);
	const status = execution.state?.status;
	return {
		user, process: visible, answer, lastCall,
		showProcessSummary: Boolean(visible.length && answer.trim() && !execution.draft && !execution.state?.error
			&& (status === 'done' || status === 'file-changes-done')),
		tokens: typeof total === 'number' && Number.isSafeInteger(total) && total > 0 ? total : undefined,
		time: time && Number.isFinite(time.getTime()) ? time : undefined,
	};
}
