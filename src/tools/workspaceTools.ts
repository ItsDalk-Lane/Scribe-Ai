import type { App } from 'obsidian';
import type { ToolContext, ToolModule } from '../types';
import { fileToolInput, requiredText } from './support/fileAccess';
import { authorizedLineRange, isWithinPath, normalizeVaultRelativePath, resolveToolPath } from './support/pathUtils';

export const obsidianSearchToolName = 'ObsidianSearch';

interface NativeSearchFlags {
	query: string;
	format: 'json';
	path?: string;
}

type NativeSearchHandler = (flags: NativeSearchFlags) => Promise<string>;

function nativeSearch(app?: App): NativeSearchHandler | undefined {
	// Obsidian's core Search plugin registers this handler in the desktop app, independent of the external CLI.
	if (!app || !('cli' in app)) return;
	const cli = app.cli as { handlers?: ReadonlyMap<string, { handler?: NativeSearchHandler }> } | undefined;
	const handler = cli?.handlers?.get?.('search')?.handler;
	return typeof handler === 'function' ? handler : undefined;
}

const pageSize = 50;
// Skip quoted strings and regex literals so their contents do not count as structural operators.
const queryToken = /\\.|"(?:\\.|[^"\\])*"|(?<![^\s:[(])\/(?:\\.|[^/\\\r\n])+\/|(?<![^\s(-])(?<structure>\[|(?:tag|section|block|task(?:-todo|-done)?):)/gu;

function nativePaths(output: string): string[] {
	if (output === 'No matches found.') return [];
	let paths: unknown;
	try { paths = JSON.parse(output); } catch { throw new Error('Obsidian 原生搜索返回了无法识别的结果。'); }
	if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) {
		throw new Error('Obsidian 原生搜索返回了无法识别的结果。');
	}
	return paths;
}

async function visibleMatches(paths: string[], ctx: ToolContext, folder?: string, absoluteFolder?: string) {
	const matches = new Set<string>();
	for (const path of paths) {
		ctx.signal.throwIfAborted();
		if (!/\.md$/iu.test(path) || path !== normalizeVaultRelativePath(path)
			|| (folder && !path.startsWith(folder + '/'))) continue;
		try {
			const target = await resolveToolPath(ctx, path, 'read');
			if (target.vaultPath && target.stat?.isFile() && !authorizedLineRange(ctx, target)
				&& (!absoluteFolder || isWithinPath(absoluteFolder, target.absolutePath))) matches.add(path);
		} catch {
			ctx.signal.throwIfAborted();
		}
	}
	return [...matches].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export const workspaceTools = (app?: App): ReturnType<ToolModule> => [{
	name: obsidianSearchToolName,
	description: '用 Obsidian 原生查询搜索当前库内 Markdown 笔记的实际标签、属性、章节、块或任务状态。'
		+ '将用户自然语言转换为查询。支持组合、OR、分组、排除及原生属性比较。'
		+ '例如 tag:#AI、[/^scribe$/]（存在这个属性）、[/./:/^acsd$/]（任意属性的值匹配 acsd）。'
		+ '文件名、路径和正文可作为组合条件。仅枚举文件用 Glob，仅查原始文本和匹配行用 Grep。',
	isReadOnly: true,
	isAvailable: () => Boolean(nativeSearch(app)),
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: '一条完整的 Obsidian 原生查询，包含至少一个标签、属性、章节、块或任务条件。' },
			path: { type: 'string', description: '可选的当前库内文件夹路径。省略则搜索整个当前库。' },
			offset: { type: 'integer', minimum: 0, description: '从第几条匹配后继续读取。第一页省略，后续使用返回的 nextOffset。' },
		},
		required: ['query'],
		additionalProperties: false,
	},
	prepare(input, ctx) {
		const args = fileToolInput(input, ['query', 'path', 'offset']);
		const query = requiredText(args, 'query').trim();
		if (query.length > 4096 || query.includes('\0') || /[\r\n]/u.test(query)) throw new Error('请提供不超过 4096 字符的单行 Obsidian 查询。');
		if (![...query.matchAll(queryToken)].some(({ groups }) => groups?.structure)) {
			throw new Error('请至少指定一个标签、属性、章节、块或任务条件。只按文件名或路径查文件请用 Glob，只查原始文本请用 Grep。');
		}
		const rawPath = args.path === undefined ? undefined : requiredText(args, 'path');
		const folder = rawPath === undefined ? undefined : normalizeVaultRelativePath(rawPath);
		if (rawPath !== undefined && !folder) throw new Error('请使用当前笔记库内的文件夹路径。');
		const offset = args.offset === undefined ? 0 : args.offset;
		if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('搜索结果偏移量必须是非负整数。');
		return {
			async run() {
				const search = nativeSearch(ctx.app);
				if (!search) throw new Error('当前 Obsidian 的原生搜索入口不可用。');
				const target = folder ? await resolveToolPath(ctx, folder, 'read') : undefined;
				if (target && (!target.vaultPath || !target.stat?.isDirectory())) throw new Error('请选择当前笔记库内的文件夹。');
				const result = await search({ query, format: 'json', ...(folder && { path: folder }) });
				ctx.signal.throwIfAborted();
				const matches = await visibleMatches(nativePaths(result), ctx, folder, target?.absolutePath);
				const paths = matches.slice(offset, offset + pageSize);
				const next = offset + paths.length;
				return JSON.stringify({ query, ...(folder && { folder }), total: matches.length, paths,
					...(next < matches.length && { nextOffset: next }) });
			},
		};
	},
}];
