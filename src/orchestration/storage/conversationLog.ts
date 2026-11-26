import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ownedPrivateDirectory } from '../../tools/support/resultSpill';
import { hasFileErrorCode } from '../../tools/support/pathUtils';
import type { CommunicationLogEntry } from '../../types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 单个日志文件的上限，超过后只保留最近的行，避免长期运行把文件撑大。 */
const MAX_FILE_BYTES = 1_000_000;
const KEPT_LINES = 500;
const fallbackScope = 'global';
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,95}$/u;

export interface ConversationLogStore {
	/** 按对话分文件追加；没有对话归属的记录归入 global。 */
	append(scope: string | undefined, entry: CommunicationLogEntry): void;
	/** 删除最久没有新记录的日志文件；保留天数为 0 时永久保留。 */
	sweep(retentionDays: number, now?: number): void;
	/** 删除一段对话的日志，删除对话时一并调用。 */
	remove(scope: string): void;
	clear(): void;
	size(): number;
}

function scopeName(scope: string | undefined): string | undefined {
	const name = scope?.toLowerCase();
	return name && scopePattern.test(name) ? name : undefined;
}

export function createConversationLogStore(directory: string): ConversationLogStore {
	const parent = dirname(directory);
	const vault = realpathSync(dirname(parent));
	const base = join(vault, basename(parent));
	const logs = join(base, basename(directory));
	const removed = new Set<string>();
	function checkedDirectory(create = false): boolean {
		try {
			if (!ownedPrivateDirectory(base) || realpathSync(base) !== base) throw new Error('诊断日志目录位置已变化。');
			if (create) {
				try { mkdirSync(logs, { mode: 0o700 }); }
				catch (error) { if (!hasFileErrorCode(error, 'EEXIST')) throw error; }
			}
			if (!create && !lstatSync(logs, { throwIfNoEntry: false })) return false;
			if (!ownedPrivateDirectory(logs) || realpathSync(logs) !== logs) throw new Error('诊断日志目录位置已变化。');
			return true;
		} catch (error) {
			if (hasFileErrorCode(error, 'ENOENT') && !create) return false;
			throw error;
		}
	}
	function files(): string[] {
		return checkedDirectory() ? readdirSync(logs).filter((name) => name.endsWith('.jsonl') && scopeName(name.slice(0, -6))) : [];
	}
	function inspect(name: string) {
		if (!checkedDirectory()) return;
		const path = join(logs, name);
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (!stat) return;
		if (!stat.isFile() || stat.nlink !== 1) throw new Error('诊断日志文件位置已变化。');
		return { path, stat };
	}
	function remove(name: string, cutoff = Infinity) {
		const info = inspect(name);
		if (info && info.stat.mtimeMs < cutoff) unlinkSync(info.path);
	}
	return {
		append(scope, entry) {
			const owner = scopeName(scope) ?? fallbackScope;
			if (removed.has(owner)) return;
			const name = owner + '.jsonl';
			try {
				checkedDirectory(true);
				const previous = inspect(name);
				const fd = openSync(join(logs, name), constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
					| (constants.O_NONBLOCK ?? 0) | (previous ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
				try {
					const current = fstatSync(fd);
					const actual = inspect(name)?.stat;
					if (!actual || !current.isFile() || current.nlink !== 1 || current.ino !== actual.ino || current.dev !== actual.dev
						|| (previous && (current.ino !== previous.stat.ino || current.dev !== previous.stat.dev))) return;
					if (current.size > MAX_FILE_BYTES) {
						const lines = readFileSync(fd, 'utf8').trimEnd().split('\n').slice(-KEPT_LINES);
						ftruncateSync(fd, 0);
						writeSync(fd, lines.join('\n') + '\n');
					}
					writeSync(fd, JSON.stringify(entry) + '\n');
				} finally { closeSync(fd); }
			} catch { /* 诊断写入失败不影响模型请求。 */ }
		},
		sweep(retentionDays, now = Date.now()) {
			if (!(retentionDays > 0)) return;
			for (const name of files()) remove(name, now - retentionDays * MS_PER_DAY);
		},
		remove(scope) {
			const name = scopeName(scope);
			if (name) {
				removed.add(name);
				remove(name + '.jsonl');
			}
		},
		clear() {
			for (const name of files()) remove(name);
		},
		size() {
			try { return files().reduce((total, name) => total + (inspect(name)?.stat.size ?? 0), 0); }
			catch { return 0; }
		},
	};
}
