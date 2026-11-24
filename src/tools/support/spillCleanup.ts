import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

function privateChildren(root: string): string[] {
	return listEntries(root).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory() && ownedPrivateDirectory(path) ? [path] : [];
	});
}

function sweepSpillRoots(base: string, cutoffMs: number): void {
	for (const entry of listEntries(base)) {
		if (!entry.isDirectory() || !ROOT_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
		const root = join(base, entry.name);
		if (ownedPrivateDirectory(root)) sweepRoot(root, cutoffMs);
	}
}

/** 启动时按保留期清理本库输出，同时让旧会话中的系统临时路径自然过期。 */
export function sweepSpillFiles(options: SpillSweepOptions = {}): void {
	const days = options.cleanupPeriodDays ?? CLEANUP_PERIOD_DAYS;
	if (days <= 0) return;
	const cutoffMs = (options.now ?? Date.now()) - days * MS_PER_DAY;
	sweepSpillRoots(options.baseDir ?? tmpdir(), cutoffMs);
	const { cacheDirectory } = options;
	if (!cacheDirectory || !ownedPrivateDirectory(dirname(cacheDirectory)) || !ownedPrivateDirectory(cacheDirectory)) return;
	for (const conversation of privateChildren(cacheDirectory)) {
		for (const owner of privateChildren(conversation)) {
			sweepSpillRoots(owner, cutoffMs);
			pruneEmpty(owner);
		}
		pruneEmpty(conversation);
	}
}
