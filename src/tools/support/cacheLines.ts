import { Buffer } from 'node:buffer';
import type { ToolContext } from '../../types';
import { openToolFile, TEXT_LINE_BREAK } from './fileAccess';
import type { ResolvedToolPath } from './pathUtils';
import { MAX_SHELL_SPILL_BYTES } from './resultSpill';

/** 按打开时的长度读取，命令继续输出不会拖住当前请求；超长单行只保留调用方所需的前缀。 */
export async function* cacheLineBatches(ctx: ToolContext, path: ResolvedToolPath, maxLineChars: number): AsyncGenerator<string[]> {
	if (!path.cacheOutput) throw new Error('请选择当前聊天的输出文件。');
	const { file, size } = await openToolFile(path);
	try {
		if (size > MAX_SHELL_SPILL_BYTES) throw new Error('输出文件超过缓存大小限制。');
		const buffer = Buffer.alloc(64 * 1024);
		const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
		let pending = '';
		let afterCR = false;
		let position = 0;
		while (position < size) {
			ctx.signal.throwIfAborted();
			const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
			if (!bytesRead) throw new Error('输出文件已变化，请重新读取。');
			position += bytesRead;
			let chunk = decoder.decode(buffer.subarray(0, bytesRead), { stream: position < size });
			if (chunk.includes('\0')) throw new Error('输出包含二进制数据，无法按文本处理。');
			if (afterCR && chunk.startsWith('\n')) chunk = chunk.slice(1);
			afterCR = chunk.endsWith('\r');
			const lines = chunk.split(TEXT_LINE_BREAK);
			lines[0] = pending + lines[0]!.slice(0, maxLineChars - pending.length);
			pending = lines.pop()!;
			if (lines.length) yield lines;
		}
		if (pending) yield [pending];
	} finally {
		await file.close();
	}
}
