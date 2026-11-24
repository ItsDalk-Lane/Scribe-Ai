import type { Stats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import type { ToolContext } from '../../types';
import { isScribeCacheOutput, scribeDataPaths } from '../../orchestration/storage/paths';

export interface ResolvedToolPath {
	requestedPath: string;
	absolutePath: string;
	vaultPath?: string;
	displayPath: string;
	stat?: Stats;
	requiresApproval?: boolean;
	cacheOutput?: true;
}

/** 目录范围按路径段判断，避免同名前缀混入。 */
export function isWithinPath(directory: string, target: string): boolean {
	const suffix = relative(directory, target);
	return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

export function normalizeVaultRelativePath(path: string): string | undefined {
	if (!path.trim() || path.includes('\0') || isAbsolute(path) || win32.isAbsolute(path)) return;
	const normalized = posix.normalize(path).replace(/\/$/u, '');
	if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return;
	return normalized;
}

export function toolAbsolutePath(cwd: string, input: string): string {
	if (!input.trim() || input.includes('\0')) throw new Error('文件路径无效。');
	if (process.platform === 'win32') {
		const windowsPath = input.replace(/\//g, '\\');
		if (/^\\\\[?.]\\/.test(windowsPath) || /^[A-Za-z]:(?!\\)/.test(windowsPath)
			|| windowsPath.replace(/^[A-Za-z]:/, '').includes(':')
			|| windowsPath.split('\\').some((part) => part !== '.' && part !== '..'
				&& (/[. ]$/.test(part) || /^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(part)))) {
			throw new Error('文件路径无效。');
		}
	}
	return resolve(cwd, input);
}

/** 同时检查传入路径和实际地址，避免链接把操作带出授权范围。 */
export async function resolveToolPath(
	ctx: Pick<ToolContext, 'cwd' | 'signal' | 'permissions' | 'task' | 'subagentId'>,
	input: string,
	operation: 'read' | 'write',
	options?: { allowMissing?: boolean; requestApproval?: boolean; approvedRoot?: string; readCache?: boolean },
): Promise<ResolvedToolPath> {
	ctx.signal.throwIfAborted();
	const requestedPath = toolAbsolutePath(ctx.cwd, input);
	const canonicalVault = await realpath(ctx.cwd);
	const cacheVault = operation === 'read' && options?.readCache && !ctx.task.request.intent
		? [ctx.cwd, canonicalVault].find((root) => isScribeCacheOutput(scribeDataPaths(root).cache,
			requestedPath, ctx.task.request.conversationId, ctx.subagentId))
		: undefined;
	// 缓存只按当前对话显示的完整文件路径读取，不授予整个目录的访问权限。
	const cachePath = cacheVault && resolve(canonicalVault, relative(cacheVault, requestedPath));
	let requiresApproval = false;
	const checkPermission = (target: string) => {
		const allowed = operation === 'read' ? ctx.permissions.canRead(target) : ctx.permissions.canWrite(target);
		if (allowed) return;
		if ((options?.requestApproval || (options?.approvedRoot && isWithinPath(options.approvedRoot, target)))
			&& ctx.permissions.canRequestPath?.(target, operation)) {
			requiresApproval = true;
			return;
		}
		throw new Error('此路径未包含在本次任务授权的资料中。');
	};
	if (!cachePath) checkPermission(requestedPath);
	let absolutePath: string;
	let fileStat: Stats | undefined;
	try {
		absolutePath = await realpath(requestedPath);
		if (cachePath) {
			if (relative(cachePath, absolutePath) !== '') throw new Error('缓存文件的位置已变化。');
		} else checkPermission(absolutePath);
		fileStat = await stat(absolutePath);
		if (cachePath && (!fileStat.isFile() || fileStat.nlink !== 1)) throw new Error('缓存文件的位置无效。');
	} catch (error) {
		if (!hasFileErrorCode(error, 'ENOENT')) throw error;
		if (!options?.allowMissing) throw new Error('指定的文件或文件夹不存在。');
		const existing = await lstat(requestedPath).catch((failure: unknown) => {
			if (!hasFileErrorCode(failure, 'ENOENT')) throw failure;
			return undefined;
		});
		if (existing) throw new Error('目标已存在或指向不存在的位置。');
		absolutePath = resolve(await realpath(dirname(requestedPath)), basename(requestedPath));
		checkPermission(absolutePath);
	}
	if (operation === 'write' && fileStat?.isFile() && fileStat.nlink > 1) {
		throw new Error('此文件有多个硬链接，无法单独修改这个位置。');
	}
	ctx.signal.throwIfAborted();
	const vaultPath = isWithinPath(canonicalVault, absolutePath)
		? relative(canonicalVault, absolutePath).split(sep).join('/')
		: undefined;
	return { requestedPath, absolutePath, vaultPath, displayPath: vaultPath || absolutePath, stat: fileStat, requiresApproval,
		...(cachePath && { cacheOutput: true }) };
}

export async function recheckToolPath(
	ctx: ToolContext, path: ResolvedToolPath, operation: 'read' | 'write', options?: { allowMissing?: boolean },
): Promise<ResolvedToolPath> {
	const current = await resolveToolPath(ctx, path.requestedPath, operation, {
		...options, requestApproval: path.requiresApproval, readCache: path.cacheOutput,
	});
	if (current.absolutePath !== path.absolutePath || current.stat?.ino !== path.stat?.ino || current.stat?.dev !== path.stat?.dev) {
		throw new Error('文件或文件夹的位置或状态已变化，请重新确认。');
	}
	return current;
}

export function hasFileErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

export function authorizedLineRange(ctx: ToolContext, path: ResolvedToolPath): [number, number] | undefined {
	if (ctx.permissions.readLines) return ctx.permissions.readLines(path.absolutePath);
	let lines: [number, number] | undefined;
	for (const ref of ctx.task.request.refs) {
		const allowed = resolve(ctx.cwd, ref.path);
		if (ref.kind === 'folder' && (isWithinPath(allowed, path.requestedPath) || isWithinPath(allowed, path.absolutePath))) {
			return undefined;
		}
		if (ref.kind !== 'folder' && [path.requestedPath, path.absolutePath].some((candidate) => relative(allowed, candidate) === '')) {
			if (!ref.lines) return undefined;
			lines ??= ref.lines;
		}
	}
	return lines;
}
