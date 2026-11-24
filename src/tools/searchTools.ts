import { readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { RE2JS } from 're2js';
import type { PreparedTool, ToolContext, ToolModule } from '../types';
import { cacheLineBatches } from './support/cacheLines';
import { fileToolInput, MAX_TEXT_BYTES, readToolFile, requiredText, TEXT_LINE_BREAK } from './support/fileAccess';
import { compilePathGlob } from './support/pathGlob';
import { authorizedLineRange, isWithinPath, recheckToolPath, resolveToolPath } from './support/pathUtils';
import type { ResolvedToolPath } from './support/pathUtils';

const MATCHING_FILES_LIMIT = 100;
const GREP_DEFAULT_LIMIT = 250;
const RESULT_CHARACTERS = 30_000;
const VCS_DIRECTORIES = new Set(['.git', '.hg', '.svn']);

type PathMatcher = (relativePath: string) => boolean;
type GrepMode = 'files_with_matches' | 'content' | 'count';

function optionalText(input: Record<string, unknown>, key: string): string | undefined {
	return input[key] === undefined ? undefined : requiredText(input, key);
}

function integerOption(input: Record<string, unknown>, key: string, fallback: number): number {
	const value = input[key] === undefined ? fallback : input[key];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`参数 ${key} 必须是非负整数。`);
	}
	return value;
}

function booleanOption(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const value = input[key] === undefined ? fallback : input[key];
	if (typeof value !== 'boolean') throw new Error(`参数 ${key} 必须是布尔值。`);
	return value;
}

function globMatcher(pattern: string): PathMatcher {
	const normalized = pattern.replace(/\\/g, '/');
	if (normalized.length > 512 || normalized.startsWith('/') || normalized.includes('\0')
		|| normalized.split('/').includes('..')) {
		throw new Error('请在 pattern 中使用相对文件名模式，并在 path 中指定搜索位置。');
	}

	const matches = compilePathGlob(normalized);
	return normalized.includes('/') ? matches : (path) => matches(path.slice(path.lastIndexOf('/') + 1));
}

async function* searchFiles(
	ctx: ToolContext,
	target: ResolvedToolPath | undefined,
	matches: PathMatcher,
	omit: () => void,
): AsyncGenerator<ResolvedToolPath> {
	const seen = new Set<string>();
	const scopes = target ? [target.requestedPath] : [ctx.cwd, ...ctx.task.request.refs.map((ref) => ref.path)];
	const approvedRoot = target?.requiresApproval ? target.absolutePath : undefined;

	async function* walk(directory: ResolvedToolPath, base: string): AsyncGenerator<ResolvedToolPath> {
		if (seen.has(directory.absolutePath)) return;
		seen.add(directory.absolutePath);
		const entries = await readdir(directory.absolutePath, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			ctx.signal.throwIfAborted();
			const childPath = join(directory.absolutePath, entry.name);
			const isDirectory = entry.isDirectory();
			if (isDirectory ? VCS_DIRECTORIES.has(entry.name) : !entry.isFile() || !matches(relative(base, childPath).split(sep).join('/'))) continue;
			if (!ctx.permissions.canRead(childPath) && !(approvedRoot && ctx.permissions.canRequestPath?.(childPath, 'read'))) continue;
			try {
				const child = await resolveToolPath(ctx, childPath, 'read', { approvedRoot });
				if (approvedRoot && !isWithinPath(approvedRoot, child.absolutePath)) continue;
				if (isDirectory && child.stat?.isDirectory()) yield* walk(child, base);
				else if (child.stat?.isFile() && !seen.has(child.absolutePath)) {
					seen.add(child.absolutePath);
					yield child;
				}
			} catch {
				ctx.signal.throwIfAborted();
				omit();
			}
		}
	}

	for (const scope of scopes) {
		try {
			const root = target ? await recheckToolPath(ctx, target, 'read') : await resolveToolPath(ctx, scope, 'read');
			if (root.stat?.isDirectory()) yield* walk(root, root.absolutePath);
			else if (root.stat?.isFile() && !seen.has(root.absolutePath) && matches(basename(root.absolutePath))) {
				seen.add(root.absolutePath);
				yield root;
			}
		} catch (error) {
			ctx.signal.throwIfAborted();
			if (target || scope === ctx.cwd) throw error;
			omit();
		}
	}
}

async function globSearch(ctx: ToolContext, target: ResolvedToolPath | undefined, matches: PathMatcher): Promise<string> {
	const results: ResolvedToolPath[] = [];
	let found = 0;
	let omitted = 0;
	for await (const file of searchFiles(ctx, target, matches, () => omitted++)) {
		found++;
		results.push(file);
		results.sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0) || a.displayPath.localeCompare(b.displayPath));
		if (results.length > MATCHING_FILES_LIMIT) results.pop();
	}
	return [
		found ? `找到 ${found} 个文件${found > results.length ? `，仅显示最近修改的 ${results.length} 个` : ''}。` : '未找到匹配文件。',
		...results.map((file) => file.displayPath),
		...(omitted ? [`跳过 ${omitted} 个无法访问的位置。`] : []),
	].join('\n');
}

interface GrepOptions {
	fileMatches: PathMatcher;
	regex: RE2JS;
	mode: GrepMode;
	showLineNumbers: boolean;
	limit: number;
	offset: number;
}

async function* grepFile(ctx: ToolContext, file: ResolvedToolPath, options: GrepOptions, skipLine: () => void): AsyncGenerator<string> {
	const [first, last] = authorizedLineRange(ctx, file) ?? [1, Infinity];
	let batches: string[][] | AsyncIterable<string[]>;
	if (file.cacheOutput) batches = cacheLineBatches(ctx, file, MAX_TEXT_BYTES + 1);
	else {
		const lines = (await readToolFile(ctx, file)).split(TEXT_LINE_BREAK);
		if (lines.at(-1) === '') lines.pop();
		batches = [lines];
	}
	let count = 0;
	let consumed = 0;
	for await (const batch of batches) {
		for (let i = Math.max(0, first - 1 - consumed); i < batch.length && consumed + i < last; i++) {
			const index = consumed + i;
			if (index % 1024 === 0) {
				await setImmediate();
				ctx.signal.throwIfAborted();
			}
			const line = batch[i]!;
			if (line.length > MAX_TEXT_BYTES) { skipLine(); continue; }
			if (!options.regex.test(line)) continue;
			if (options.mode === 'files_with_matches') {
				yield file.displayPath;
				return;
			}
			count++;
			if (options.mode === 'content') yield `${file.displayPath}:${options.showLineNumbers ? `${index + 1}:` : ''}${line}`;
		}
		consumed += batch.length;
		if (consumed >= last) break;
	}
	if (options.mode === 'count' && count) yield `${file.displayPath}:${count}`;
}

async function grepSearch(ctx: ToolContext, target: ResolvedToolPath | undefined, options: GrepOptions): Promise<string> {
	const results: string[] = [];
	let omitted = 0;
	let longLines = 0;
	let offset = options.offset;
	let length = 0;
	let truncated = false;
	search: for await (const file of searchFiles(ctx, target, options.fileMatches, () => omitted++)) {
		try {
			for await (const row of grepFile(ctx, file, options, () => longLines++)) {
				if (offset > 0) {
					offset--;
					continue;
				}
				if ((options.limit > 0 && results.length === options.limit) || length >= RESULT_CHARACTERS - 200) {
					truncated = true;
					break search;
				}
				const remaining = RESULT_CHARACTERS - 200 - length;
				const output = row.length > remaining ? `${row.slice(0, Math.max(0, remaining - 8))}…（行已截断）` : row;
				results.push(output);
				length += output.length + 1;
			}
		} catch {
			ctx.signal.throwIfAborted();
			omitted++;
		}
	}
	return [
		...(results.length ? results : ['未找到匹配结果。']),
		...(truncated ? [`还有匹配结果，可用 offset=${options.offset + results.length} 继续查看。`] : []),
		...(longLines ? [`跳过 ${longLines} 行过长的输出，这些行未参与匹配。`] : []),
		...(omitted ? [`跳过 ${omitted} 个无法读取的位置、过大的文件或非文本文件。`] : []),
	].join('\n');
}

const schema = {
	pattern: { type: 'string' },
	path: { type: 'string', description: '笔记库相对路径或绝对路径。库外路径可能需要批准。省略时搜索笔记库和已授权的位置。' },
};

async function prepareSearch(
	ctx: ToolContext, path: string | undefined, title: string, pattern: string,
	run: (target: ResolvedToolPath | undefined) => Promise<string>,
): Promise<PreparedTool> {
	const target = path === undefined ? undefined : await resolveToolPath(ctx, path, 'read', { requestApproval: true, readCache: true });
	return {
		approval: target?.requiresApproval ? {
			kind: 'access', title, target: target.absolutePath, reason: `${title}。匹配模式为 ${JSON.stringify(pattern)}。`,
		} : undefined,
		run: () => run(target),
	};
}

export const searchTools: ToolModule = () => [
	{
		name: 'Glob',
		description: '按文件名模式找文件。支持 *、**、? 和 {a,b}，结果按最近修改时间排序。',
		isReadOnly: true,
		maxResultSizeChars: RESULT_CHARACTERS,
		inputSchema: { type: 'object', properties: schema, required: ['pattern'], additionalProperties: false },
		prepare(input, ctx) {
			const args = fileToolInput(input, ['pattern', 'path']);
			const pattern = requiredText(args, 'pattern');
			const matches = globMatcher(pattern);
			const path = optionalText(args, 'path');
			return prepareSearch(ctx, path, '搜索库外文件名', pattern, (target) => globSearch(ctx, target, matches));
		},
	},
	{
		name: 'Grep',
		description: '用 RE2 正则搜索授权位置里的 UTF-8 文本，可返回文件名、匹配行或每个文件的匹配行数。',
		isReadOnly: true,
		maxResultSizeChars: RESULT_CHARACTERS,
		inputSchema: {
			type: 'object',
			properties: {
				...schema,
				glob: { type: 'string', description: '可选的文件名模式，例如 *.{md,txt}。' },
				output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
				'-i': { type: 'boolean', description: '忽略大小写。' },
				'-n': { type: 'boolean', description: '在匹配行前显示行号，默认显示。' },
				head_limit: { type: 'integer', minimum: 0, description: '默认显示 250 项。0 表示仅按结果长度限制。' },
				offset: { type: 'integer', minimum: 0, description: '跳过开头的匹配项，用于分页。' },
			},
			required: ['pattern'],
			additionalProperties: false,
		},
		prepare(input, ctx) {
			const args = fileToolInput(input, ['pattern', 'path', 'glob', 'output_mode', '-i', '-n', 'head_limit', 'offset']);
			const pattern = requiredText(args, 'pattern');
			if (pattern.length > 1024) throw new Error('Grep 正则表达式过长，请使用更短的模式。');
			const mode = optionalText(args, 'output_mode') ?? 'files_with_matches';
			if (mode !== 'files_with_matches' && mode !== 'content' && mode !== 'count') throw new Error('Grep 输出模式无效。');
			const glob = optionalText(args, 'glob');
			const options: GrepOptions = {
				fileMatches: glob ? globMatcher(glob) : () => true,
				regex: RE2JS.compile(pattern, booleanOption(args, '-i', false) ? RE2JS.CASE_INSENSITIVE : 0),
				mode,
				showLineNumbers: booleanOption(args, '-n', true),
				limit: integerOption(args, 'head_limit', GREP_DEFAULT_LIMIT),
				offset: integerOption(args, 'offset', 0),
			};
			return prepareSearch(ctx, optionalText(args, 'path'), '搜索库外文件内容', pattern, (target) => grepSearch(ctx, target, options));
		},
	},
];
