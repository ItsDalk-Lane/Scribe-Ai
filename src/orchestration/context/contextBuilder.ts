import { Buffer } from 'node:buffer';
import { buildSystemPrompt } from './systemPrompt';
import type { ContextBuilder, Message, ModelRequest, TaskRequest, ToolRegistry } from '../../types';

export function taskMessage({ instruction, refs, selection, chatQuotes }: TaskRequest): Message {
	const quotes = chatQuotes?.length ? `\n\n聊天中选中的引文（仅供参考）\n${JSON.stringify(chatQuotes)}` : '';
	if (selection) {
		const [start, end] = selection.lines;
		return {
			role: 'user',
			content: `${instruction}\n\n附上的选区（${selection.title}，第 ${start}–${end} 行）\n${selection.path}\n\n${selection.text}${quotes}`,
		};
	}
	return {
		role: 'user',
		content: (refs.length ? `${instruction}\n\n本次任务的资料引用：${JSON.stringify(refs)}` : instruction) + quotes,
	};
}

const resultPreview = '\n…（工具结果已缩短，可缩小范围后重新查询）';
const replyPreview = '…（为续写，仅提供上一段回答的末尾）\n';

export class ContextBudgetError extends Error {}

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function messageBytes({ role, content, toolCalls, toolCallId, toolName, isError, rawAssistant }: Message): number {
	const blocks = rawAssistant?.content.map((block) => {
		if (block.type !== 'thinking' || block.durationMs === undefined) return block;
		const { durationMs: _duration, ...sent } = block;
		return sent;
	});
	return 32 + bytes(blocks ?? { role, content, toolCalls, toolCallId, toolName, isError });
}

function historyBytes(messages: Message[]): number {
	return messages.reduce((total, message) => total + messageBytes(message), 0);
}

export function inputBytes({ messages, system, tools }: ModelRequest): number {
	return 128 + bytes([system, tools]) + historyBytes(messages);
}

/** 从最近消息往前保留，历史按用户问答分组，当前任务按完整工具批次分组。 */
function keepRecent(messages: Message[], budget: number, history: boolean): Message[] {
	let start = messages.length;
	for (let index = start - 1; index >= 0; index--) {
		const message = messages[index]!;
		budget -= messageBytes(message);
		if (budget < 0) break;
		if (history ? message.role === 'user' : message.role !== 'tool') start = index;
	}
	return messages.slice(start);
}

function omitEmptyReplies(messages: Message[]): Message[] {
	return messages.filter((message) => message.role !== 'assistant' || message.content || message.rawAssistant || message.toolCalls?.length);
}

function retainedAgreements(agreements: string[], budget: number): Message | undefined {
	const intro = '以下是本对话中用户先前明确提出的约定，按时间从早到晚排列。只在本次任务仍适用时遵守，有冲突时以较新的用户指令为准。不要重复执行旧任务。';
	const allowance = Math.min(2_048, budget);
	let notes = '';
	for (let index = agreements.length - 1; index >= 0; index--) {
		const next = `\n- ${agreements[index]}${notes}`;
		if (messageBytes({ role: 'user', content: intro + next }) > allowance) break;
		notes = next;
	}
	return notes ? { role: 'user', content: intro + notes } : undefined;
}

function fitMessages(history: Message[], current: Message[], budget: number, agreements: string[]): Message[] {
	const first = current.slice(0, 1);
	let latest = current.length - 1;
	const continuing = current.length > 1 && current[latest]?.role === 'user';
	// 插话和续写提示可能连续出现，它们与前一条回复或工具批次一并保留。
	while (latest > first.length && current[latest]?.role === 'user') latest--;
	while (current[latest]?.role === 'tool') latest--;
	latest = Math.max(latest, first.length);
	let tail = current.slice(latest);
	const tailBudget = budget - historyBytes(first);
	if (historyBytes(tail) > tailBudget) {
		const reply = tail[0];
		const partial = continuing && reply?.role === 'assistant' && !reply.rawAssistant && !reply.toolCalls?.length ? reply : undefined;
		const preview = (message: Message) => message.content && (message === partial ? replyPreview : message.role === 'tool' ? resultPreview : '');
		const smallest = tail.map((message) => {
			const marker = preview(message);
			return marker ? { ...message, content: marker } : message;
		});
		const expandable = tail.filter(preview).length;
		const spare = tailBudget - historyBytes(smallest);
		if (spare < 0 || !expandable) throw new ContextBudgetError('本次指令、选区或工具请求过长，请缩小范围后重试。');
		// JSON 转义后一个字符最多占六字节，保留成对的工具请求和结果。
		const limit = Math.floor(spare / expandable / 6);
		tail = tail.map((message) => {
			const marker = preview(message);
			if (!marker || message.content.length <= limit) return message;
			const content = message === partial
				? marker + message.content.slice(message.content.length - limit).replace(/^[\uDC00-\uDFFF]/u, '')
				: message.content.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '') + marker;
			return { ...message, content };
		});
	}
	const middle = current.slice(first.length, latest);
	const spare = tailBudget - historyBytes(tail);
	const kept = (room: number) => {
		const recent = keepRecent(middle, room, false);
		const earlier = keepRecent(history, room - historyBytes(recent), true);
		return { earlier, recent };
	};
	const { earlier, recent } = kept(spare);
	const retained = earlier.length < history.length && agreements.length ? retainedAgreements(agreements, spare) : undefined;
	if (!retained) return [...earlier, ...first, ...recent, ...tail];
	const withAgreements = kept(spare - messageBytes(retained));
	return [retained, ...withAgreements.earlier, ...first, ...withAgreements.recent, ...tail];
}

export function createContextBuilder(registry: ToolRegistry): ContextBuilder {
	return {
		build: async (ctx, current, maxBytes) => {
			if (!ctx.permissions.canSendOutbound()) throw new Error('本次任务未授权使用模型服务。');
			const selectionOnly = Boolean(ctx.task.request.selection);
			const tools = registry.all()
				.filter((tool) => ctx.permissions.canCallTool(tool))
				.map(({ name, description, inputSchema }) => ({
					name, description,
					inputSchema: { ...inputSchema, properties: {
						...(inputSchema.properties as Record<string, unknown> | undefined),
						i: { type: 'string', description: '简体中文短句，说明当前操作要核对或完成的具体事项。' },
					} },
				}));
			const request: ModelRequest = {
				...ctx.model,
				system: buildSystemPrompt(selectionOnly, ctx.sideChat, ctx.permissions.executionMode),
				messages: [],
				tools,
				signal: ctx.signal,
				sessionId: selectionOnly ? ctx.task.id : ctx.task.request.conversationId,
			};
			request.messages = fitMessages(
				selectionOnly ? [] : omitEmptyReplies(ctx.history ?? []),
				omitEmptyReplies(current),
				maxBytes - inputBytes(request),
				selectionOnly ? [] : ctx.agreements ?? [],
			);
			return request;
		},
	};
}
