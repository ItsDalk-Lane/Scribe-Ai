import type { ToolModule } from '../types';
import { cacheLineBatches } from './support/cacheLines';
import { fileFingerprint, fileToolInput, readToolFile, requiredText, TEXT_LINE_BREAK } from './support/fileAccess';
import { isImageFile, readCachedImage, readImageFile } from './support/imageData';
import { authorizedLineRange, recheckToolPath, resolveToolPath } from './support/pathUtils';
import { publicImageUrl, readRemoteImage } from './support/remoteImage';

const MAX_READ_RESULT_CHARS = 100_000;

export const readTools: ToolModule = () => [{
	name: 'Read',
	description: 'Read a UTF-8 text file with line numbers, or view a PNG, JPEG, GIF or WebP file or direct public HTTP(S) image URL, including links returned by tools. Relative paths start in the vault. External files and URLs may require approval. Use offset and limit only for text. A Jupyter notebook is returned as JSON; cells without an ID can be addressed as cell-0, cell-1, and so on.',
	inputSchema: {
		type: 'object',
		properties: {
			file_path: { type: 'string', description: 'Path to the file.' },
			offset: { type: 'integer', minimum: 0, description: 'First line number, starting from 1. Zero also starts at the first line.' },
			limit: { type: 'integer', minimum: 1, description: 'Number of lines to return.' },
		},
		required: ['file_path'],
		additionalProperties: false,
	},
	isReadOnly: true,
	maxResultSizeChars: MAX_READ_RESULT_CHARS,
	async prepare(input, ctx) {
		const args = fileToolInput(input, ['file_path', 'offset', 'limit']);
		const file = requiredText(args, 'file_path');
		const offset = positiveInteger(args.offset, 'offset', 0) ?? 1;
		const limit = positiveInteger(args.limit, 'limit', 1);
		if (ctx.task.request.refs.some((ref) => ref.pastedImage && !ref.lines && ref.path === file)) {
			if (args.offset !== undefined || args.limit !== undefined) throw new Error('读取图片时不要指定行号。');
			return { run: async () => ({ content: '已读取任务附带的截图。', images: [await readCachedImage(ctx.cwd, file, ctx.signal)] }) };
		}
		if (/^https?:\/\//iu.test(file)) {
			const { permissions, signal } = ctx;
			if (!permissions.executionMode || !permissions.canSendOutbound()) throw new Error('当前任务不允许通过工具下载网络图片。');
			if (args.offset !== undefined || args.limit !== undefined) throw new Error('读取图片时不要指定行号。');
			const url = publicImageUrl(file);
			return {
				...(permissions.executionMode === 'full-access' ? { independent: true as const } : {
					approval: { kind: 'web-image' as const, title: '读取网络图片', target: url.href,
						reason: '会向此网站请求图片，并将图片内容交给当前模型。' },
				}),
				async run() {
					if (!permissions.canSendOutbound()) throw new Error('当前任务不允许下载网络图片。');
					return { content: `已读取网络图片：${url.origin}`, images: [await readRemoteImage(url, signal, true)] };
				},
			};
		}
		const target = await resolveToolPath(ctx, file, 'read', { requestApproval: true, readCache: true });
		const image = isImageFile(file);
		return {
			approval: target.requiresApproval ? {
				kind: 'access', title: '读取库外文件', target: target.absolutePath,
				reason: image ? '读取整张库外图片并将其交给当前模型。'
					: `读取库外文件，从第 ${Math.max(offset, 1)} 行开始${limit === undefined ? '。' : `，最多读取 ${limit} 行。`}`,
			} : undefined,
			async run() {
				const path = await recheckToolPath(ctx, target, 'read');
				const selection = authorizedLineRange(ctx, path);
				if (image) {
					if (selection || args.offset !== undefined || args.limit !== undefined) throw new Error('读取图片需要整份文件的授权，请勿指定行号。');
					return { content: `已读取图片：${path.displayPath}`, images: [await readImageFile(path, ctx.signal)] };
				}
				const requestedStart = Math.max(offset, 1);
				const start = Math.max(requestedStart, selection?.[0] ?? 1);
				const end = Math.min(selection?.[1] ?? Infinity, limit === undefined ? Infinity : requestedStart + limit - 1);
				if (path.cacheOutput) {
					if (!path.stat?.size) return `${path.displayPath}（空文件）`;
					return (await formatLines(path.displayPath, cacheLineBatches(ctx, path, MAX_READ_RESULT_CHARS), start, end)).content;
				}
				const content = await readToolFile(ctx, path);
				const fingerprint = selection ? undefined : fileFingerprint(content);
				if (fingerprint) ctx.readFiles.set(path.absolutePath, fingerprint);
				const withPage = (text: string, start: number, end: number, lineCount: number) => fingerprint
					? { content: text, fileRead: { path: path.absolutePath, fingerprint, start, end, lineCount } }
					: text;
				if (!content) return withPage(`${path.displayPath}（空文件）`, 0, 0, 0);
				const lines = content.split(TEXT_LINE_BREAK);
				if (lines.length > 1 && lines.at(-1) === '') lines.pop();
				const result = await formatLines(path.displayPath, [lines], start, end);
				return result.lastComplete < start ? result.content
					: withPage(result.content, start - 1, result.lastComplete, lines.length);
			},
		};
	},
}];

async function formatLines(path: string, batches: Iterable<string[]> | AsyncIterable<string[]>, start: number, end: number) {
	const result: string[] = [];
	let remaining = Math.max(0, MAX_READ_RESULT_CHARS - path.length - 240);
	let clippedLine = false;
	let more = false;
	let consumed = 0;
	page: for await (const batch of batches) {
		for (let i = Math.max(0, start - 1 - consumed); i < batch.length && consumed + i < end; i++) {
			const prefix = `${consumed + i + 1}\t`;
			const line = batch[i]!;
			const chars = prefix.length + line.length + 1;
			if (chars > remaining) {
				if (result.length) { more = true; break page; }
				result.push(prefix + line.slice(0, Math.max(0, remaining - prefix.length)));
				clippedLine = true;
				remaining = 0;
			} else {
				result.push(prefix + line);
				remaining -= chars;
			}
		}
		consumed += batch.length;
		if (consumed >= end) break;
	}
	const last = start + result.length - 1;
	if (!result.length) return { content: `${path}（指定范围内没有可读取的行）`, lastComplete: last };
	const notice = [];
	if (clippedLine) notice.push(`第 ${start} 行过长，内容已截断。`);
	if (more) notice.push(`还有未显示的内容，可用 offset=${last + 1} 继续读取。`);
	return {
		content: [`${path}（第 ${start}–${last} 行）`, ...result, ...notice].join('\n'),
		lastComplete: clippedLine ? last - 1 : last,
	};
}

function positiveInteger(value: unknown, name: string, minimum: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`参数 ${name} 必须是大于或等于 ${minimum} 的整数。`);
	}
	return value;
}
