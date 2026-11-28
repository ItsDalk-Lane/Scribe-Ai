/// <reference lib="es2022.intl" />

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdir, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hasFileErrorCode } from '../../tools/support/pathUtils';
import type { ConversationStore, Message } from '../../types';
import { ensureStoredDirectory, openStoredFile, storageStat, writeStoredText } from '../storage/jsonFile';
import type { LocalState } from '../storage/localState';
import { scribeDataPaths } from '../storage/paths';

export interface MemoryIndexEntry {
	topic: string;
	summary: string;
	updatedAt: string;
}

export type MemoryEntry = MemoryIndexEntry & { content: string };

const safeTopic = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9-]{0,47}$/u;
const limit = 100;
const headerLimit = 1_024;
const bodyLimit = 8_192;
const indexLimit = 12_000;
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const slots = new WeakMap<LocalState, { revision: number; queue: Promise<unknown> }>();
const receiptMarker = /\n<!-- scribe-memory-receipt:([a-f0-9]{64}) -->$/u;

function contentsDigest(value: unknown) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function memoryReceipt(label: string, value: unknown) {
	return `${label}\n<!-- scribe-memory-receipt:${contentsDigest(value)} -->`;
}

export function normalizeMemoryText(summary: string, content: string): Pick<MemoryEntry, 'summary' | 'content'> {
	summary = summary.trim().replace(/\s+/gu, ' ');
	content = content.trim();
	if (!summary || Buffer.byteLength(summary) > 320 || /\p{Cc}/u.test(summary) || !content || Buffer.byteLength(content) > bodyLimit) {
		throw new Error('请输入摘要和正文，摘要上限为 320 字节，正文上限为 8 KiB。');
	}
	if (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9_.-]{24,}/iu.test(summary + '\n' + content)) {
		throw new Error('此内容含认证凭据，请从记忆中移除凭据后再保存。');
	}
	return { summary, content };
}

function topicName(value: string): string {
	if (!safeTopic.test(value)) throw new Error('记忆主题须使用 1–48 个小写英文字母、数字或连字符。');
	return value;
}

function terms(query: string): string[] {
	const trimmed = query.trim().slice(0, 400).toLowerCase();
	if (!trimmed) throw new Error('请输入要检索的关键词。');
	const words = Array.from(segmenter.segment(trimmed)).filter(({ isWordLike, segment }) => isWordLike && segment.length > 1);
	return words.length ? [...new Set(words.map(({ segment }) => segment))].slice(0, 12) : [trimmed];
}

function readHeader(line: string, topic: string): MemoryIndexEntry {
	const value = JSON.parse(line) as Partial<MemoryIndexEntry> | null;
	if (!value || value.topic !== topic || typeof value.summary !== 'string' || !value.summary.trim()
		|| typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
		throw new Error('记忆文件格式无效。');
	}
	return { topic, summary: value.summary, updatedAt: value.updatedAt };
}

export function createLongTermMemory(vaultRoot: string, localState: LocalState,
	conversations?: Pick<ConversationStore, 'list' | 'load'>, conversationId?: string) {
	let slot = slots.get(localState);
	if (!slot) {
		slot = { revision: 0, queue: Promise.resolve() };
		slots.set(localState, slot);
	}
	const shared = slot;
	const enabled = localState.memoryEnabled;
	const ensureEnabled = () => {
		if (!enabled()) throw new Error('当前库未启用长期记忆。');
	};
	const version = () => shared.revision + localState.contextVersion();
	const queue = <T>(operation: () => Promise<T>) => {
		const result = shared.queue.then(operation);
		shared.queue = result.catch(() => {});
		return result;
	};
	async function directory(create = false, scopeId = localState.memoryScope): Promise<string | undefined> {
		const paths = scribeDataPaths(await realpath(vaultRoot));
		const scope = join(paths.memory, scopeId);
		for (const path of [paths.root, paths.memory, scope]) {
			if (create) await ensureStoredDirectory(path);
			const info = await storageStat(path);
			if (!info) return;
			if (!info.isDirectory() || await realpath(path) !== path) throw new Error('记忆存储位置无效。');
		}
		return scope;
	}
	async function read(scope: string, topic: string, full: true): Promise<MemoryEntry | undefined>;
	async function read(scope: string, topic: string, full: false): Promise<MemoryIndexEntry | undefined>;
	async function read(scope: string, topic: string, full: boolean): Promise<MemoryIndexEntry | MemoryEntry | undefined> {
		const opened = await openStoredFile(join(scope, topicName(topic) + '.txt')).catch((error: unknown) => {
			if (!hasFileErrorCode(error, 'ENOENT')) throw error;
		});
		if (!opened) return;
		try {
			const { file, stat } = opened;
			if (stat.size > headerLimit + bodyLimit) throw new Error('记忆文件过大。');
			const bytes = Buffer.alloc(full ? stat.size : Math.min(stat.size, headerLimit));
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			const newline = bytes.indexOf(10);
			if (bytesRead !== bytes.length || newline < 0 || newline >= headerLimit) throw new Error('记忆文件格式无效。');
			const entry = readHeader(bytes.toString('utf8', 0, newline), topic);
			return full ? { ...entry, content: bytes.toString('utf8', newline + 1, bytesRead) } : entry;
		} finally {
			await opened.file.close();
		}
	}
	async function topics(scope: string) {
		return (await readdir(scope)).flatMap((file) => {
			const topic = file.endsWith('.txt') ? file.slice(0, -4) : '';
			return safeTopic.test(topic) ? [topic] : [];
		}).sort().slice(0, limit + 1);
	}
	async function list() {
		const scope = await directory();
		const entries: MemoryIndexEntry[] = [];
		if (scope) for (const topic of await topics(scope)) {
			const entry = await read(scope, topic, false);
			if (entry) entries.push(entry);
		}
		return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.topic.localeCompare(right.topic));
	}
	async function checkExpected(scope: string, topic: string, expected: MemoryEntry | null | undefined) {
		const current = await read(scope, topic, true);
		if (expected !== undefined && JSON.stringify(current ?? null) !== JSON.stringify(expected)) {
			throw new Error('这条记忆已变化，请重新读取后再修改。');
		}
		return current;
	}
	const run = {
		enabled, version,
		list: () => queue(list),
		async hasLegacy() {
			const scopeId = localState.legacyMemoryScope();
			const scope = scopeId ? await directory(false, scopeId) : undefined;
			return Boolean(scope && (await topics(scope)).length);
		},
		restoreLegacy: () => queue(async () => {
			const scopeId = localState.legacyMemoryScope();
			const previous = scopeId ? await directory(false, scopeId) : undefined;
			if (!previous) return;
			const scope = (await directory(true))!;
			const existing = new Set(await topics(scope));
			const missing = (await topics(previous)).filter((topic) => !existing.has(topic));
			if (existing.size + missing.length > limit) throw new Error('合并后超过 100 个记忆主题，请先清理当前记忆。');
			for (const topic of missing) {
				const entry = await read(previous, topic, true);
				if (!entry) continue;
				const { summary, content } = normalizeMemoryText(entry.summary, entry.content);
				await writeStoredText(join(scope, topic + '.txt'), JSON.stringify({ topic, summary, updatedAt: entry.updatedAt }) + '\n' + content);
				shared.revision++;
			}
			await localState.clearLegacyMemoryScope();
		}),
		index: () => queue(async () => {
			if (!enabled()) return;
			let index = '';
			for (const entry of await list()) {
				const line = JSON.stringify(entry) + '\n';
				if (Buffer.byteLength(index + line) > indexLimit) break;
				index += line;
			}
			return enabled() && index ? index.trimEnd() : undefined;
		}),
		search: (query: string) => queue(async () => {
			if (!enabled()) return [];
			const words = terms(query);
			const entries = (await list()).map((entry) => ({ entry, score: words.filter((word) =>
				`${entry.topic} ${entry.summary}`.toLowerCase().includes(word)).length }));
			return enabled() ? entries.filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map(({ entry }) => entry) : [];
		}),
		read: (topic: string, manage = false) => queue(async () => {
			if (!manage) ensureEnabled();
			topicName(topic);
			const scope = await directory();
			const entry = scope ? await read(scope, topic, true) : undefined;
			if (!manage) ensureEnabled();
			return entry;
		}),
		save: (topic: string, summary: string, content: string, expected?: MemoryEntry | null, manage = false) => queue(async () => {
			if (!manage) ensureEnabled();
			topicName(topic);
			const text = normalizeMemoryText(summary, content);
			const scope = (await directory(true))!;
			const previous = await checkExpected(scope, topic, expected);
			if (!previous && (await topics(scope)).length >= limit) throw new Error('已经保存 100 个主题，请更新或移除现有记忆。');
			const entry = { topic, summary: text.summary, updatedAt: new Date().toISOString() };
			const header = JSON.stringify(entry) + '\n';
			if (Buffer.byteLength(header) > headerLimit) throw new Error('记忆摘要过长。');
			if (!manage) ensureEnabled();
			await writeStoredText(join(scope, topic + '.txt'), header + text.content);
			shared.revision++;
			return entry;
		}),
		remove: (topic: string, expected?: MemoryEntry, manage = false) => queue(async () => {
			if (!manage) ensureEnabled();
			topicName(topic);
			const scope = await directory();
			if (!scope || !await checkExpected(scope, topic, expected)) throw new Error('未找到这个记忆主题。');
			if (!manage) ensureEnabled();
			await unlink(join(scope, topic + '.txt'));
			shared.revision++;
		}),
		async searchHistory(query: string, scope: 'current' | 'vault' = 'current') {
			ensureEnabled();
			if (!conversations || !conversationId) return [];
			const historyAllowed = () => enabled() && (scope === 'current' || localState.vaultHistoryEnabled());
			if (!historyAllowed()) throw new Error('用户尚未在个性化设置中允许搜索此库的其他对话。');
			const words = terms(query);
			const current = [conversationId];
			const ids = scope === 'current' ? current : [...new Set([...current, ...(await conversations.list()).map(({ id }) => id)])].slice(0, 25);
			const found: { conversationId: string; date?: string; source: string; excerpt: string }[] = [];
			for (const id of ids) {
				const { runs } = await conversations.load(id);
				for (const run of [...runs].reverse()) {
					if (!historyAllowed()) throw new Error('聊天记录检索授权已变化。');
					if (run.request.selection || run.request.intent === 'review' || !run.finalized) continue;
					const materials = [{ source: '用户请求', text: run.request.instruction },
						...run.state.messages.filter((m) => m.role === 'assistant' && !m.local && !m.incomplete && !m.toolCalls?.length)
							.map(({ content }) => ({ source: '历史答复', text: content }))];
					for (const { source, text } of materials) {
						const lower = text.toLowerCase();
						const at = words.reduce((first, word) => {
							const next = lower.indexOf(word);
							return next < 0 ? first : Math.min(first, next);
						}, Infinity);
						if (at === Infinity) continue;
						const start = Math.max(0, at - 80);
						const excerpt = text.slice(start, start + 360).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/gu, '');
						const startedAt = new Date(run.state.createdAt ?? NaN);
						const date = Number.isFinite(startedAt.valueOf()) ? startedAt.toISOString().slice(0, 10) : undefined;
						found.push({ conversationId: id, date, source, excerpt });
						if (found.length === 8) return found;
					}
				}
			}
			return found;
		},
		async project(messages: Message[]): Promise<Message[]> {
			const calls = new Map(messages.flatMap((m) => m.role === 'assistant' ? m.toolCalls ?? [] : []).map((call) => [call.id, call]));
			return Promise.all(messages.map(async (message) => {
				if (message.role !== 'tool' || message.isError || !message.toolCallId) return message;
				const { toolName } = message;
				if (toolName !== 'MemoryRead' && toolName !== 'MemorySearch' && toolName !== 'HistorySearch') return message;
				const digest = receiptMarker.exec(message.content)?.[1];
				const call = calls.get(message.toolCallId);
				const input = call?.input as { topic?: unknown; query?: unknown; scope?: unknown } | undefined;
				let value: unknown;
				if (enabled() && digest && call?.name === toolName && input) {
					try {
						if (toolName === 'MemoryRead' && typeof input.topic === 'string') {
							value = await run.read(input.topic) ?? { notice: '这个主题未保存。' };
						} else if (toolName === 'MemorySearch' && typeof input.query === 'string') {
							value = await run.search(input.query);
						} else if (toolName === 'HistorySearch' && typeof input.query === 'string') {
							value = await run.searchHistory(input.query, input.scope === 'vault' ? 'vault' : 'current');
						}
					} catch { /* A stale receipt never authorizes another copy of the material. */ }
				}
				return { ...message, content: enabled() && value !== undefined && contentsDigest(value) === digest
					? JSON.stringify(value) : '此项资料已变化或授权已撤回。需要时按当前权限重新查询。' };
			}));
		},
	};
	return run;
}

export type MemoryRun = ReturnType<typeof createLongTermMemory>;
