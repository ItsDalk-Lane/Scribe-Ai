import { Buffer } from 'node:buffer';
import type { Message, SavedRun } from '../types';
import { isSteeringMessage } from '../runtime/continuationText';
import { stripGoalReport } from './chatGoal';
import { stripPlanMarkers } from './chatPlan';

const heading = '# 历史对话 · ';
const omitted = '…（仅保留最近的部分对话）\n\n';
const maxBytes = 8_000;

function userText({ content, skillInputLength }: Message): string {
	return content.slice(0, skillInputLength)
		.replace(/\n\n聊天中选中的引文（仅供参考）\n\[[^\r\n]*\]$/u, '')
		.replace(/\n\n本次任务的资料引用：\[[^\r\n]*\]$/u, '')
		.trim();
}

function* recentMessages(runs: readonly SavedRun[]) {
	for (let index = runs.length - 1; index >= 0; index--) {
		const { request, state: { messages } } = runs[index]!;
		const instruction = request.instruction.trim();
		const firstUser = messages.findIndex((message) => message.role === 'user' && !message.subagentActivity
			&& !message.local && !isSteeringMessage(message));
		for (let position = messages.length - 1; position >= 0; position--) {
			const message = messages[position]!;
			const { role, content, incomplete, local, subagentActivity } = message;
			if (incomplete || local || subagentActivity || (role !== 'user' && role !== 'assistant')) continue;
			if (position === firstUser && request.goalContext) continue;
			const body = role === 'user' ? userText(message)
				: stripPlanMarkers(stripGoalReport(content)).trim();
			if (body && !(position === firstUser && body === instruction)) yield { role, body };
		}
		if (instruction) yield { role: 'user' as const, body: instruction };
	}
}

function tail(text: string, limit: number): string {
	if (limit <= 0) return '';
	const bytes = Buffer.from(text.slice(-limit).replace(/^[\uDC00-\uDFFF]/u, ''));
	let start = Math.max(0, bytes.length - limit);
	// 截取点移到下一个完整字符，避免在表情或中文字符的中间切断。
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return bytes.toString('utf8', start);
}

export function conversationReference(title: string, runs: readonly SavedRun[]): string | undefined {
	const name = title.replace(/\s+/gu, ' ').trim().slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '');
	const prefix = `${heading}${name || '未命名对话'}\n\n`;
	const blocks: string[] = [];
	let remaining = maxBytes - Buffer.byteLength(prefix + omitted);
	let truncated = false;
	for (const { role, body } of recentMessages(runs)) {
		const label = role === 'user' ? '用户：' : '助手：';
		const gap = blocks.length ? 2 : 0;
		const size = Buffer.byteLength(label + body) + gap;
		if (size > remaining) {
			const end = tail(body, remaining - gap - Buffer.byteLength(label + '…'));
			if (end) blocks.push(label + '…' + end);
			truncated = true;
			break;
		}
		blocks.push(label + body);
		remaining -= size;
	}
	if (blocks.length) return prefix + (truncated ? omitted : '') + blocks.reverse().join('\n\n');
	return undefined;
}

export function conversationReferenceTitle(quote: string): string | undefined {
	if (!quote.startsWith(heading)) return;
	const end = quote.indexOf('\n\n', heading.length);
	return end > heading.length ? quote.slice(heading.length, end) : undefined;
}
