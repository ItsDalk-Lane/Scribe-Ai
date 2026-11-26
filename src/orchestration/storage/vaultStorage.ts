import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdtemp, readdir, realpath, rename, rm, rmdir, unlink, utimes } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { hasFileErrorCode, isWithinPath } from '../../tools/support/pathUtils';
import { ensureStoredDirectory, openStoredFile, readStoredJson, storageStat, writeStoredJson } from './jsonFile';
import { scribeDataPaths } from './paths';
import { verifyConversationBody } from './conversationStore';

export const STORAGE_VERSION = 1;

interface MigrationReceipt {
	legacyDirectory: string;
	settingsHash: string;
	conversationsHash: string | null;
}

interface ConversationFile {
	name: string;
	size: number;
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
			files.push({ name, size: stat.size, hash: hash.digest('hex'), mtime: stat.mtime });
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

async function matchesBody(path: string, size: number, digest: string): Promise<boolean> {
	const { file, stat } = await openStoredFile(path);
	try {
		if (stat.size < size) return false;
		const hash = createHash('sha256');
		if (size) for await (const chunk of file.createReadStream({ end: size - 1, autoClose: false })) hash.update(chunk as Buffer);
		return hash.digest('hex') === digest;
	} finally { await file.close(); }
}

async function verifyMigratedBodies(directory: string, edits: string, files: ConversationFile[]): Promise<void> {
	const editDir = await storageStat(edits);
	if (editDir && !editDir.isDirectory()) throw new Error('聊天迁移回执目录无效。');
	for (const source of files.filter(({ name }) => name.endsWith('.jsonl'))) {
		const id = source.name.slice(0, -6);
		const path = join(directory, source.name);
		const receipt = editDir ? await readStoredJson(join(edits, source.name + '.json')) : undefined;
		if (!await storageStat(path)) {
			if (receipt === null) continue;
			throw new Error('迁移后的聊天记录缺失，已保留旧副本。');
		}
		const recorded = record(receipt) && typeof receipt.hash === 'string' && typeof receipt.size === 'number'
			&& Number.isSafeInteger(receipt.size) && receipt.size >= 0 && await matchesBody(path, receipt.size, receipt.hash);
		if (!recorded && !await matchesBody(path, source.size, source.hash)) throw new Error('迁移后的聊天内容与记录不符，已保留旧副本。');
		await verifyConversationBody(path, id);
	}
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
	const edits = join(paths.migration, 'chat-edits');
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

	let tracking = importing || Boolean(pending);
	return {
		async recordConversationChange(this: void, id: string, body: string | null): Promise<void> {
			if (!tracking) return;
			// 只记录经过对话存储层的替换或删除；普通追加保留已核对的前缀。
			await ensureStoredDirectory(paths.migration);
			await ensureStoredDirectory(edits);
			await writeStoredJson(join(edits, id + '.jsonl.json'), body === null ? null : {
				hash: createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body),
			});
		},
		paths,
		stored,
		legacy,
		importing,
		needsLegacyMigration: !versionOnly || Boolean(pending) || importing,
		async stageMigration(hasLegacyLocalData: () => boolean): Promise<boolean> {
			if (pending || (!importing && (versionOnly || !hasLegacyLocalData()))) return false;
			// 必须先保存核对记录，之后才能接受对新副本的编辑。
			await ensureStoredDirectory(paths.migration);
			await writeStoredJson(journal, {
				legacyDirectory: relative(root, legacyDirectory),
				settingsHash: hashJson(legacy),
				conversationsHash: conversationHash(legacyFiles),
			} satisfies MigrationReceipt);
			return true;
		},
		async complete(writeVersion: () => Promise<void>, clearLegacy: () => Promise<void>): Promise<void> {
			if (pending) {
				const oldFiles = await listFiles(legacyDirectory);
				const retiredFiles = await listFiles(retired);
				if ((!versionOnly && hashJson(legacy) !== pending.settingsHash)
					|| (oldFiles && retiredFiles)
					|| ((oldFiles || retiredFiles || !versionOnly)
						&& conversationHash(oldFiles ?? retiredFiles) !== pending.conversationsHash)) {
					throw new Error('旧数据在迁移期间发生变化，已保留供检查。');
				}
				await verifyMigratedBodies(paths.conversations, edits, oldFiles ?? retiredFiles ?? []);
				if (!versionOnly) await writeVersion();
				if (oldFiles) await rename(legacyDirectory, retired);
				await clearLegacy();
				await rm(retired, { recursive: true, force: true });
				await unlink(journal);
				tracking = false;
				await rm(edits, { recursive: true, force: true });
				await rmdir(paths.migration).catch((error: unknown) => {
					if (!hasFileErrorCode(error, 'ENOTEMPTY')) throw error;
				});
				return;
			}
			if (!versionOnly) await writeVersion();
		},
	};
}
