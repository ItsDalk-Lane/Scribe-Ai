import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ConversationEntry, Message } from '../../types';
import { createConversationStore } from '../storage/conversationStore';

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), 'scribe-conversation-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	return { directory, store: createConversationStore(directory) };
}

function start(conversationId: string, id: string, instruction: string): ConversationEntry {
	return {
		type: 'start',
		task: {
			id, request: { conversationId, instruction, refs: [{ path: 'note.md' }] },
			status: 'pending', createdAt: 1, updatedAt: 1,
		},
		model: { providerId: 'test-provider', model: 'test-model' },
	};
}

function messages(taskId: string, ...items: Message[]): ConversationEntry {
	return { type: 'messages', taskId, messages: items };
}

void test('saved conversations can be listed, reopened and appended independently', async (t) => {
	const { directory, store } = await fixture(t);
	assert.equal(await store.lastOpened(), undefined);
	assert.deepEqual(await store.list(), []);
	await store.append('first', [start('first', 'one', '整理\n 笔记')]);
	await Promise.all([
		store.append('first', [messages('one', { role: 'user', content: '整理笔记' })]),
		store.append('first', [messages('one', { role: 'assistant', content: '已整理' })]),
		store.append('first', [{ type: 'finish', taskId: 'one', status: 'done', turn: 1 }]),
	]);
	await store.append('second', [start('second', 'two', '另一个会话')]);
	await Promise.all([store.setLastOpened('second'), store.setLastOpened('first')]);

	const reopened = createConversationStore(directory);
	assert.equal(await reopened.lastOpened(), 'first');
	assert.deepEqual(new Map((await reopened.list()).map((chat) => [chat.id, chat.title])),
		new Map([['second', '另一个会话'], ['first', '整理 笔记']]));
	const [run] = (await reopened.load('first')).runs;
	assert.ok(run);
	assert.equal(run.state.status, 'done');
	assert.deepEqual(run.state.messages.map((message) => message.content), ['整理笔记', '已整理']);
	assert.equal(run.model.model, 'test-model');
	await reopened.append('first', [start('first', 'three', '用原来的内容继续')]);
	assert.equal((await store.load('first')).runs.length, 2);
	assert.equal((await store.load('second')).runs.length, 1);
});

void test('a torn tail cannot hide a completed result or revive a pending approval', async (t) => {
	const { directory, store } = await fixture(t);
	const readCall = { id: 'read1', name: 'Read', input: { file_path: 'note.md' } };
	const editCall = { id: 'edit1', name: 'Edit', input: { file_path: 'note.md' } };
	await store.append('journal', [
		start('journal', 'task', 'Find and edit'),
		messages('task', { role: 'user', content: 'Find and edit' }),
		{ type: 'step', taskId: 'task', step: { phase: 'model', turn: 1 } },
		messages('task', { role: 'assistant', content: '', toolCalls: [readCall, editCall] }),
		messages('task', { role: 'tool', content: '旧内容', toolCallId: readCall.id, toolName: readCall.name }),
		{ type: 'step', taskId: 'task', step: { phase: 'approval', turn: 1, call: editCall } },
	]);
	const file = join(directory, 'journal.jsonl');
	await appendFile(file, '{"type":"finish","status":"done","partial":"未写完');
	const reopened = createConversationStore(directory);
	const [interrupted] = (await reopened.load('journal')).runs;
	assert.ok(interrupted);
	assert.equal(interrupted.step?.phase, 'approval');
	assert.equal(interrupted.state.status, 'interrupted');
	assert.equal(interrupted.state.turn, 1);
	assert.equal(interrupted.state.messages.at(-1)?.content, '旧内容');
	assert.deepEqual(interrupted.state.pendingCalls, [editCall]);

	await reopened.append('journal', [start('journal', 'follow-up', '继续聊天')]);
	assert.doesNotMatch(await readFile(file, 'utf8'), /未写完/);
	const restored = (await reopened.load('journal')).runs;
	assert.deepEqual(restored.map((run) => run.state.taskId), ['task', 'follow-up']);
	assert.equal(restored[0]?.state.status, 'interrupted');
});

void test('committed malformed records and unsafe conversation IDs are rejected', async (t) => {
	const { directory, store } = await fixture(t);
	await assert.rejects(store.load('../escape'), /编号无效/);
	await assert.rejects(store.setLastOpened('../escape'), /编号无效/);
	await store.append('bad-log', [start('bad-log', 'task', 'Check history')]);
	await appendFile(join(directory, 'bad-log.jsonl'), 'invalid record\n');
	await store.append('bad-log', [{ type: 'finish', taskId: 'task', status: 'done', turn: 1 }]);
	await assert.rejects(store.load('bad-log'), /第 2 行/);
});

void test('a committed result advances a tool checkpoint even when the next record was torn', async (t) => {
	const { directory, store } = await fixture(t);
	const call = { id: 'edit', name: 'Edit', input: { file_path: 'note.md' } };
	await store.append('progress', [
		start('progress', 'task', 'Make a change'),
		messages('task', { role: 'assistant', content: '', toolCalls: [call] }),
		{ type: 'step', taskId: 'task', step: { phase: 'tool', turn: 1, call } },
		{
			type: 'messages', taskId: 'task',
			messages: [{ role: 'tool', content: '修改已完成。', toolCallId: call.id, toolName: call.name }],
			step: { phase: 'tool-result', turn: 1, call },
		},
	]);
	await appendFile(join(directory, 'progress.jsonl'), '{"type":"step","taskId"');
	const [run] = (await store.load('progress')).runs;
	assert.ok(run);
	assert.equal(run.state.status, 'interrupted');
	assert.equal(run.step?.phase, 'tool-result');
	assert.deepEqual(run.state.pendingCalls, []);
});
