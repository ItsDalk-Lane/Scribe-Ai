import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { IMAGE_CACHE_PREFIX, VIDEO_CACHE_PREFIX, isCachedImagePath, scribeCacheScope } from '../../orchestration/storage/paths';
import { ownedPrivateDirectory, SHELL_SPILL_PREFIX, TOOL_SPILL_PREFIX } from './resultSpill';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ROOT_PREFIXES = [SHELL_SPILL_PREFIX, TOOL_SPILL_PREFIX];
/** DSH's local spill default: files older than this are reclaimed on the next start. */
export const CLEANUP_PERIOD_DAYS = 30;

export interface SpillSweepOptions {
	cacheDirectory?: string;
	/** 旧输出所在的系统临时目录，测试可覆盖。 */
	baseDir?: string;
	/** Age cutoff in days; `0` disables cleanup. */
	cleanupPeriodDays?: number;
	/** Clock override for tests. */
	now?: number;
}

function removableFile(path: string): number | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
		return stat.mtimeMs;
	} catch {
		return undefined;
	}
}

function listEntries(root: string) {
	try { return readdirSync(root, { withFileTypes: true }); }
	catch { return []; }
}

function pruneEmpty(path: string): void {
	// 保留非空目录，其他进程也可能正在写入。
	try { rmdirSync(path); } catch { /* 下次启动时再清理。 */ }
}

function sweepRoot(root: string, cutoffMs: number): void {
	for (const entry of listEntries(root)) {
		if (!entry.isFile()) continue;
		const path = join(root, entry.name);
		const mtime = removableFile(path);
		if (mtime === undefined || mtime >= cutoffMs) continue;
		try { unlinkSync(path); } catch { /* Best effort; leave the entry for a later sweep. */ }
	}
	pruneEmpty(root);
}

function sweepSpillRoots(base: string, cutoffMs: number): void {
	for (const entry of listEntries(base)) {
		if (!entry.isDirectory() || !ROOT_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
		const root = join(base, entry.name);
		if (ownedPrivateDirectory(root)) sweepRoot(root, cutoffMs);
	}
}

type RetainedImages = () => Promise<ReadonlySet<string>>;

function checkedCacheDirectory(cache: string, path: string): boolean {
	if (!ownedPrivateDirectory(dirname(cache)) || !ownedPrivateDirectory(cache)) return false;
	let current = cache;
	for (const part of relative(cache, path).split(sep)) {
		current = join(current, part);
		if (!ownedPrivateDirectory(current)) return false;
	}
	return true;
}

function cacheChildren(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name)).filter(ownedPrivateDirectory);
}

async function cleanCache(cache: string, cutoff: number, retained?: RetainedImages,
	deletion?: { id: string; shared: ReadonlySet<string> }): Promise<void> {
	if (!lstatSync(cache, { throwIfNoEntry: false })) return;
	if (!ownedPrivateDirectory(dirname(cache)) || !ownedPrivateDirectory(cache)) throw new Error('缓存目录位置已变化。');
	const vault = dirname(dirname(cache));
	const images = new Map<string, string>();
	const directories: string[] = [];
	const owners = deletion && new Set([deletion.id, ...Array.from(deletion.shared, (path) => path.split('/')[2]!)]);
	const chats = owners ? [...owners].filter((id) => scribeCacheScope(cache, id)).map((id) => join(cache, id)).filter(ownedPrivateDirectory)
		: cacheChildren(cache);
	for (const chat of chats) {
		const id = basename(chat);
		if (!scribeCacheScope(cache, id)) continue;
		for (const owner of cacheChildren(chat)) {
			for (const dir of cacheChildren(owner)) {
				const prefix = basename(dir);
				if (![...ROOT_PREFIXES, IMAGE_CACHE_PREFIX, VIDEO_CACHE_PREFIX].some((value) => prefix.startsWith(value))) continue;
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					if (!entry.isFile()) continue;
					const file = join(dir, entry.name);
					const path = relative(vault, file).split(sep).join('/');
					if (deletion && id !== deletion.id && !deletion.shared.has(path)) continue;
					const mtime = removableFile(file);
					if (mtime === undefined || mtime >= cutoff) continue;
					if (isCachedImagePath(path)) images.set(path, file);
					else unlinkSync(file);
				}
				directories.push(dir);
			}
			directories.push(owner);
		}
		directories.push(chat);
	}
	if (images.size && retained) {
		const keep = await retained();
		for (const [path, file] of images) {
			if (keep.has(path)) continue;
			if (!checkedCacheDirectory(cache, dirname(file))) throw new Error('缓存目录位置已变化。');
			if (removableFile(file) !== undefined) unlinkSync(file);
		}
	}
	for (const path of directories) {
		// 等待聊天引用期间目录可能已经移动，仅清理仍在原位置的空目录。
		if (checkedCacheDirectory(cache, path)) pruneEmpty(path);
	}
}

export function clearSpillFiles(cache: string, retained: RetainedImages): Promise<void> {
	return cleanCache(cache, Infinity, retained);
}

export function removeConversationSpills(cache: string, id: string, shared: ReadonlySet<string>, retained: RetainedImages): Promise<void> {
	return cleanCache(cache, Infinity, retained, { id, shared });
}

export async function sweepSpillFiles(options: SpillSweepOptions = {}, retained?: RetainedImages): Promise<void> {
	const days = options.cleanupPeriodDays ?? CLEANUP_PERIOD_DAYS;
	if (days <= 0) return;
	const cutoff = (options.now ?? Date.now()) - days * MS_PER_DAY;
	sweepSpillRoots(options.baseDir ?? tmpdir(), cutoff);
	if (options.cacheDirectory) await cleanCache(options.cacheDirectory, cutoff, retained);
}
