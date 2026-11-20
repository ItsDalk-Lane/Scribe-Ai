import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { MissingConversationError } from '../../types';
import type { ConversationEntry, ConversationStore, ConversationSummary, QueuedMessage } from '../../types';
import { ConversationRecordError, isQueueEntry, parseConversationEntry, replayConversation, replayQueueEntry } from './taskStore';

const idPattern = /^(?!(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$)[A-Z0-9][A-Z0-9-]{0,95}$/i;
const titleLimit = 120;
const writeQueue = new Map<string, Promise<unknown>>();
const deletedLogs = new Set<string>();
const noFollow = constants.O_NOFOLLOW ?? 0;

function checkId(id: string): void {
	if (!idPattern.test(id)) throw new Error('对话编号无效。');
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function enqueue<T>(path: string, write: () => Promise<T>): Promise<T> {
	const key = path.toLowerCase();
	const pending = writeQueue.get(key) ?? Promise.resolve();
	const next = pending.catch(() => {}).then(write);
	writeQueue.set(key, next);
	try {
		return await next;
	} finally {
		if (writeQueue.get(key) === next) writeQueue.delete(key);
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

async function readSmallText(path: string, limit: number): Promise<string | undefined> {
	const opened = await openIfExists(path);
	if (!opened) return undefined;
	try {
		return opened.stat.size <= limit ? (await opened.file.readFile('utf8')).trim() : undefined;
	} finally {
		await opened.file.close();
	}
}

async function readPointer(path: string): Promise<string | undefined> {
	const id = await readSmallText(path, 100);
	return id && idPattern.test(id) ? id : undefined;
}

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

async function writeAtomically(path: string, value: string): Promise<void> {
	const temporary = `${path}-${randomUUID()}.tmp`;
	const file = await open(temporary, 'wx', 0o600);
	try {
		try {
			await file.writeFile(value, 'utf8');
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
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

async function readThroughTask(path: string, id: string, taskId: string, inclusive: boolean): Promise<ConversationEntry[]> {
	const opened = await openIfExists(path);
	if (!opened) throw new Error('对话不存在。');
	const { file, stat } = opened;
	const entries: ConversationEntry[] = [];
	let found = false;
	try {
		for await (const entry of readRecords(file, stat.size)) {
			if (isQueueEntry(entry)) continue;
			if (entry.type === 'start') {
				if (found) break;
				if (entry.task.request.conversationId !== id) throw new Error('任务不属于此对话。');
				found = entry.task.id === taskId;
				if (found && !inclusive) break;
			}
			if (entry.type === 'start' || entry.type === 'messages') delete entry.consumedQueueIds;
			entries.push(entry);
		}
	} finally {
		await file.close();
	}
	if (!found) throw new Error('对话中找不到这条消息。');
	return entries;
}

function serialize(entries: ConversationEntry[]): string {
	return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
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

async function readQueued(path: string, id: string): Promise<Map<string, QueuedMessage>> {
	const queue = new Map<string, QueuedMessage>();
	const opened = await openIfExists(path);
	if (!opened) return queue;
	try {
		for await (const entry of readRecords(opened.file, opened.stat.size)) replayQueueEntry(id, queue, entry);
		return queue;
	} finally {
		await opened.file.close();
	}
}

function findQueued(queue: Map<string, QueuedMessage>, messageId: string): QueuedMessage {
	const message = queue.get(messageId);
	if (!message) throw new Error('找不到排队消息。');
	return message;
}

function consumeQueued(entries: ConversationEntry[], queue: Map<string, QueuedMessage>, { messages, fifo }: {
	messages: QueuedMessage[]; fifo?: boolean;
}): ConversationEntry[] {
	const [first, ...remaining] = entries;
	if (first?.type !== 'start' && first?.type !== 'messages') throw new Error('排队消息缺少已发送的记录。');
	const ids = messages.map(({ id }) => id);
	if (new Set(ids).size !== ids.length) throw new Error('排队消息重复。');
	const matches = first.type === 'start'
		? ids.length === 1 && first.task.request.instruction === messages[0]?.request.instruction
		: ids.every((id) => first.messages.some((message) => message.role === 'user' && message.id === `steer:${id}`));
	if (!matches) throw new Error('记录与排队消息不匹配。');
	if (fifo && Array.from(queue.keys()).slice(0, ids.length).some((id, index) => id !== ids[index])) {
		throw new Error('排队消息的顺序已经变更。');
	}
	for (const message of messages) {
		const current = findQueued(queue, message.id);
		if (JSON.stringify(current.request) !== JSON.stringify(message.request)) throw new Error('排队消息已经变更。');
	}
	// 与开始任务或插话正文写在同一行，重开时不会只恢复其中一半。
	return [{ ...first, consumedQueueIds: ids }, ...remaining];
}

async function conversationSummary(path: string, id: string): Promise<ConversationSummary | undefined> {
	const opened = await openIfExists(path);
	if (!opened) return undefined;
	const { file, stat } = opened;
	try {
		const queue = new Map<string, QueuedMessage>();
		const summary = (instruction: string) => ({ id, title: instruction.trim().replace(/\s+/g, ' ').slice(0, 80), updatedAt: stat.mtimeMs });
		for await (const entry of readRecords(file, stat.size)) {
			replayQueueEntry(id, queue, entry);
			if (isQueueEntry(entry)) continue;
			if (entry.type !== 'start') {
				throw new ConversationRecordError('对话记录缺少起始任务。');
			}
			return summary(entry.task.request.instruction);
		}
		const first = queue.values().next().value;
		return first ? summary(first.request.instruction) : undefined;
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
	const titlePath = (id: string) => join(root, `${id}.title`);
	function write(id: string, update: (path: string) => Promise<ConversationEntry[]>) {
		const path = logPath(id);
		return enqueue(path, async () => {
			if (deletedLogs.has(path.toLowerCase())) throw new MissingConversationError('对话已删除。');
			const entries = await update(path);
			if (!entries.length) return;
			await mkdir(root, { recursive: true, mode: 0o700 });
			await appendRecords(path, serialize(entries));
		});
	}

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
				if (!summary) continue;
				const title = await readSmallText(titlePath(id), titleLimit * 4).catch(() => undefined);
				chats.push(title && title.length <= titleLimit ? { ...summary, title } : summary);
			}
			return chats.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
		},
		async load(id) {
			const path = logPath(id);
			await writeQueue.get(path.toLowerCase())?.catch(() => {});
			const opened = await openIfExists(path);
			if (!opened) return { id, runs: [] };
			try {
				return await replayConversation(id, readRecords(opened.file, opened.stat.size));
			} finally {
				await opened.file.close();
			}
		},
		async getQueued(id) {
			const path = logPath(id);
			await writeQueue.get(path.toLowerCase())?.catch(() => {});
			return [...(await readQueued(path, id)).values()];
		},
		async enqueue(id, message) {
			return write(id, async (path) => {
				const entry = parseConversationEntry(JSON.stringify({ type: 'queue-add', message }), 1);
				const queue = await readQueued(path, id);
				const previous = queue.get(message.id);
				if (previous && JSON.stringify(previous) === JSON.stringify(message)) return [];
				replayQueueEntry(id, queue, entry);
				return [entry];
			});
		},
		async editQueued(id, messageId, instruction) {
			return write(id, async (path) => {
				const { request } = findQueued(await readQueued(path, id), messageId);
				if (request.refs.length || request.selection) throw new Error('包含非文本内容，暂不支持编辑。');
				if (!instruction.trim()) throw new Error('请输入任务。');
				return [{ type: 'queue-edit', messageId, instruction }];
			});
		},
		async deleteQueued(id, messageId) {
			return write(id, async (path) => {
				findQueued(await readQueued(path, id), messageId);
				return [{ type: 'queue-delete', messageId }];
			});
		},
		async fork(id, taskId) {
			const path = logPath(id);
			const branchId = randomUUID();
			return enqueue(path, async () => {
				const entries = await readThroughTask(path, id, taskId, true);
				for (const entry of entries) {
					if (entry.type === 'start') entry.task.request.conversationId = branchId;
				}
				const branch = await replayConversation(branchId, entries);
				await writeAtomically(logPath(branchId), serialize(entries));
				return branch;
			});
		},
		async replaceFrom(id, taskId, entries) {
			const path = logPath(id);
			if (entries[0]?.type !== 'start') throw new Error('改写对话缺少新的起始任务。');
			await enqueue(path, async () => {
				const kept = await readThroughTask(path, id, taskId, false);
				const pending = [...(await readQueued(path, id)).values()].map((message): ConversationEntry => ({ type: 'queue-add', message }));
				const replacement = [...kept, ...entries, ...pending];
				await replayConversation(id, replacement);
				await writeAtomically(path, serialize(replacement));
			});
		},
		async rename(id, title) {
			const path = logPath(id);
			const value = title.trim();
			if (!value || value.length > titleLimit) throw new Error('请输入 1 到 120 个字符的对话名称。');
			await enqueue(path, async () => {
				const opened = await openIfExists(path);
				if (!opened) throw new Error('对话不存在。');
				await opened.file.close();
				await writeAtomically(titlePath(id), value);
			});
		},
		async delete(id) {
			const path = logPath(id);
			await enqueue(path, () => enqueue(pointer, async () => {
				const selected = await readPointer(pointer);
				await unlinkIfExists(titlePath(id));
				await unlinkIfExists(path);
				// 阻止已经排队的旧写入在删除后重新建立记录。
				deletedLogs.add(path.toLowerCase());
				if (selected?.toLowerCase() === id.toLowerCase()) await unlinkIfExists(pointer);
			}));
		},
		async lastOpened() {
			await writeQueue.get(pointer.toLowerCase())?.catch(() => {});
			return readPointer(pointer);
		},
		async setLastOpened(id) {
			const path = logPath(id);
			await enqueue(pointer, async () => {
				if (deletedLogs.has(path.toLowerCase())) throw new MissingConversationError('对话已删除。');
				await mkdir(root, { recursive: true, mode: 0o700 });
				await writeAtomically(pointer, `${id}\n`);
			});
		},
		async append(id, entries, consumption) {
			if (!entries.length) {
				checkId(id);
				return;
			}
			if (entries.some((entry) => entry.type === 'start' && entry.task.request.conversationId !== id)) {
				throw new Error('任务不属于此对话。');
			}
			await write(id, async (path) => consumption?.messages.length
				? consumeQueued(entries, await readQueued(path, id), consumption) : entries);
		},
	};
}
