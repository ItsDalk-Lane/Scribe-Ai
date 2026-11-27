import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ConversationStore, Message, SavedRun } from '../../types';
import { historicalMessages } from '../context/conversationHistory';
import { createLongTermMemory, memoryReceipt } from '../context/longTermMemory';
import { promptText } from '../context/promptXml';
import { initializeLocalState } from '../storage/localState';
import { scribeDataPaths } from '../storage/paths';

const app = { loadLocalStorage: () => null, saveLocalStorage: () => {} };

void test('长期记忆显式开启，主题正文按需读取，并在重开后保留同库设置与内容', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-memory-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const paths = scribeDataPaths(root);
	await mkdir(paths.root);
	const state = await initializeLocalState(paths.state, app, []);
	const memory = createLongTermMemory(root, state);
	assert.equal(await memory.index(), undefined);
	await assert.rejects(memory.save('editor', '写作偏好', '使用独立短段落。'), /未启用/u);
	await assert.rejects(stat(paths.memory), { code: 'ENOENT' });
	await state.saveMemoryEnabled(true);
	const before = memory.version();
	await Promise.all([
		memory.save('editor', '写作偏好', '使用独立短段落。', null),
		memory.save('sources', '引用偏好', '给出完整笔记路径。', null),
	]);
	assert.ok(memory.version() > before);
	assert.match(await memory.index() ?? '', /写作偏好/u);
	assert.doesNotMatch(await memory.index() ?? '', /使用独立短段落/u);
	assert.deepEqual((await memory.search('请按我的写作偏好调整')).map(({ topic }) => topic), ['editor', 'sources']);
	await assert.rejects(memory.save('../outside', '错误主题', '不得越界', null), /主题/u);
	const reopened = await initializeLocalState(paths.state, app, []);
	const recovered = createLongTermMemory(root, reopened);
	const entry = await recovered.read('editor');
	assert.ok(entry);
	assert.equal(entry.content, '使用独立短段落。');
	const transcript: Message[] = [
		{ role: 'assistant', content: '', toolCalls: [{ id: 'first', name: 'MemoryRead', input: { topic: 'editor' } }] },
		{ role: 'tool', toolName: 'MemoryRead', toolCallId: 'first', content: memoryReceipt('已核对', entry) },
	];
	assert.doesNotMatch(JSON.stringify(transcript), /使用独立短段落/u);
	assert.match((await recovered.project(transcript))[1]?.content ?? '', /使用独立短段落/u);
	const filename = join(paths.memory, reopened.memoryScope, 'editor.txt');
	assert.match(await readFile(filename, 'utf8'), /使用独立短段落/u);
	await recovered.save('editor', '当前偏好', '保留短段落，避免额外小标题。', entry);
	assert.match((await recovered.project(transcript))[1]?.content ?? '', /已变化/u);
	await assert.rejects(recovered.remove('editor', entry), /已变化/u);
	await reopened.saveMemoryEnabled(false);
	assert.equal(await recovered.index(), undefined);
	await assert.rejects(recovered.read('editor'), /未启用/u);
	const latest = await recovered.read('editor', true);
	assert.ok(latest);
	await recovered.remove('editor', latest, true);
	await assert.rejects(stat(filename), { code: 'ENOENT' });

	const copy = scribeDataPaths(join(root, 'copied-vault'));
	await mkdir(copy.root, { recursive: true });
	await copyFile(paths.state, copy.state);
	const other = await initializeLocalState(copy.state, app, []);
	assert.equal(other.memoryEnabled(), false);
	assert.notEqual(other.memoryScope, reopened.memoryScope);
});

void test('history omits saved memory proposals while retaining results of unrelated calls from the same batch', () => {
	const messages: Message[] = [
		{ role: 'assistant', content: '已核对资料。', toolCalls: [
			{ id: 'same', name: 'MemorySave', input: { topic: 'preference', summary: '偏好', content: '记忆专用正文' } },
			{ id: 'read', name: 'Read', input: { file_path: 'evidence.md' } },
		] },
		{ role: 'tool', toolName: 'MemorySave', toolCallId: 'same', content: '已保存主题：preference' },
		{ role: 'tool', toolName: 'Read', toolCallId: 'read', content: '可独立使用的证据' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'same', name: 'Read', input: { file_path: 'later.md' } }] },
		{ role: 'tool', toolName: 'Read', toolCallId: 'same', content: '后续另一批结果' },
	];
	const replay = historicalMessages(messages);
	assert.equal(replay.length, messages.length);
	assert.doesNotMatch(JSON.stringify(replay), /记忆专用正文|已保存主题/u);
	assert.match(replay.map(promptText).join('\n'), /已核对资料[\s\S]*可独立使用的证据/u);
	assert.deepEqual(replay.slice(-2), messages.slice(-2));
	assert.match(JSON.stringify(messages), /记忆专用正文/u);
});

void test('对话检索默认仅本会话，扩大范围须经过设置，返回短摘录', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-history-search-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const paths = scribeDataPaths(root);
	await mkdir(paths.root);
	const state = await initializeLocalState(paths.state, app, []);
	await state.saveMemoryEnabled(true);
	const makeRun = (id: string, instruction: string): SavedRun => ({
		request: { conversationId: id, instruction, refs: [] },
		model: { providerId: 'test', model: 'test' }, finalized: true,
		state: { taskId: id, status: 'done', turn: 1, pendingCalls: [], createdAt: Date.UTC(2026, 4, 1),
			messages: [{ role: 'tool', content: '关键字 工具结果不得回传', toolCallId: 'read' }] },
	});
	const runs = {
		current: [makeRun('current', '关键字 第一段历史。' + '额'.repeat(900))],
		other: [makeRun('other', '关键字 另一段历史。')],
	};
	const conversations: Pick<ConversationStore, 'list' | 'load'> = {
		list: async () => [{ id: 'other', title: '另一个聊天', updatedAt: 1 }],
		load: async (id) => ({ id, runs: runs[id as keyof typeof runs] ?? [] }),
	};
	const memory = createLongTermMemory(root, state, conversations, 'current');
	const matches = await memory.searchHistory('关键字');
	assert.deepEqual(matches.map(({ conversationId, date }) => [conversationId, date]), [['current', '2026-05-01']]);
	assert.ok(matches[0]!.excerpt.length <= 360);
	await assert.rejects(memory.searchHistory('关键字', 'vault'), /尚未/u);
	await state.saveVaultHistoryEnabled(true);
	assert.deepEqual((await memory.searchHistory('关键字', 'vault')).map(({ conversationId }) => conversationId), ['current', 'other']);
	await state.saveVaultHistoryEnabled(false);
	await assert.rejects(memory.searchHistory('关键字', 'vault'), /尚未/u);
});
