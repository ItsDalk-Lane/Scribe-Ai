import { readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { RE2JS } from 're2js';
import type { ToolContext, ToolModule } from '../types';
import { fileToolInput, readToolFile, requiredText } from './support/fileAccess';
import { authorizedLineRange, resolveToolPath } from './support/pathUtils';
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

	const expression: string[] = [];
	let groups = 0;
	for (let index = 0; index < normalized.length; index++) {
		const token = normalized.charAt(index);
		const following = normalized[index + 2];
		if (token === '*' && normalized[index + 1] === '*' && (index === 0 || normalized[index - 1] === '/')
			&& (following === '/' || following === undefined)) {
			expression.push(following === '/' ? '(?:[^/]+/)*' : '.*');
			index += following === '/' ? 2 : 1;
		} else if (token === '*') {
			expression.push('[^/]*');
			while (normalized[index + 1] === '*') index++;
		} else if (token === '?') {
			expression.push('[^/]');
		} else if (token === '{') {
			expression.push('(?:');
			groups++;
		} else if (token === '}' && groups > 0) {
			expression.push(')');
			groups--;
		} else if (token === ',' && groups > 0) {
			expression.push('|');
		} else {
			expression.push(token.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
		}
	}
	if (groups !== 0) throw new Error('文件名模式中的花括号未闭合。');
	const regex = RE2JS.compile(expression.join(''), RE2JS.DOTALL);
	return normalized.includes('/')
		? (path) => regex.testExact(path)
		: (path) => regex.testExact(path.slice(path.lastIndexOf('/') + 1));
}

async function* searchFiles(
	ctx: ToolContext,
	path: string | undefined,
	matches: PathMatcher,
	omit: () => void,
): AsyncGenerator<ResolvedToolPath> {
	const seen = new Set<string>();
	const scopes = path === undefined ? [ctx.cwd, ...ctx.task.request.refs.map((ref) => ref.path)] : [path];

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
			if (!ctx.permissions.canRead(childPath)) continue;
			try {
				const child = await resolveToolPath(ctx, childPath, 'read');
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
			const root = await resolveToolPath(ctx, scope, 'read');
			if (root.stat?.isDirectory()) yield* walk(root, root.absolutePath);
			else if (root.stat?.isFile() && !seen.has(root.absolutePath) && matches(basename(root.absolutePath))) {
				seen.add(root.absolutePath);
				yield root;
			}
		} catch (error) {
			ctx.signal.throwIfAborted();
			if (path !== undefined || scope === ctx.cwd) throw error;
			omit();
		}
	}
}

async function globSearch(ctx: ToolContext, path: string | undefined, matches: PathMatcher): Promise<string> {
	const results: ResolvedToolPath[] = [];
	let found = 0;
	let omitted = 0;
	for await (const file of searchFiles(ctx, path, matches, () => omitted++)) {
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
	path?: string;
	fileMatches: PathMatcher;
	regex: RE2JS;
	mode: GrepMode;
	showLineNumbers: boolean;
	limit: number;
	offset: number;
}

async function* grepFile(ctx: ToolContext, file: ResolvedToolPath, text: string, options: GrepOptions): AsyncGenerator<string> {
	const lines = text.split(/\r\n|\n|\r/);
	if (lines[lines.length - 1] === '') lines.pop();
	const [first, last] = authorizedLineRange(ctx, file) ?? [1, lines.length];
	let count = 0;
	for (let index = first - 1; index < Math.min(last, lines.length); index++) {
		if (index % 1024 === 0) {
			await setImmediate();
			ctx.signal.throwIfAborted();
		}
		const line = lines[index];
		if (line === undefined || !options.regex.test(line)) continue;
		if (options.mode === 'files_with_matches') {
			yield file.displayPath;
			return;
		}
		count++;
		if (options.mode === 'content') yield `${file.displayPath}:${options.showLineNumbers ? `${index + 1}:` : ''}${line}`;
	}
	if (options.mode === 'count' && count) yield `${file.displayPath}:${count}`;
}

async function grepSearch(ctx: ToolContext, options: GrepOptions): Promise<string> {
	const results: string[] = [];
	let omitted = 0;
	let offset = options.offset;
	let length = 0;
	let truncated = false;
	search: for await (const file of searchFiles(ctx, options.path, options.fileMatches, () => omitted++)) {
		let text: string;
		try {
			text = await readToolFile(ctx, file);
		} catch {
			ctx.signal.throwIfAborted();
			omitted++;
			continue;
		}
		for await (const row of grepFile(ctx, file, text, options)) {
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
	}
	return [
		...(results.length ? results : ['未找到匹配结果。']),
		...(truncated ? [`还有匹配结果，可用 offset=${options.offset + results.length} 继续查看。`] : []),
		...(omitted ? [`跳过 ${omitted} 个无法读取的位置、过大的文件或非文本文件。`] : []),
	].join('\n');
}

const schema = {
	pattern: { type: 'string' },
	path: { type: 'string', description: '笔记库相对路径，或用户明确授权的绝对路径。省略时搜索笔记库和已授权的位置。' },
};

export const searchTools: ToolModule = () => [
	{
		name: 'Glob',
		description: '按文件名模式找文件。支持 *、**、? 和 {a,b}，结果按最近修改时间排序。',
		isReadOnly: true,
		maxResultSizeChars: RESULT_CHARACTERS,
		inputSchema: { type: 'object', properties: schema, required: ['pattern'], additionalProperties: false },
		prepare(input, ctx) {
			const args = fileToolInput(input, ['pattern', 'path']);
			const matches = globMatcher(requiredText(args, 'pattern'));
			const path = optionalText(args, 'path');
			return { run: () => globSearch(ctx, path, matches) };
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
				path: optionalText(args, 'path'),
				fileMatches: glob ? globMatcher(glob) : () => true,
				regex: RE2JS.compile(pattern, booleanOption(args, '-i', false) ? RE2JS.CASE_INSENSITIVE : 0),
				mode,
				showLineNumbers: booleanOption(args, '-n', true),
				limit: integerOption(args, 'head_limit', GREP_DEFAULT_LIMIT),
				offset: integerOption(args, 'offset', 0),
			};
			return { run: () => grepSearch(ctx, options) };
		},
	},
];
