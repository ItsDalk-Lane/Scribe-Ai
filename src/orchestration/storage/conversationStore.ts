import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseChatGoal } from '../../interaction/chatGoal';
import { SAVED_SHELL_JOB_LIMIT } from '../../tools/external/shellJobs';
import type { SavedShellJob } from '../../tools/external/shellJobs';
import { MissingConversationError } from '../../types';
import type { ConversationEntry, ConversationSnapshot, ConversationStore, ConversationSummary, HistorySummary, QueuedMessage } from '../../types';
import {
	ConversationRecordError, isMainEntry, isQueueEntry, isSavedShellJob, isSubagentEntry, isSubagentReportEntry,
	parseConversationEntry, parseSavedShellJobs,
	replayConversation, replayQueueEntry, SAVED_SHELL_JOBS_FILE_LIMIT,
} from './taskStore';
import { draftImagePaths, savedImagePaths, retainedImagePaths } from './retainedImages';
import { removeConversationSpills } from '../../tools/support/spillCleanup';
import { createSubagentRecordIndex } from './subagentRecords';
import { sameQueuedDestination } from '../settings/modelConnection';
import { ChatTaskBoard } from './chatTasks';
import type { ChatTask } from './chatTasks';

const idPattern = /^(?!(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$)[A-Z0-9][A-Z0-9-]{0,95}$/i;
const titleLimit = 120;
const goalSuffix = '.goal.json';
const goalSizeLimit = 1024 * 1024;
const writeQueue = new Map<string, Promise<unknown>>();
const deletedLogs = new Set<string>();
const taskSubscribers = new Map<string, Set<() => void>>();
const subagentIndexes = new Map<string, ReturnType<typeof createSubagentRecordIndex>>();
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
async function* readRecords(file: FileHandle, size: number, position = 0, lineNumber = 0) {
	const buffer = Buffer.allocUnsafe(8192);
	const decoder = new StringDecoder('utf8');
	let tail = '';
	while (position < size) {
		const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
		if (!bytesRead) return;
		position += bytesRead;
		const lines = (tail + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
		tail = lines.pop() ?? '';
		for (const line of lines) yield parseConversationEntry(line, ++lineNumber);
	}
}

export async function verifyConversationBody(path: string, id: string): Promise<void> {
	const { file, stat } = await openRegularFile(path);
	try {
		if (stat.size) {
			const last = Buffer.alloc(1);
			if ((await file.read(last, 0, 1, stat.size - 1)).bytesRead !== 1 || last[0] !== 10) throw new Error('迁移后的对话末行不完整。');
		}
		await replayConversation(id, readRecords(file, stat.size));
	} finally { await file.close(); }
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

async function readSubagentIndex(path: string, id: string) {
	const index = createSubagentRecordIndex(id);
	const opened = await openIfExists(path);
	if (!opened) return index;
	try {
		for await (const entry of readRecords(opened.file, opened.stat.size)) index.observe(entry);
		return index;
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
	const queuedTarget = messages[0]?.request.target;
	const startedTarget = first.type === 'start' ? first.task.request.target : undefined;
	const matches = first.type === 'start'
		? ids.length === 1 && first.task.request.instruction === messages[0]?.request.instruction
			&& startedTarget?.kind === queuedTarget?.kind && startedTarget?.id === queuedTarget?.id && startedTarget?.label === queuedTarget?.label
		: messages.every(({ id, request }) => !request.target
			&& first.messages.some((message) => message.role === 'user' && message.id === `steer:${id}`));
	if (!matches) throw new Error('记录与排队消息不匹配。');
	if (fifo && Array.from(queue.keys()).slice(0, ids.length).some((id, index) => id !== ids[index])) {
		throw new Error('排队消息的顺序已经变更。');
	}
	for (const message of messages) {
		const current = findQueued(queue, message.id);
		if (!sameQueuedDestination(current.destination, message.destination) || JSON.stringify(current.request) !== JSON.stringify(message.request)) {
			throw new Error('排队消息已经变更。');
		}
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
export function createConversationStore(directory: string, recordMigrationChange?: (id: string, body: string | null) => Promise<void>, cacheDirectory?: string): ConversationStore {
	const root = resolve(directory);
	const pointer = join(root, 'last-opened');
	const logPath = (id: string) => {
		checkId(id);
		return join(root, `${id}.jsonl`);
	};
	const titlePath = (id: string) => join(root, `${id}.title`);
	const goalPath = (id: string) => join(root, `${id}${goalSuffix}`);
	const archiveName = (id: string) => `${id}.archived`;
	const archivePath = (id: string) => join(root, archiveName(id));
	const compactionPath = (id: string) => join(root, `${id}.compaction.json`);
	async function readGoal(id: string) {
		const opened = await openIfExists(goalPath(id));
		if (!opened) return undefined;
		const { file, stat } = opened;
		try {
			if (stat.size > goalSizeLimit) throw new Error('目标记录过大。');
			const saved = JSON.parse(await file.readFile('utf8')) as { conversationId?: unknown; goal?: unknown } | null;
			const goal = saved?.goal === null ? null : parseChatGoal(saved?.goal);
			if (saved?.conversationId !== id || goal === undefined) throw new Error('目标记录格式无效。');
			return { goal, updatedAt: stat.mtimeMs };
		} finally {
			await file.close();
		}
	}
	async function requireConversation(id: string, path: string) {
		const opened = await openIfExists(path);
		if (opened) await opened.file.close();
		else if (!(await readGoal(id))?.goal) throw new MissingConversationError('对话不存在。');
	}
	async function readCompaction(id: string): Promise<HistorySummary | undefined> {
		try {
			const raw = await readSmallText(compactionPath(id), 30_000);
			if (!raw) return;
			const value = JSON.parse(raw) as Partial<HistorySummary> | null;
			if (value && typeof value.throughTaskId === 'string' && typeof value.text === 'string'
				&& value.throughTaskId && value.text.trim() && Buffer.byteLength(value.text) <= 4_096) {
				return { throughTaskId: value.throughTaskId, text: value.text };
			}
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
		return undefined;
	}
	const shellJobsName = (id: string) => `${id}.shell-jobs.json`;
	const shellJobsPath = (id: string) => join(root, shellJobsName(id));
	async function readShellJobs(id: string) {
		const opened = await openIfExists(shellJobsPath(id));
		if (!opened) return [];
		try {
			if (opened.stat.size > SAVED_SHELL_JOBS_FILE_LIMIT) throw new Error('后台任务记录过大。');
			return parseSavedShellJobs(await opened.file.readFile('utf8'), id);
		} finally {
			await opened.file.close();
		}
	}
	function writeShellJobs(id: string, jobs: SavedShellJob[]) {
		return writeAtomically(shellJobsPath(id), JSON.stringify({ conversationId: id, jobs }));
	}
	function write(id: string, update: (path: string) => Promise<ConversationEntry[]>) {
		const path = logPath(id);
		const key = path.toLowerCase();
		return enqueue(path, async () => {
			if (deletedLogs.has(key)) throw new MissingConversationError('对话已删除。');
			const entries = await update(path);
			if (!entries.length) return;
			let index = subagentIndexes.get(path);
			try {
				if (!index && entries.some((entry) => entry.type === 'subagent' || entry.type === 'subagent-report' || entry.type === 'auxiliary-usage'
					|| (entry.type === 'messages' && entry.messages.some(({ deliveryAgents, subagentActivity }) => deliveryAgents || subagentActivity)))) {
					index = await readSubagentIndex(path, id);
				}
				if (index) {
					for (const entry of entries) {
						if (entry.type === 'subagent' && !isSubagentEntry(entry)) throw new Error('子 Agent 记录格式无效。');
						if (entry.type === 'subagent-report' && !isSubagentReportEntry(entry)) throw new Error('后台结果回传的格式无效。');
						if (entry.type === 'messages') {
							const receipt = entry.messages.some(({ deliveryAgents }) => deliveryAgents);
							if ((receipt || entry.messages.some(({ subagentActivity }) => subagentActivity)) && !isMainEntry(entry)) {
								throw new Error(receipt ? '收件确认的格式无效。' : '协作记录的格式无效。');
							}
						}
						index.observe(entry);
					}
				}
				await mkdir(root, { recursive: true, mode: 0o700 });
				await appendRecords(path, serialize(entries));
				if (index) subagentIndexes.set(path, index);
			} catch (error) {
				// 批次校验或写入失败后，下次以实际落盘的内容重建索引。
				subagentIndexes.delete(path);
				throw error;
			}
		});
	}

	// 只保留最近使用的清单；普通追加只解析新记录，改写或替换会使索引失效。
	const boards = new Map<string, { board: ChatTaskBoard; ino: number; size: number; mtime: number; lines: number }>();
	async function readBoard(id: string, path: string) {
		const opened = await openIfExists(path);
		if (!opened) { boards.delete(path); return new ChatTaskBoard(id); }
		const { file, stat } = opened;
		const cached = boards.get(path);
		const prefix = cached && stat.ino === cached.ino && (stat.size > cached.size || (stat.size === cached.size && stat.mtimeMs === cached.mtime))
			? cached : undefined;
		const board = prefix?.board ?? new ChatTaskBoard(id);
		let lines = prefix?.lines ?? 0;
		boards.delete(path);
		try {
			for await (const entry of readRecords(file, stat.size, prefix?.size, lines)) {
				board.observe(entry);
				lines++;
			}
			const lastByte = Buffer.alloc(1);
			if (!stat.size || (await file.read(lastByte, 0, 1, stat.size - 1)).bytesRead === 1 && lastByte[0] === 10) {
				if (boards.size >= 8) boards.delete(boards.keys().next().value!);
				boards.set(path, { board, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, lines });
			}
			return board.copy();
		} finally { await file.close(); }
	}

	function changedTasks(path: string) {
		for (const refresh of taskSubscribers.get(path.toLowerCase()) ?? []) {
			try { refresh(); } catch { /* 单个界面的异常不影响已保存的记录和其他窗口。 */ }
		}
	}

	async function mutateTask(id: string, change: (board: ChatTaskBoard) => ReturnType<ChatTaskBoard['update']>) {
		let item: ChatTask | undefined;
		await write(id, async (path) => {
			const result = change(await readBoard(id, path));
			item = result.item;
			return [result.event];
		});
		changedTasks(logPath(id));
		return item!;
	}

	const store: ConversationStore = {
		chatTasks: {
			async list(id) {
				const path = logPath(id);
				return enqueue(path, async () => (await readBoard(id, path)).batches);
			},
			async get(id, itemId) {
				const path = logPath(id);
				return enqueue(path, async () => (await readBoard(id, path)).get(itemId).item);
			},
			create: (id, actor, input) => mutateTask(id, (board) => board.create(actor, input)),
			update: (id, actor, input) => mutateTask(id, (board) => board.update(actor, input)),
			async release(id, runId) {
				let changed = false;
				await write(id, async (path) => {
					const events = (await readBoard(id, path)).release(runId);
					changed = events.length > 0;
					return events;
				});
				if (changed) changedTasks(logPath(id));
			},
			async approvePlan(id, planRunId) {
				await write(id, async (path) => (await readBoard(id, path)).approve(planRunId));
				changedTasks(logPath(id));
			},
			subscribe(id, listener) {
				const path = logPath(id).toLowerCase();
				let listeners = taskSubscribers.get(path);
				if (!listeners) { listeners = new Set(); taskSubscribers.set(path, listeners); }
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
					if (!listeners.size) taskSubscribers.delete(path);
				};
			},
		},
		shellJobHistory: {
			async list(id) {
				const path = logPath(id);
				await writeQueue.get(path.toLowerCase())?.catch(() => {});
				if (deletedLogs.has(path.toLowerCase())) return [];
				return readShellJobs(id);
			},
			async save(id, job) {
				const path = logPath(id);
				if (!isSavedShellJob(job)) throw new Error('后台任务结果格式无效。');
				await enqueue(path, async () => {
					if (deletedLogs.has(path.toLowerCase())) throw new MissingConversationError('对话已删除。');
					const opened = await openIfExists(path);
					if (!opened) throw new MissingConversationError('对话不存在。');
					let owner: string | undefined;
					try {
						for await (const entry of readRecords(opened.file, opened.stat.size)) {
							if (entry.type !== 'start') continue;
							owner = entry.task.request.conversationId;
							break;
						}
					} finally {
						await opened.file.close();
					}
					if (owner !== id) throw new Error('任务不属于此对话。');
					const jobs = (await readShellJobs(id)).filter((saved) => saved.id !== job.id);
					jobs.push(job);
					await writeShellJobs(id, jobs.slice(-SAVED_SHELL_JOB_LIMIT));
				});
			},
			async markRead(id, jobId) {
				const path = logPath(id);
				const key = jobId.toLowerCase();
				await enqueue(path, async () => {
					if (deletedLogs.has(path.toLowerCase())) return;
					const opened = await openIfExists(path);
					if (!opened) return;
					await opened.file.close();
					const jobs = await readShellJobs(id);
					const job = jobs.find((item) => item.id === key);
					if (!job?.unread) return;
					delete job.unread;
					await writeShellJobs(id, jobs);
				});
			},
		},
		async list() {
			const files = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
				if (isMissing(error)) return [];
				throw error;
			});
			const chats: ConversationSummary[] = [];
			const names = new Set(files.filter((file) => file.isFile()).map(({ name }) => name));
			const ids = new Set([...names].flatMap((name) => name.endsWith('.jsonl') ? [name.slice(0, -6)]
				: name.endsWith(goalSuffix) ? [name.slice(0, -goalSuffix.length)] : []));
			for (const id of ids) {
				if (!idPattern.test(id)) continue;
				let summary = names.has(`${id}.jsonl`) ? await conversationSummary(logPath(id), id) : undefined;
				if (!summary && names.has(`${id}${goalSuffix}`)) {
					const saved = await readGoal(id).catch(() => undefined);
					if (saved?.goal) summary = { id, title: saved.goal.objective.trim().replace(/\s+/g, ' ').slice(0, 80), updatedAt: saved.updatedAt };
				}
				if (!summary) continue;
				const [title, unreadResult] = await Promise.all([
					readSmallText(titlePath(id), titleLimit * 4).catch(() => undefined),
					names.has(shellJobsName(id)) && readShellJobs(id).then((jobs) => jobs.some((job) => job.unread)).catch(() => false),
				]);
				if (title && title.length <= titleLimit) summary.title = title;
				if (unreadResult) summary.unreadResult = true;
				if (names.has(archiveName(id))) summary.archived = true;
				chats.push(summary);
			}
			return chats.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
		},
		async load(id) {
			const path = logPath(id);
			await writeQueue.get(path.toLowerCase())?.catch(() => {});
			const opened = await openIfExists(path);
			let snapshot: ConversationSnapshot = { id, runs: [] };
			if (opened) {
				try {
					snapshot = await replayConversation(id, readRecords(opened.file, opened.stat.size));
					const compact = await readCompaction(id);
					if (compact && snapshot.runs.some(({ state }) => state.taskId === compact.throughTaskId)) snapshot.manualCompaction = compact;
				} finally {
					await opened.file.close();
				}
			}
			if (!snapshot.runs.length && !snapshot.queue?.length && (await readGoal(id).catch(() => undefined))?.goal) snapshot.hasGoal = true;
			return snapshot;
		},
		async loadGoal(id) {
			const path = logPath(id);
			return enqueue(path, async () => deletedLogs.has(path.toLowerCase()) ? null : (await readGoal(id))?.goal);
		},
		async saveGoal(id, goal) {
			const path = logPath(id);
			const valid = goal === null ? null : parseChatGoal(goal);
			if (valid === undefined) throw new Error('目标记录格式无效。');
			const data = JSON.stringify({ conversationId: id, goal: valid });
			if (Buffer.byteLength(data) > goalSizeLimit) throw new Error('目标记录过大。');
			await enqueue(path, async () => {
				if (deletedLogs.has(path.toLowerCase())) throw new MissingConversationError('对话已删除。');
				await mkdir(root, { recursive: true, mode: 0o700 });
				await writeAtomically(goalPath(id), data);
			});
		},
		async getQueued(id) {
			const path = logPath(id);
			await writeQueue.get(path.toLowerCase())?.catch(() => {});
			return [...(await readQueued(path, id)).values()];
		},
		async enqueue(id, message) {
			if (message.request.selection) throw new Error('选区问答已停用，请新建普通提问。');
			return write(id, async (path) => {
				const entry = parseConversationEntry(JSON.stringify({ type: 'queue-add', message }), 1);
				const queue = await readQueued(path, id);
				const previous = queue.get(message.id);
				if (previous && JSON.stringify(previous) === JSON.stringify(message)) return [];
				replayQueueEntry(id, queue, entry);
				return [entry];
			});
		},
		async editQueued(id, messageId, instruction, skillMentions) {
			return write(id, async (path) => {
				const { request } = findQueued(await readQueued(path, id), messageId);
				if (request.refs.length || request.selection) throw new Error('包含非文本内容，暂不支持编辑。');
				if (!instruction.trim()) throw new Error('请输入任务。');
				return [{ type: 'queue-edit', messageId, instruction, ...(skillMentions && { skillMentions }) }];
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
					const run = entry.type === 'subagent' && entry.record.kind === 'run' ? entry.record.entry : entry;
					if (run.type === 'start') run.task.request.conversationId = branchId;
				}
				const branch = await replayConversation(branchId, entries);
				const compact = await readCompaction(id);
				if (compact && branch.runs.some(({ state }) => state.taskId === compact.throughTaskId)) {
					await writeAtomically(compactionPath(branchId), JSON.stringify(compact));
					branch.manualCompaction = compact;
				}
				try {
					await writeAtomically(logPath(branchId), serialize(entries));
				} catch (error) {
					if (branch.manualCompaction) await unlinkIfExists(compactionPath(branchId)).catch(() => {});
					throw error;
				}
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
				const body = serialize(replacement);
				await recordMigrationChange?.(id, body);
				await writeAtomically(path, body);
				subagentIndexes.delete(path);
			});
			changedTasks(path);
		},
		async rename(id, title) {
			const path = logPath(id);
			const value = title.trim();
			if (!value || value.length > titleLimit) throw new Error('请输入 1 到 120 个字符的对话名称。');
			await enqueue(path, async () => {
				await requireConversation(id, path);
				await writeAtomically(titlePath(id), value);
			});
		},
		async setArchived(id, archived) {
			const path = logPath(id);
			await enqueue(path, async () => {
				await requireConversation(id, path);
				if (archived) await writeAtomically(archivePath(id), '1\n');
				else await unlinkIfExists(archivePath(id));
			});
		},
		async saveManualCompaction(id, summary) {
			const path = logPath(id);
			if (!summary.text.trim() || Buffer.byteLength(summary.text) > 4_096) throw new Error('整理后的摘要格式无效。');
			await enqueue(path, async () => {
				const entries = await readThroughTask(path, id, summary.throughTaskId, true);
				const snapshot = await replayConversation(id, entries);
				if (!snapshot.runs.some(({ state }) => state.taskId === summary.throughTaskId)) {
					throw new Error('对话已变化，请重新整理。');
				}
				await writeAtomically(compactionPath(id), JSON.stringify(summary));
			});
		},
		async delete(id) {
			const path = logPath(id);
			const referenced = cacheDirectory ? await savedImagePaths(store, id).catch(() => new Set<string>()) : new Set<string>();
			for (const image of draftImagePaths(store, id)) referenced.add(image);
			await enqueue(path, () => enqueue(pointer, async () => {
				const selected = await readPointer(pointer);
				await recordMigrationChange?.(id, null);
				await unlinkIfExists(shellJobsPath(id));
				await unlinkIfExists(goalPath(id));
				await unlinkIfExists(titlePath(id));
				await unlinkIfExists(archivePath(id));
				await unlinkIfExists(compactionPath(id));
				await unlinkIfExists(path);
				// 阻止已经排队的旧写入在删除后重新建立记录。
				deletedLogs.add(path.toLowerCase());
				boards.delete(path);
				subagentIndexes.delete(path);
				if (selected?.toLowerCase() === id.toLowerCase()) await unlinkIfExists(pointer);
			}));
			changedTasks(path);
			if (cacheDirectory) await removeConversationSpills(cacheDirectory, id, referenced, () => retainedImagePaths(store, id));
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
	return store;
}
