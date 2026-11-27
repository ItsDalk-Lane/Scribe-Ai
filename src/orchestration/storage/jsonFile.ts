import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hasFileErrorCode } from '../../tools/support/pathUtils';

export function storageStat(path: string) {
	return lstat(path).catch((error: unknown) => {
		if (!hasFileErrorCode(error, 'ENOENT')) throw error;
	});
}

export async function ensureStoredDirectory(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
		if (!hasFileErrorCode(error, 'EEXIST')) throw error;
	});
	if (!(await lstat(path)).isDirectory()) throw new Error('Scribe Ai 的数据目录无效。');
}

export async function openStoredFile(path: string) {
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1) throw new Error('Scribe Ai 的数据文件无效。');
		return { file, stat };
	} catch (error) {
		await file.close();
		throw error;
	}
}

export async function readStoredJson(path: string): Promise<unknown> {
	const opened = await openStoredFile(path).catch((error: unknown) => {
		if (!hasFileErrorCode(error, 'ENOENT')) throw error;
	});
	if (!opened) return undefined;
	try {
		return JSON.parse(await opened.file.readFile('utf8')) as unknown;
	} finally {
		await opened.file.close();
	}
}

export async function writeStoredJson(path: string, data: unknown): Promise<void> {
	await writeStoredText(path, JSON.stringify(data, null, 2) + '\n');
}

export async function writeStoredText(path: string, text: string): Promise<void> {
	const directory = dirname(path);
	const temporary = join(directory, `.write-${randomUUID()}.tmp`);
	if (!(await lstat(directory)).isDirectory()) throw new Error('Scribe Ai 的数据目录无效。');
	const file = await open(temporary, 'wx', 0o600);
	try {
		try {
			await file.writeFile(text, 'utf8');
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!hasFileErrorCode(error, 'ENOENT')) throw error;
		});
	}
}
