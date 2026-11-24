import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdtemp, readdir, realpath, rename, rm, rmdir, unlink, utimes } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { hasFileErrorCode, isWithinPath } from '../../tools/support/pathUtils';
import { ensureStoredDirectory, openStoredFile, readStoredJson, storageStat, writeStoredJson } from './jsonFile';
import { scribeDataPaths } from './paths';

export const STORAGE_VERSION = 1;

interface MigrationReceipt {
	legacyDirectory: string;
	settingsHash: string;
	conversationsHash: string | null;
}

interface ConversationFile {
	name: string;
	hash: string;
	mtime: Date;
}

function hashJson(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function listFiles(directory: string): Promise<ConversationFile[] | undefined> {
	const stat = await storageStat(directory);
	if (!stat) return undefined;
	if (!stat.isDirectory() || await realpath(directory) !== directory) throw new Error('旧聊天记录目录无效。');
	const names = (await readdir(directory)).sort();
	const files: ConversationFile[] = [];
	for (const name of names) {
		const { file, stat } = await openStoredFile(join(directory, name));
		try {
			const hash = createHash('sha256');
			for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
			files.push({ name, hash: hash.digest('hex'), mtime: stat.mtime });
		} finally {
			await file.close();
		}
	}
	return files;
}

function conversationHash(files: ConversationFile[] | undefined): string | null {
	return files ? hashJson(files.map(({ name, hash }) => [name, hash])) : null;
}

async function verifyCopies(directory: string, source: ConversationFile[]): Promise<void> {
	const copies = new Map((await listFiles(directory))?.map(({ name, hash }) => [name, hash]));
	if (source.some(({ name, hash }) => copies.get(name) !== hash)) throw new Error('旧聊天与新位置的副本不一致。');
}

async function copyConversations(source: string, destination: string, staging: string, files: ConversationFile[]): Promise<void> {
	if (await storageStat(destination)) {
		await verifyCopies(destination, files);
		return;
	}
	const temporary = await mkdtemp(join(staging, 'conversations-'));
	try {
		for (const { name, mtime } of files) {
			const target = join(temporary, name);
			await copyFile(join(source, name), target, constants.COPYFILE_EXCL);
			await chmod(target, 0o600);
			await utimes(target, mtime, mtime);
		}
		await verifyCopies(temporary, files);
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

function readReceipt(value: unknown, directory: string): MigrationReceipt | undefined {
	if (value === undefined) return undefined;
	if (!record(value) || value.legacyDirectory !== directory || typeof value.settingsHash !== 'string'
		|| !(typeof value.conversationsHash === 'string' || value.conversationsHash === null)) {
		throw new Error('Scribe Ai 的迁移记录与当前插件目录不匹配。');
	}
	return { legacyDirectory: directory, settingsHash: value.settingsHash, conversationsHash: value.conversationsHash };
}

export async function openVaultStorage(root: string, legacyDirectory: string, legacyData: unknown) {
	const paths = scribeDataPaths(root);
	if (!isWithinPath(root, legacyDirectory) || isWithinPath(paths.root, legacyDirectory)) {
		throw new Error('旧插件目录不在当前笔记库的有效位置。');
	}
	const legacy: unknown = legacyData ?? {};
	if (!record(legacy)) throw new Error('旧 Scribe Ai 配置格式无效。');
	const version = legacy.storageVersion;
	if (version !== undefined && version !== STORAGE_VERSION) throw new Error('此版本无法读取 Scribe Ai 的存储格式。');
	const versionOnly = version === STORAGE_VERSION && Object.keys(legacy).length === 1;
	await ensureStoredDirectory(paths.root);
	const journal = join(paths.migration, 'pending.json');
	const retired = join(paths.migration, 'old-conversations');
	const staging = await storageStat(paths.migration);
	if (staging && !staging.isDirectory()) throw new Error('Scribe Ai 的迁移目录无效。');
	const pending = readReceipt(staging ? await readStoredJson(journal) : undefined, relative(root, legacyDirectory));
	const stored = await readStoredJson(paths.settings);
	if (stored !== undefined && !record(stored)) throw new Error('Scribe Ai 设置文件格式无效。');
	if (pending && (stored === undefined || !(await storageStat(paths.conversations))?.isDirectory())) {
		throw new Error('新位置的数据不完整，旧数据已保留。');
	}
	const legacyFiles = pending ? undefined : await listFiles(legacyDirectory);
	const importing = !pending && (Boolean(legacyFiles) || (!versionOnly && Object.keys(legacy).length > 0));
	if (legacyFiles) {
		await ensureStoredDirectory(paths.migration);
		await copyConversations(legacyDirectory, paths.conversations, paths.migration, legacyFiles);
	}
	await ensureStoredDirectory(paths.conversations);

	return {
		paths,
		stored,
		legacy,
		importing,
		needsLegacyMigration: !versionOnly || Boolean(pending) || importing,
		async complete(writeVersion: () => Promise<void>, clearLegacy: () => Promise<void>): Promise<void> {
			if (importing) {
				// 首次打开从新位置读取，保留旧数据直到下一次成功加载。
				await ensureStoredDirectory(paths.migration);
				await writeStoredJson(journal, {
					legacyDirectory: relative(root, legacyDirectory),
					settingsHash: hashJson(legacy),
					conversationsHash: conversationHash(legacyFiles),
				} satisfies MigrationReceipt);
				return;
			}
			if (pending) {
				const oldFiles = await listFiles(legacyDirectory);
				const retiredFiles = await listFiles(retired);
				if ((!versionOnly && hashJson(legacy) !== pending.settingsHash)
					|| (oldFiles && retiredFiles)
					|| ((oldFiles || retiredFiles || !versionOnly)
						&& conversationHash(oldFiles ?? retiredFiles) !== pending.conversationsHash)) {
					throw new Error('旧数据在迁移期间发生变化，已保留供检查。');
				}
				if (!versionOnly) await writeVersion();
				if (oldFiles) await rename(legacyDirectory, retired);
				await clearLegacy();
				await rm(retired, { recursive: true, force: true });
				await unlink(journal);
				await rmdir(paths.migration).catch((error: unknown) => {
					if (!hasFileErrorCode(error, 'ENOTEMPTY')) throw error;
				});
				return;
			}
			if (!versionOnly) {
				await writeVersion();
				await clearLegacy();
			}
		},
	};
}
