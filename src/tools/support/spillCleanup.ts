import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Prefixes this plugin uses for private spill roots under the OS temp directory. */
const ROOT_PREFIXES = ['scribe-ai-shell-', 'scribe-ai-tools-'];
/** DSH's local spill default: files older than this are reclaimed on the next start. */
export const CLEANUP_PERIOD_DAYS = 30;

export interface SpillSweepOptions {
	/** Directory scanned for spill roots; defaults to the OS temp directory. */
	baseDir?: string;
	/** Age cutoff in days; `0` disables cleanup. */
	cleanupPeriodDays?: number;
	/** Clock override for tests. */
	now?: number;
}

function ownedPrivateDirectory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		// Never delete a root another local user could replace or modify.
		if ((stat.mode & 0o022) !== 0) return false;
		const uid = process.getuid?.();
		return uid === undefined || stat.uid === uid;
	} catch {
		return false;
	}
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

function sweepRoot(root: string, cutoffMs: number): void {
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const path = join(root, entry.name);
		const mtime = removableFile(path);
		if (mtime === undefined || mtime >= cutoffMs) continue;
		try { unlinkSync(path); } catch { /* Best effort; leave the entry for a later sweep. */ }
	}
	try {
		if (readdirSync(root).length === 0) rmdirSync(root);
	} catch {
		/* A concurrent write or a permission race leaves the empty directory. */
	}
}

/**
 * DSH-style one-shot startup sweep: remove regular files older than the
 * configured retention from private spill roots, then prune empty roots.
 * Symlinks, foreign-owned roots and group/other-writable roots are untouched.
 */
export function sweepSpillFiles(options: SpillSweepOptions = {}): void {
	const days = options.cleanupPeriodDays ?? CLEANUP_PERIOD_DAYS;
	if (days <= 0) return;
	const cutoffMs = (options.now ?? Date.now()) - days * MS_PER_DAY;
	const base = options.baseDir ?? tmpdir();
	let roots;
	try {
		roots = readdirSync(base, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of roots) {
		if (!entry.isDirectory()) continue;
		if (!ROOT_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
		const root = join(base, entry.name);
		if (!ownedPrivateDirectory(root)) continue;
		sweepRoot(root, cutoffMs);
	}
}
