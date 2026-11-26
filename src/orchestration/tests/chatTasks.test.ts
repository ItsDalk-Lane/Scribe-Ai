import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ConversationEntry, TaskRequest } from '../../types';
import { createConversationStore } from '../storage/conversationStore';

const main = { owner: 'root', runId: 'run' };
const worker = { owner: 'worker', runId: 'worker-run' };
const task = { subject: '核对来源', description: '检查引文' };
function start(id: string, request: Partial<TaskRequest> = {}): Extract<ConversationEntry, { type: 'start' }> {
	return { type: 'start', task: { id, status: 'pending', createdAt: 1, updatedAt: 1,
		request: { conversationId: 'chat', instruction: '整理资料', refs: [], ...request } }, model: { providerId: 'p', model: 'm' } };
}
async function sample(t: TestContext, request: Partial<TaskRequest> = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'scribe-tasks-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const store = createConversationStore(dir);
	const first = start('run', request);
	await store.append('chat', [first]);
	return { dir, store, first, list: store.chatTasks };
}

void test('并行 Agent 共享唯一编号和认领，依赖与停止在各个窗口一致', async (t) => {
	const { dir, store, first, list } = await sample(t);
	await store.append('chat', [
		{ type: 'subagent', agentId: worker.owner, record: { kind: 'create', agent: { id: worker.owner, name: '审阅', role: 'default', rootTaskId: main.runId, model: first.model } } },
		{ type: 'subagent', agentId: worker.owner, record: { kind: 'run', entry: start(worker.runId) } },
	]);
	let changes = 0;
	const other = createConversationStore(dir).chatTasks;
	const off = other.subscribe('chat', () => { changes++; });
	t.after(off);
	const [a, b] = await Promise.all([list.create('chat', main, task), other.create('chat', worker, task)]);
	assert.deepEqual([a.id, b.id], ['1', '2']);
	await list.update('chat', main, { id: b.id, addBlockedBy: [a.id] });
	assert.deepEqual((await other.get('chat', a.id)).blocks, [b.id]);
	await assert.rejects(other.update('chat', worker, { id: b.id, status: 'in_progress' }), /依赖/);
	await assert.rejects(other.update('chat', worker, { id: a.id, addBlockedBy: [b.id] }), /循环/);
	const raced = await Promise.allSettled([list.update('chat', main, { id: a.id, status: 'in_progress' }),
		other.update('chat', worker, { id: a.id, status: 'in_progress' })]);
	assert.deepEqual(raced.map((x) => x.status), ['fulfilled', 'rejected']);
	const independent = await other.create('chat', worker, task);
	await assert.rejects(list.update('chat', main, { id: independent.id, status: 'in_progress' }), /已有进行中/);
	await other.update('chat', worker, { id: independent.id, status: 'in_progress' });
	await other.update('chat', worker, { id: independent.id, status: 'completed' });
	await list.release('chat', worker.runId);
	assert.equal((await other.get('chat', a.id)).owner, main.owner);
	await list.release('chat', main.runId);
	assert.deepEqual((await other.list('chat'))[0]?.tasks.map(({ status }) => status), ['stopped', 'pending', 'completed']);
	await other.update('chat', worker, { id: a.id, status: 'in_progress' });
	await other.update('chat', worker, { id: a.id, status: 'completed' });
	await list.update('chat', main, { id: b.id, status: 'in_progress' });
	await list.update('chat', main, { id: b.id, status: 'completed' });
	await list.release('chat', main.runId);
	const c = await other.create('chat', worker, task);
	assert.equal(c.id, '4');
	assert.deepEqual((await list.list('chat')).map((batch) => batch.id), [1, 2]);
	await other.update('chat', worker, { id: c.id, status: 'deleted' });
	assert.deepEqual((await list.list('chat')).at(-1), { id: 2, tasks: [] });
	assert.equal((await list.create('chat', main, task)).id, '5');
	assert.ok(changes >= 10);
	assert.deepEqual(await list.list('other'), []);
	await assert.rejects(list.create('other', main, task), /无权/);
});

void test('停止和删除保留依赖一致性，分支、重开和改写遵从保存时的清单进度', async (t) => {
	const { dir, store, list } = await sample(t);
	const first = await list.create('chat', main, task);
	const next = await list.create('chat', main, { ...task, blockedBy: [first.id] });
	await list.update('chat', main, { id: first.id, status: 'in_progress' });
	const fork = await store.fork('chat', 'run');
	assert.equal((await list.get(fork.id, first.id)).status, 'stopped');
	assert.equal((await list.get('chat', first.id)).status, 'in_progress');
	await list.release('chat', main.runId);
	await store.append('chat', [start('followup')]);
	await list.update('chat', { owner: 'root', runId: 'followup' }, { id: first.id, status: 'deleted' });
	assert.deepEqual((await list.get('chat', next.id)).blockedBy, []);
	await store.replaceFrom('chat', 'followup', [start('replacement')]);
	assert.deepEqual((await createConversationStore(dir).chatTasks.list('chat'))[0]?.tasks.map(({ status }) => status), ['stopped', 'pending']);
	await store.delete('chat');
	assert.deepEqual(await list.list('chat'), []);
	assert.equal((await list.get(fork.id, first.id)).status, 'stopped');
});

void test('异常退出时未释放的认领在下一次插件启动显示停止并可再次认领', async (t) => {
	const { dir, list, store } = await sample(t);
	const item = await list.create('chat', main, task);
	await list.update('chat', main, { id: item.id, status: 'in_progress' });
	const path = join(dir, 'chat.jsonl');
	const body = await readFile(path, 'utf8');
	await writeFile(path, body.replace(/"writer":"[^"]+"/gu, '"writer":"former-instance/chat"'));
	const reopened = createConversationStore(dir).chatTasks;
	assert.equal((await reopened.get('chat', item.id)).status, 'stopped');
	assert.equal((await reopened.get('chat', item.id)).owner, undefined);
	await store.append('chat', [{ type: 'step', taskId: main.runId, step: { phase: 'model', turn: 2 } }]);
	assert.equal((await reopened.get('chat', item.id)).status, 'stopped');
	assert.equal((await reopened.update('chat', main, { id: item.id, status: 'in_progress' })).owner, 'root');
});

void test('仅批准所选计划及连续修订，重写执行消息时草案恢复待批', async (t) => {
	const { store, list } = await sample(t, { intent: 'plan' });
	const orphan = await list.create('chat', { ...main, planRunId: main.runId }, task);
	await store.append('chat', [start('new', { intent: 'plan' })]);
	const newPlan = { owner: 'root', runId: 'new', planRunId: 'new' };
	const item = await list.create('chat', newPlan, task);
	assert.deepEqual((await list.list('chat')).map(({ tasks }) => tasks.map(({ id }) => id)), [[orphan.id], [item.id]]);
	await assert.rejects(list.update('chat', newPlan, { id: orphan.id, status: 'deleted' }), /草案/);
	await assert.rejects(list.update('chat', newPlan, { id: item.id, status: 'in_progress' }), /确认/);
	await store.append('chat', [start('revise', { intent: 'plan', revisesPlanTaskId: 'new' })]);
	await list.update('chat', { owner: 'root', runId: 'revise', planRunId: 'revise' }, { id: item.id, subject: '更新核对范围' });
	await assert.rejects(list.approvePlan('chat', 'new'), /确认/);
	await store.append('chat', [start('execute', { approvedPlanTaskId: 'revise' })]);
	const executor = { owner: 'root', runId: 'execute' };
	await assert.rejects(list.update('chat', executor, { id: item.id, status: 'in_progress' }), /确认/);
	await list.approvePlan('chat', 'revise');
	assert.equal((await list.update('chat', executor, { id: item.id, status: 'in_progress' })).status, 'in_progress');
	assert.equal((await list.get('chat', orphan.id)).planRunId, main.runId);
	await store.replaceFrom('chat', 'execute', [start('other')]);
	assert.equal((await list.get('chat', item.id)).planRunId, 'new');
	await assert.rejects(list.update('chat', { owner: 'worker', runId: 'other' }, { id: item.id, subject: '篡改' }), /无权/);
});

void test('只读子助手可查清单；伪造负责人、跨会话记录和已结束任务不能修改清单', async (t) => {
	const { first, store, list } = await sample(t);
	const item = await list.create('chat', main, task);
	await store.append('chat', [
		{ type: 'subagent', agentId: worker.owner, record: { kind: 'create', readOnly: true,
			agent: { id: worker.owner, name: '只读', role: 'explorer', rootTaskId: main.runId, model: first.model } } },
		{ type: 'subagent', agentId: worker.owner, record: { kind: 'run', entry: start(worker.runId) } },
		{ type: 'finish', taskId: main.runId, status: 'done', turn: 1 },
	]);
	assert.equal((await list.get('chat', item.id)).subject, task.subject);
	for (const actor of [main, worker, { ...worker, owner: main.owner }]) {
		await assert.rejects(list.update('chat', actor, { id: item.id, status: 'in_progress' }), /无权/);
	}
	await assert.rejects(list.create('different-chat', worker, task), /无权/);
});
