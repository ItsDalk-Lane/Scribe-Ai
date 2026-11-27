import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextBuilder } from '../../orchestration/context/contextBuilder';
import { createRunContext } from '../../orchestration/runContext';
import type { RunChatTasks, Task, ToolContext } from '../../types';
import { chatTaskTools } from '../chatTaskTools';
import { createToolExecutor } from '../executor';
import { createToolRegistry } from '..';

function fixture() {
	const registry = createToolRegistry([chatTaskTools]);
	const executor = createToolExecutor(registry);
	const history: unknown[] = [];
	const task = { id: '8', subject: '核对引用', description: '核对每个引用的出处', status: 'pending' as const, blockedBy: [], blocks: [] };
	const chatTasks: RunChatTasks = {
		list: async () => [{ id: 1, tasks: [{ ...task, id: '3' }] }, { id: 2, tasks: [task] }],
		get: async (id) => ({ ...task, id }),
		create: async (input) => { history.push(input); return task; },
		update: async (input) => { history.push(input); return task; },
	};
	const create = async (intent?: 'plan' | 'review', side = false, enabled = true) => {
		const task: Task = { id: 'run', request: { conversationId: 'chat', instruction: '核对引用', refs: [], intent },
			status: 'running', createdAt: 0, updatedAt: 0 };
		const run = await createRunContext(task, { cwd: process.cwd(), signal: new AbortController().signal,
			model: { providerId: 'p', model: 'm' }, observer: {} }, 'vault-config', () => enabled, side);
		return { ...run, chatTasks };
	};
	const execute = (ctx: Awaited<ReturnType<typeof create>>, name: string, input: unknown) =>
		executor.execute({ id: 'call', name, input }, { ...ctx, app: {} as ToolContext['app'], approve: () => assert.fail('不应发起审批') });
	return { create, execute, builder: createContextBuilder(registry), history };
}

void test('chat checklist tools expose the latest batch, use the bound chat, and validate fields before mutation', async () => {
	const { create, execute, builder, history } = fixture();
	const run = await create();
	const request = await builder.build(run, [], 100_000);
	assert.deepEqual(request.tools.map(({ name }) => name).sort(), ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']);
	assert.match(request.system ?? '', /简单问答/u);
	const list = JSON.parse((await execute(run, 'TaskList', {})).content) as { batch: number; tasks: { id: string; description?: string }[] };
	assert.equal(list.batch, 2);
	assert.deepEqual(list.tasks.map(({ id }) => id), ['8']);
	assert.ok(!list.tasks[0]!.description);
	assert.match((await execute(run, 'TaskGet', { taskId: '8' })).content, /核对每个引用/u);
	const item = { subject: '核对引用', description: '逐条核对', blockedBy: ['3'] };
	assert.equal((await execute(run, 'TaskCreate', { ...item, i: '整理步骤' })).isError, false);
	assert.equal((await execute(run, 'TaskUpdate', { taskId: '8', status: 'in_progress' })).isError, false);
	assert.equal((await execute(run, 'TaskUpdate', { taskId: '8', status: 'completed' })).isError, false);
	assert.equal((await execute(run, 'TaskUpdate', { taskId: '8', status: 'deleted' })).content, '{"id":"8","deleted":true}');
	for (const input of [{ taskId: '8' }, { taskId: '8', status: 'stopped' }, { taskId: '8', status: 'deleted', subject: '冲突' },
		{ taskId: '8', addBlocks: [8] }, { taskId: '8', owner: 'another' }, { taskId: '8', description: '  ' }]) {
		assert.equal((await execute(run, 'TaskUpdate', input)).isError, true);
	}
	assert.equal((await execute(run, 'TaskCreate', { ...item, conversationId: 'elsewhere' })).isError, true);
	assert.equal((await execute(run, 'TaskGet', { taskId: 8 })).isError, true);
	assert.equal(history.length, 4);
});

void test('plan uses the same checklist definitions while enforcing drafting-only access and side chat, review and disabled tools cannot access the checklist', async () => {
	const { create, execute, builder, history } = fixture();
	const plan = await create('plan');
	const planned = await builder.build(plan, [], 100_000);
	const regular = await builder.build(await create(), [], 100_000);
	assert.deepEqual(planned.tools, regular.tools);
	for (const status of ['in_progress', 'completed']) {
		assert.equal((await execute(plan, 'TaskUpdate', { taskId: '8', status })).isError, true);
	}
	assert.equal((await execute(plan, 'TaskCreate', { subject: '写草案', description: '确定验收条件' })).isError, false);
	assert.equal((await execute(plan, 'TaskUpdate', { taskId: '8', addBlockedBy: ['3'] })).isError, false);
	for (const run of [await create('review'), await create(undefined, true), await create(undefined, false, false)]) {
		assert.deepEqual((await builder.build(run, [], 100_000)).tools, []);
		assert.equal((await execute(run, 'TaskList', {})).isError, true);
		assert.equal((await execute(run, 'TaskUpdate', { taskId: '8', status: 'completed' })).isError, true);
	}
	assert.equal(history.length, 2);
	assert.deepEqual((await builder.build({ ...plan, chatTasks: undefined }, [], 100_000)).tools, []);
});
