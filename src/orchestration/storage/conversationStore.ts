import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ConversationStore, ConversationSummary } from '../../types';
import { ConversationRecordError, parseConversationEntry, replayConversation } from './taskStore';

const idPattern = /^(?!(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$)[A-Z0-9][A-Z0-9-]{0,95}$/i;
const writeQueue = new Map<string, Promise<void>>();
const noFollow = constants.O_NOFOLLOW ?? 0;

function checkId(id: string): void {
	if (!idPattern.test(id)) throw new Error('对话编号无效。');
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function enqueue(path: string, write: () => Promise<void>): Promise<void> {
	const pending = writeQueue.get(path) ?? Promise.resolve();
	const next = pending.catch(() => {}).then(write);
	writeQueue.set(path, next);
	try {
		await next;
	} finally {
		if (writeQueue.get(path) === next) writeQueue.delete(path);
	}
}

async function openRegularFile(path: string, flags = constants.O_RDONLY) {
	const file = await open(path, flags | noFollow | (constants.O_NONBLOCK ?? 0), 0o600);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1) throw new Error('对话记录的存储位置无效。');
		return { file, stat };
	} catch (error) {
		await file.close();
		throw error;
	}
}

function openIfExists(path: string) {
	return openRegularFile(path).catch((error: unknown) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
}

/** 只回放以换行结尾的记录，未写完的末行留待下次追加时清理。 */
async function* readRecords(file: FileHandle, size: number) {
	const buffer = Buffer.allocUnsafe(8192);
	const decoder = new StringDecoder('utf8');
	let tail = '';
	let lineNumber = 0;
	let position = 0;
	while (position < size) {
		const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
		if (!bytesRead) return;
		position += bytesRead;
		const lines = (tail + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
		tail = lines.pop() ?? '';
		for (const line of lines) yield parseConversationEntry(line, ++lineNumber);
	}
}

async function appendRecords(path: string, payload: string): Promise<void> {
	const { file, stat } = await openRegularFile(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND);
	try {
		const buffer = Buffer.allocUnsafe(8192);
		let position = stat.size;
		while (position > 0) {
			const start = Math.max(0, position - buffer.length);
			const { bytesRead } = await file.read(buffer, 0, position - start, start);
			const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
			if (newline >= 0) {
				position = start + newline + 1;
				break;
			}
			position = start;
		}
		if (position !== stat.size) await file.truncate(position);
		await file.appendFile(payload, 'utf8');
		await file.sync();
	} finally {
		await file.close();
	}
}

async function conversationSummary(path: string, id: string): Promise<ConversationSummary | undefined> {
	const opened = await openIfExists(path);
	if (!opened) return undefined;
	const { file, stat } = opened;
	try {
		for await (const entry of readRecords(file, stat.size)) {
			if (entry.type !== 'start' || entry.task.request.conversationId !== id) {
				throw new ConversationRecordError('对话记录缺少起始任务。');
			}
			return { id, title: entry.task.request.instruction.trim().replace(/\s+/g, ' ').slice(0, 80), updatedAt: stat.mtimeMs };
		}
		return undefined;
	} catch (error) {
		if (!(error instanceof ConversationRecordError)) throw error;
		return { id, title: '无法读取对话标题', updatedAt: stat.mtimeMs };
	} finally {
		await file.close();
	}
}

/** 每个会话在当前笔记库的插件目录拥有独立的本地记录。 */
export function createConversationStore(directory: string): ConversationStore {
	const root = resolve(directory);
	const pointer = join(root, 'last-opened');
	const logPath = (id: string) => {
		checkId(id);
		return join(root, `${id}.jsonl`);
	};

	return {
		async list() {
			const files = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
				if (isMissing(error)) return [];
				throw error;
			});
			const chats: ConversationSummary[] = [];
			for (const file of files) {
				if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
				const id = file.name.slice(0, -6);
				if (!idPattern.test(id)) continue;
				const summary = await conversationSummary(join(root, file.name), id);
				if (summary) chats.push(summary);
			}
			return chats.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
		},
		async load(id) {
			const path = logPath(id);
			await writeQueue.get(path)?.catch(() => {});
			const opened = await openIfExists(path);
			if (!opened) return { id, runs: [] };
			try {
				return await replayConversation(id, readRecords(opened.file, opened.stat.size));
			} finally {
				await opened.file.close();
			}
		},
		async lastOpened() {
			await writeQueue.get(pointer)?.catch(() => {});
			const opened = await openIfExists(pointer);
			if (!opened) return undefined;
			try {
				if (opened.stat.size > 100) return undefined;
				const id = (await opened.file.readFile('utf8')).trim();
				return idPattern.test(id) ? id : undefined;
			} finally {
				await opened.file.close();
			}
		},
		async setLastOpened(id) {
			checkId(id);
			await enqueue(pointer, async () => {
				await mkdir(root, { recursive: true, mode: 0o700 });
				const temporary = join(root, `last-opened-${randomUUID()}.tmp`);
				const file = await open(temporary, 'wx', 0o600);
				try {
					try {
						await file.writeFile(`${id}\n`, 'utf8');
						await file.sync();
					} finally {
						await file.close();
					}
					await rename(temporary, pointer);
				} catch (error) {
					await unlink(temporary).catch(() => {});
					throw error;
				}
			});
		},
		async append(id, entries) {
			const path = logPath(id);
			if (!entries.length) return;
			if (entries.some((entry) => entry.type === 'start' && entry.task.request.conversationId !== id)) {
				throw new Error('任务不属于此对话。');
			}
			const payload = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
			await enqueue(path, async () => {
				await mkdir(root, { recursive: true, mode: 0o700 });
				await appendRecords(path, payload);
			});
		},
	};
}
