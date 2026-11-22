import type { Message } from '../../types';

const rereadable = new Set(['read', 'grep', 'glob']);
const writeConfirmations = new Set(['write', 'edit', 'notebookedit', 'shelljobstop']);
const readHeader = /^[^\r\n]+（第 \d+[–-]\d+ 行）\r?\n/u;
const fullResult = /\r?\n\r?\n（已省略 \d+ 字节。完整结果：[^\r\n]+。用 Read 工具按 offset\/limit 读取，或用 Grep 搜索。）$/u;

function failed(message: Message): boolean {
	return message.isError === true || (message.shellStatus !== undefined && message.shellStatus !== 'success');
}

/** 为同一条结果生成不同长度的预览，始终保留出处和已有的全文取回说明。 */
export function toolResultPreview(message: Message): { length: number; render: (extra: number) => string } {
	const { content, shellStatus, toolName } = message;
	const source = toolName?.toLowerCase() === 'read' ? readHeader.exec(content)?.[0] ?? '' : '';
	const retrieval = fullResult.exec(content)?.[0] ?? '';
	const body = content.slice(source.length, retrieval ? content.length - retrieval.length : undefined);
	const error = failed(message);
	const preserveTail = error || shellStatus !== undefined;
	const minHead = source ? 0 : 64;
	const minTail = error ? 192 : preserveTail ? 96 : 0;
	const length = Math.max(0, body.length - minHead - minTail);
	const marker = preserveTail ? '\n…（工具结果中间已缩短）\n'
		: source ? '\n…（工具结果已缩短，可按上面的路径和行号重新读取）'
			: '\n…（工具结果已缩短，可缩小范围后重新查询）';
	return {
		length,
		render(extra) {
			const extraHead = preserveTail ? Math.floor(extra / 3) : extra;
			const headChars = minHead + extraHead;
			const tailChars = minTail + extra - extraHead;
			if (headChars + tailChars + marker.length >= body.length) return content;
			const head = body.slice(0, headChars).replace(/[\uD800-\uDBFF]$/u, '');
			const tail = tailChars ? body.slice(-tailChars).replace(/^[\uDC00-\uDFFF]/u, '') : '';
			return source + head + marker + tail + retrieval;
		},
	};
}

export function shrinkToolResults(history: Message[], current: Message[], budget: number, protectedCurrentFrom: number,
	messageBytes: (message: Message) => number): { history: Message[]; current: Message[]; shortened: number } {
	const messages = [...history, ...current];
	const candidates = [];
	let total = 0;
	for (const [index, message] of messages.entries()) {
		if (message.role !== 'tool') continue;
		const size = messageBytes(message);
		total += size;
		const name = message.toolName?.toLowerCase() ?? '';
		if (writeConfirmations.has(name) && message.content.length <= 512) continue;
		const importance = failed(message) ? 2 : rereadable.has(name) ? 0 : 1;
		const priority = (index < history.length + protectedCurrentFrom ? 0 : 3) + importance;
		candidates.push({ index, message, size, priority });
	}
	let shortened = 0;
	if (total > budget) {
		for (const { index, message, size } of candidates.sort((a, b) => a.priority - b.priority)) {
			const { length, render } = toolResultPreview(message);
			let replacement = { ...message, content: render(0) };
			let reduced = messageBytes(replacement);
			if (reduced >= size) continue;
			const target = size - (total - budget);
			// 缺口能由这条补足时，保留尽可能多的原文。
			let low = 1;
			let high = length - 1;
			while (reduced <= target && low <= high) {
				const extra = Math.floor((low + high) / 2);
				const preview = { ...message, content: render(extra) };
				const previewSize = messageBytes(preview);
				if (previewSize > target) high = extra - 1;
				else {
					replacement = preview;
					reduced = previewSize;
					low = extra + 1;
				}
			}
			messages[index] = replacement;
			shortened++;
			total -= size - reduced;
			if (total <= budget) break;
		}
	}
	return shortened ? { history: messages.slice(0, history.length), current: messages.slice(history.length), shortened }
		: { history, current, shortened };
}
