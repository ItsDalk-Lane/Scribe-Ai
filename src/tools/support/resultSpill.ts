import { Buffer } from 'node:buffer';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** DSH's base `maxInlineTokens`: estimated tokens a single model-facing tool result may keep inline. */
export const MAX_INLINE_TOKENS = 12_500;
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const GAP = '\n…（输出中间已省略）…\n';
const RETRIEVAL = '用 Read 工具按 offset/limit 读取，或用 Grep 搜索。';

let directory: string | undefined;
let sequence = 0;

/** Heuristic token price used by DSH: text density plus one block overhead. */
export function estimateResultTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}

function safeHead(text: string, chars: number): string {
	let end = Math.min(Math.max(0, chars), text.length);
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return text.slice(0, end);
}

function safeTail(text: string, chars: number): string {
	let start = Math.max(0, text.length - Math.max(0, chars));
	const code = text.charCodeAt(start);
	if (code >= 0xdc00 && code <= 0xdfff) start += 1;
	return text.slice(start);
}

function saveResult(text: string): string | undefined {
	try {
		if (directory === undefined) {
			directory = mkdtempSync(join(tmpdir(), 'scribe-ai-tools-'));
			chmodSync(directory, 0o700);
		}
		const path = join(directory, `result-${process.pid}-${sequence++}.txt`);
		writeFileSync(path, text, { mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}

/**
 * Bound one complete text tool result to DSH's inline token budget. Oversized
 * text keeps ordered head and tail previews and stores the full result in a
 * private file whose path the model can read.
 */
export function boundToolResult(text: string, toolName: string): string {
	if (toolName.toLowerCase() === 'read' || estimateResultTokens(text) <= MAX_INLINE_TOKENS) return text;
	const path = saveResult(text);
	if (path === undefined) return text;
	const totalBytes = Buffer.byteLength(text, 'utf8');
	const worstNotice = `\n\n（已省略 ${totalBytes} 字节。完整结果：${path}。${RETRIEVAL}）`;
	const reserved = estimateResultTokens(worstNotice) + estimateResultTokens(GAP);
	let contentChars = Math.max(0, Math.floor((MAX_INLINE_TOKENS - reserved) * CHARS_PER_TOKEN));
	for (let attempt = 0; attempt < 6; attempt++) {
		const head = safeHead(text, Math.ceil(contentChars / 2));
		const tail = safeTail(text, contentChars - head.length);
		const omitted = totalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
		const notice = `\n\n（已省略 ${omitted} 字节。完整结果：${path}。${RETRIEVAL}）`;
		const result = `${head}${GAP}${tail}${notice}`;
		if (estimateResultTokens(result) <= MAX_INLINE_TOKENS || contentChars === 0) return result;
		contentChars = Math.floor(contentChars * 0.9);
	}
	return `\n\n（已省略 ${totalBytes} 字节。完整结果：${path}。${RETRIEVAL}）`;
}
