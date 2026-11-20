import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ConversationEntry, Message, QueuedMessage } from '../../types';
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

function queued(conversationId: string, id: string, instruction: string): QueuedMessage {
	return { id, request: { conversationId, instruction, refs: [] } };
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

void test('renaming keeps the original transcript and ordering, and deletion removes only the selected chat', async (t) => {
	const { directory, store } = await fixture(t);
	await store.append('first', [start('first', 'one', '原始任务')]);
	await store.append('second', [start('second', 'two', '另一个会话')]);
	await store.setLastOpened('second');
	const before = await store.list();
	const log = await readFile(join(directory, 'first.jsonl'), 'utf8');
	await assert.rejects(store.rename('first', '   '), /对话名称/);
	await assert.rejects(store.rename('first', '字'.repeat(121)), /对话名称/);
	await store.rename('first', '  笔记整理 计划  一  ');
	const reopened = createConversationStore(directory);
	assert.deepEqual(await reopened.list(), before.map((item) => item.id === 'first'
		? { ...item, title: '笔记整理 计划  一' } : item));
	assert.equal(await readFile(join(directory, 'first.jsonl'), 'utf8'), log);
	assert.equal((await reopened.load('first')).runs[0]?.request.instruction, '原始任务');

	const deleting = reopened.delete('first');
	const lateWrite = assert.rejects(store.append('first', [start('first', 'late', '不能恢复')]), /已删除/);
	await Promise.all([deleting, lateWrite]);
	assert.equal(await reopened.lastOpened(), 'second');
	assert.deepEqual((await reopened.list()).map(({ id }) => id), ['second']);
	assert.deepEqual((await readdir(directory)).sort(), ['last-opened', 'second.jsonl']);
	await reopened.delete('second');
	assert.equal(await reopened.lastOpened(), undefined);
	assert.deepEqual(await readdir(directory), []);
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
	await assert.rejects(store.rename('../escape', '随便一个名称'), /编号无效/);
	await assert.rejects(store.delete('../escape'), /编号无效/);
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

void test('queued messages keep their original content and order until a durable start or insert consumes them', async (t) => {
	const { directory, store } = await fixture(t);
	const first = queued('primary', 'queued-a', '第一条\n  保留空白 🌱');
	const second = queued('primary', 'queued-b', '带资料的第二条');
	second.request.refs = [{ path: 'image.png' }, { path: 'note.md' }, { path: 'other.png' }];
	const other = queued('other', 'queued-a', '其他对话');
	await Promise.all([store.enqueue('primary', first), store.enqueue('primary', second), store.enqueue('other', other)]);

	const reopened = createConversationStore(directory);
	assert.deepEqual((await reopened.load('primary')).queue, [first, second]);
	assert.deepEqual(await reopened.getQueued('other'), [other]);
	assert.equal((await reopened.list()).find(({ id }) => id === 'primary')?.title, '第一条 保留空白 🌱');
	await assert.rejects(reopened.editQueued('primary', second.id, '不能修改文件'), /非文本/);
	await assert.rejects(reopened.editQueued('primary', first.id, '  '), /输入任务/);
	await assert.rejects(reopened.append('primary', [start('primary', 'task-b', '带资料的第二条')],
		{ messages: [second], fifo: true }), /顺序/);

	const edit = reopened.editQueued('primary', first.id, '修改后的消息\n下一行');
	const staleStart = assert.rejects(reopened.append('primary', [start('primary', 'stale', first.request.instruction)],
		{ messages: [first], fifo: true }), /已经变更/);
	await Promise.all([edit, staleStart]);
	assert.deepEqual((await reopened.load('primary')).runs, []);
	const edited = (await reopened.getQueued('primary'))[0]!;
	assert.equal(edited.request.instruction, '修改后的消息\n下一行');

	const log = join(directory, 'primary.jsonl');
	await appendFile(log, '{"type":"start","consumedQueueIds":["queued-a"]');
	assert.deepEqual(await reopened.getQueued('primary'), [edited, second]);

	await reopened.append('primary', [start('primary', 'task-a', edited.request.instruction)],
		{ messages: [edited], fifo: true });
	assert.deepEqual(await reopened.getQueued('primary'), [second]);
	await assert.rejects(reopened.deleteQueued('primary', edited.id), /找不到/);
	const previous: Message = { id: 'assistant:task-a:1', role: 'assistant', content: '前一轮留下的思考', incomplete: true };
	const draft: Message = { id: 'assistant:task-a:2:retry:1', role: 'assistant', content: '', incomplete: true };
	const reply: Message = { id: draft.id, role: 'assistant', content: '插话后的回复' };
	await reopened.append('primary', [
		messages('task-a', previous),
		{ type: 'step', taskId: 'task-a', step: { phase: 'model', turn: 2 } },
		messages('task-a', draft),
	]);
	await assert.rejects(reopened.append('primary', [messages('task-a', { role: 'user', content: '未转交的正文' })],
		{ messages: [second] }), /记录与排队消息不匹配/);
	const steering: Message = { id: 'steer:queued-b', role: 'user', content: second.request.instruction };
	await reopened.append('primary', [messages('task-a', steering)], { messages: [second] });
	await reopened.append('primary', [messages('task-a', reply)]);
	const snapshot = await createConversationStore(directory).load('primary');
	assert.equal(snapshot.queue, undefined);
	assert.deepEqual(snapshot.runs[0]?.state.messages, [previous, steering, reply]);
	const branch = await reopened.fork('primary', 'task-a');
	assert.deepEqual((await reopened.load(branch.id)).runs[0]?.state.messages, [previous, steering, reply]);
	assert.deepEqual(await reopened.getQueued('other'), [other]);
	await reopened.deleteQueued('other', other.id);
	assert.deepEqual(await createConversationStore(directory).getQueued('other'), []);
	assert.equal((await reopened.list()).some(({ id }) => id === 'other'), false);
});

void test('forking, editing history and deleting preserve isolation of pending messages', async (t) => {
	const { store } = await fixture(t);
	const first = queued('parent', 'used', '原来的消息');
	const pending = queued('parent', 'pending', '仍在排队');
	await store.enqueue('parent', first);
	await store.append('parent', [start('parent', 'original', first.request.instruction)], { messages: [first], fifo: true });
	await store.enqueue('parent', pending);

	const branch = await store.fork('parent', 'original');
	assert.equal(branch.runs[0]?.request.conversationId, branch.id);
	assert.deepEqual(await store.getQueued(branch.id), []);
	await store.replaceFrom('parent', 'original', [start('parent', 'edited', '改写历史')]);
	assert.deepEqual(await store.getQueued('parent'), [pending]);
	assert.equal((await store.load('parent')).runs[0]?.request.instruction, '改写历史');

	const deletion = store.delete('parent');
	const lateEnqueue = assert.rejects(store.enqueue('parent', pending), /已删除/);
	await Promise.all([deletion, lateEnqueue]);
	assert.deepEqual(await store.getQueued('parent'), []);
	assert.equal((await store.load(branch.id)).runs.length, 1);
});
