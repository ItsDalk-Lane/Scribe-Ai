import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConversationLogStore } from '../storage/conversationLog';
import { diagnostics, logScope } from '../../communication/diagnostics';
import type { CommunicationLogEntry } from '../../types';

const DAY = 24 * 60 * 60 * 1000;
const entry = (at: number, error?: string): CommunicationLogEntry => ({ requestId: 'r', phase: 'done', at, ...(error && { error }) });

void test('diagnostic logs are appended per conversation and read back as JSON lines', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-logs-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, 'logs');
	const store = createConversationLogStore(directory);
	store.append('ABC-123', entry(1, 'first'));
	store.append('abc-123', entry(2, 'second'));
	store.append('../escape', entry(3, 'no owner'));
	assert.deepEqual((await readdir(directory)).sort(), ['abc-123.jsonl', 'global.jsonl']);
	const lines = (await readFile(join(directory, 'abc-123.jsonl'), 'utf8')).trim().split('\n')
		.map((line) => JSON.parse(line) as CommunicationLogEntry);
	assert.deepEqual(lines.map((line) => line.error), ['first', 'second']);
});

void test('files with no new entries inside the retention window are swept; 0 keeps them', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-logs-sweep-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, 'logs');
	await mkdir(directory);
	const store = createConversationLogStore(directory);
	store.append('old-chat', entry(1));
	const old = new Date(Date.now() - 40 * DAY);
	await utimes(join(directory, 'old-chat.jsonl'), old, old);
	store.append('new-chat', entry(2));

	store.sweep(30);
	assert.deepEqual((await readdir(directory)).sort(), ['new-chat.jsonl']);

	await utimes(join(directory, 'new-chat.jsonl'), old, old);
	store.sweep(0);
	assert.deepEqual((await readdir(directory)).sort(), ['new-chat.jsonl']);
});

void test('connection records land in the log file of the conversation that issued them', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-logs-scope-'));
	t.after(() => { diagnostics.useSink(undefined); return rm(root, { recursive: true, force: true }); });
	const directory = join(root, 'logs');
	const store = createConversationLogStore(directory);
	diagnostics.useSink((scope, logged) => store.append(scope, logged));
	const shallow = await logScope.run('chat-one', () => {
		diagnostics.record(entry(1, 'inside'));
		// 在任务内部再发起的异步工作仍然属于这段对话。
		return Promise.resolve().then(() => diagnostics.record(entry(2, 'nested')));
	});
	assert.equal(shallow, undefined);
	diagnostics.record(entry(3, 'outside'));
	const lines = (await readFile(join(directory, 'chat-one.jsonl'), 'utf8')).trim().split('\n')
		.map((line) => (JSON.parse(line) as CommunicationLogEntry).error);
	assert.deepEqual(lines, ['inside', 'nested']);
	const global = (await readFile(join(directory, 'global.jsonl'), 'utf8')).trim().split('\n')
		.map((line) => (JSON.parse(line) as CommunicationLogEntry).error);
	assert.deepEqual(global, ['outside']);
});

void test('clearing removes only log files, and deleting a conversation drops its log', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-logs-clear-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, 'logs');
	await mkdir(directory);
	await writeFile(join(directory, 'unrelated.txt'), 'keep me');
	const store = createConversationLogStore(directory);
	store.append('chat-a', entry(1));
	store.append('chat-b', entry(2));
	store.remove('chat-a');
	store.append('CHAT-A', entry(3, 'late cancelled request'));
	assert.deepEqual((await readdir(directory)).sort(), ['chat-b.jsonl', 'unrelated.txt']);
	assert.ok(store.size() > 0);
	store.clear();
	assert.deepEqual((await readdir(directory)).sort(), ['unrelated.txt']);
	assert.equal(store.size(), 0);
});

void test('日志目录拒绝链接；追加、统计和清除不会改动链接目标', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-logs-identity-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const logs = join(root, 'logs');
	const elsewhere = join(root, 'other');
	await mkdir(elsewhere);
	const original = join(elsewhere, 'chat.jsonl');
	await writeFile(original, 'existing\n');
	await symlink(elsewhere, logs, 'dir');
	const store = createConversationLogStore(logs);
	store.append('chat', entry(1));
	assert.equal(store.size(), 0);
	assert.throws(() => store.clear());
	assert.equal(await readFile(original, 'utf8'), 'existing\n');
	await rm(logs);
	await mkdir(logs);
	await link(original, join(logs, 'chat.jsonl'));
	store.append('chat', entry(2));
	assert.throws(() => store.clear());
	assert.equal(await readFile(original, 'utf8'), 'existing\n');
});
