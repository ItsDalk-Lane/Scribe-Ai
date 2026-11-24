import type { ToolModule } from '../types';
import { fileFingerprint, fileToolInput, readToolFile, requiredText } from './support/fileAccess';
import { authorizedLineRange, recheckToolPath, resolveToolPath } from './support/pathUtils';

const MAX_READ_RESULT_CHARS = 100_000;

export const readTools: ToolModule = () => [{
	name: 'Read',
	description: 'Read a UTF-8 text file with line numbers. Relative paths start in the vault. Absolute paths may require approval. A Jupyter notebook is returned as JSON; cells without an ID can be addressed as cell-0, cell-1, and so on.',
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
		const target = await resolveToolPath(ctx, file, 'read', { requestApproval: true, readCache: true });
		return {
			approval: target.requiresApproval ? {
				kind: 'access', title: '读取库外文件', target: target.absolutePath,
				reason: `读取库外文件，从第 ${Math.max(offset, 1)} 行开始${limit === undefined ? '。' : `，最多读取 ${limit} 行。`}`,
			} : undefined,
			async run() {
				const path = await recheckToolPath(ctx, target, 'read');
				const content = await readToolFile(ctx, path);
				const selection = authorizedLineRange(ctx, path);
				const fingerprint = selection ? undefined : fileFingerprint(content);
				if (fingerprint) ctx.readFiles.set(path.absolutePath, fingerprint);
				const withPage = (text: string, start: number, end: number, lineCount: number) => fingerprint
					? { content: text, fileRead: { path: path.absolutePath, fingerprint, start, end, lineCount } }
					: text;
				if (!content) return withPage(`${path.displayPath}（空文件）`, 0, 0, 0);
				const lines = content.split(/\r?\n/);
				if (lines.length > 1 && lines.at(-1) === '') lines.pop();
				const requestedStart = Math.max(offset, 1);
				const start = Math.max(requestedStart, selection?.[0] ?? 1);
				const end = Math.min(lines.length, selection?.[1] ?? lines.length,
					limit === undefined ? lines.length : requestedStart + limit - 1);
				if (start > end) return `${path.displayPath}（指定范围内没有可读取的行）`;
				const result = formatLines(path.displayPath, lines, start, end);
				return result.lastComplete < start ? result.content
					: withPage(result.content, start - 1, result.lastComplete, lines.length);
			},
		};
	},
}];

function formatLines(path: string, lines: string[], start: number, end: number) {
	const result: string[] = [];
	let remaining = Math.max(0, MAX_READ_RESULT_CHARS - path.length - 240);
	let clippedLine = false;
	for (let number = start; number <= end; number++) {
		const prefix = `${number}\t`;
		const text = lines[number - 1] ?? '';
		const chars = prefix.length + text.length + 1;
		if (chars > remaining) {
			if (result.length === 0) {
					result.push(prefix + text.slice(0, Math.max(0, remaining - prefix.length)));
				clippedLine = true;
			}
			break;
		}
		result.push(prefix + text);
		remaining -= chars;
	}
	const last = start + result.length - 1;
	const notice = [];
	if (clippedLine) notice.push(`第 ${start} 行过长，内容已截断。`);
	if (last < end) notice.push(`还有未显示的内容，可用 offset=${last + 1} 继续读取。`);
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
