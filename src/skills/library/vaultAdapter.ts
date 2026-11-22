import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { hasFileErrorCode } from '../../tools/support/pathUtils';

const libraryPrefix = '.scribe-ai/skills';
const bytesLimit = 50 * 1024 * 1024;
export function safeResourcePath(path: string): boolean {
	return path.length > 0 && path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'
		&& !/[\\:\0]/u.test(part) && !/[. ]$/u.test(part)
		&& !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part));
}
async function safePath(root: string, path: string): Promise<string> {
	if (!safeResourcePath(path) || (path !== libraryPrefix && !path.startsWith(libraryPrefix + '/'))) throw new Error('路径超出当前库的技能目录。');
	let current = await realpath(root);
	for (const part of path.split('/')) {
		current = join(current, part);
		const stat = await lstat(current).catch((error: unknown) => {
			if (!hasFileErrorCode(error, 'ENOENT')) throw error;
		});
		if (stat && (stat.isSymbolicLink() || !(stat.isDirectory() || (stat.isFile() && stat.nlink === 1)))) {
			throw new Error('技能目录中含有链接或特殊文件。');
		}
	}
	return current;
}
export function createLibraryVault(root: string) {
	async function read(path: string, maximum?: number) {
		const file = await open(await safePath(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			const meta = await file.stat();
			if (!meta.isFile() || meta.nlink !== 1 || meta.size > bytesLimit) throw new Error('文件不符合技能大小或安全限制。');
			if (maximum !== undefined && meta.size > maximum) {
				const bytes = Buffer.alloc(maximum);
				let offset = 0;
				while (offset < bytes.length) {
					const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
					if (!bytesRead) break;
					offset += bytesRead;
				}
				return bytes.subarray(0, offset);
			}
			return await file.readFile();
		} finally { await file.close(); }
	}
	async function write(path: string, content: string | ArrayBuffer) {
		const file = await open(await safePath(root, path), 'wx', 0o600);
		try { await file.writeFile(typeof content === 'string' ? content : Buffer.from(content)); } finally { await file.close(); }
	}
	return { root, adapter: {
		exists: async (path: string) => {
			const absolute = await safePath(root, path);
			return lstat(absolute).then(() => true, (error: unknown) => {
				if (hasFileErrorCode(error, 'ENOENT')) return false;
				throw error;
			});
		},
		list: async (path: string) => {
			const entries = await readdir(await safePath(root, path), { withFileTypes: true });
			const files: string[] = [], folders: string[] = [];
			for (const entry of entries) {
				if (entry.isDirectory()) folders.push(path + '/' + entry.name);
				else files.push(path + '/' + entry.name);
			}
			return { files, folders };
		},
		read: async (path: string) => new TextDecoder('utf-8', { fatal: true }).decode(await read(path)),
		readHead: async (path: string, maximum: number) => new TextDecoder().decode(await read(path, maximum)),
		readBinary: read,
		write, writeBinary: write,
		rename: async (from: string, to: string) => rename(await safePath(root, from), await safePath(root, to)),
		rmdir: async (path: string, recursive: boolean) => {
			if (!/^\.scribe-ai\/skills\/\.operations\/[a-f0-9-]{36}$/u.test(path)) throw new Error('无效的临时操作目录。');
			await rm(await safePath(root, path), { recursive });
		},
	} };
}
export type LibraryVault = ReturnType<typeof createLibraryVault>;
export async function assertScribePath(vault: LibraryVault, path: string) { await safePath(vault.root, path); }
export async function ensureFolderExists(vault: LibraryVault, path: string) {
	await mkdir(await safePath(vault.root, path), { recursive: true, mode: 0o700 });
	await assertScribePath(vault, path);
}
export async function writeVaultFile(vault: LibraryVault, path: string, value: string, expected: string | null) {
	await safePath(vault.root, path);
	if (expected === null) { await vault.adapter.write(path, value); return; }
	const recovery = libraryPrefix + '/.operations';
	await ensureFolderExists(vault, recovery);
	const temporary = await safePath(vault.root, recovery + '/.writing-' + randomUUID());
	const file = await open(temporary, 'wx', 0o600);
	try {
		try { await file.writeFile(value); } finally { await file.close(); }
		if ((await vault.adapter.read(path)) !== expected) throw new Error('技能在其他地方已修改，请重新加载。');
		await rename(temporary, await safePath(vault.root, path));
	} finally { await rm(temporary, { force: true }); }
}
