import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createContextBuilder } from '../../orchestration/context/contextBuilder';
import { createRunContext } from '../../orchestration/runContext';
import { createReadDelivery } from '../../runtime/readDelivery';
import type { Task, ToolContext } from '../../types';
import { createToolLayer } from '..';
import { obsidianSearchToolName } from '../workspaceTools';

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-workspace-search-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, 'vault');
	const configDir = 'vault-configuration';
	await Promise.all(['Plan', 'Plan2', configDir, '.scribe-ai'].map((dir) => mkdir(join(cwd, dir), { recursive: true })));
	const files = ['Plan/A.md', 'Plan/B.md', 'Plan2/C.md', configDir + '/config.md', '.scribe-ai/history.md'];
	await Promise.all(files.map((path) => writeFile(join(cwd, path), 'notes')));
	await writeFile(join(root, 'external.md'), 'external');
	if (process.platform !== 'win32') {
		await symlink(join(root, 'external.md'), join(cwd, 'Plan', 'Link.md'));
		files.push('Plan/Link.md');
	}
	const observed: Record<string, unknown>[] = [];
	const handler = t.mock.fn(async (options: Record<string, unknown>) => {
		observed.push(options);
		return options.query === '[missing]' ? 'No matches found.' : JSON.stringify([...files, '../external.md']);
	});
	const handlers = new Map([['search', { handler }]]);
	const app = { vault: { configDir }, cli: { handlers } } as unknown as ToolContext['app'];
	const layer = createToolLayer(undefined, undefined, undefined, undefined, app);
	const task: Task = {
		id: 'test', request: { conversationId: 'test', instruction: '帮我搜索笔记', refs: [{ path: 'Plan/B.md', lines: [1, 1] }] },
		status: 'running', createdAt: 0, updatedAt: 0,
	};
	const signal = new AbortController().signal;
	const createRun = (intent?: 'plan' | 'review', sideChat = false, enabled = true) =>
		createRunContext({ ...task, request: { ...task.request, intent } },
			{ cwd, signal, model: { providerId: 'test', model: 'test' }, observer: {} }, app.vault.configDir,
			() => enabled, sideChat, 'ask');
	const execute = async (input: unknown, run = createRun()) => layer.executor.execute({ id: 'search', name: obsidianSearchToolName, input },
		{ app, cwd, signal, task, readFiles: new Map(), readDelivery: createReadDelivery(), permissions: (await run).permissions });
	return { createRun, execute, handlers, layer, observed };
}

void test('ordinary chat passes combined native queries through in the active vault and returns only permitted Markdown paths', async (t) => {
	const { createRun, execute, layer, observed } = await fixture(t);
	const request = await createContextBuilder(layer.registry).build(await createRun(), [], 100_000);
	assert.ok(request.tools.some(({ name }) => name === obsidianSearchToolName));
	assert.match(request.system ?? '', /用户用自然语言.*使用 ObsidianSearch/u);

	for (const query of [
		'tag:#AI', '[/^scribe$/]', '[/./:/^acsd$/]',
		'(tag:#AI OR tag:#研究) [duration:>5] -[status:archived] section:(视频 解析)',
		'path:"Plan/" file:"A" (block:(AI 摘要) OR task-todo:审核)',
	]) {
		const result = await execute({ query, path: 'Plan/', i: '根据需求找笔记' });
		assert.equal(result.isError, false);
		assert.deepEqual(JSON.parse(result.content), { query, folder: 'Plan', total: 1, paths: ['Plan/A.md'] });
	}
	assert.equal(observed.length, 5);
	assert.deepEqual(observed[3], {
		query: '(tag:#AI OR tag:#研究) [duration:>5] -[status:archived] section:(视频 解析)', path: 'Plan', format: 'json',
	});
	for (const query of ['file:notes', 'content:"tag:#AI [scribe]"', '/tag:#AI/', 'file:notes "[scribe]"']) {
		assert.equal((await execute({ query })).isError, true);
	}
	assert.equal((await execute({ query: '[scribe]', path: '../' })).isError, true);
	assert.equal(observed.length, 5);
	assert.deepEqual(JSON.parse((await execute({ query: '[missing]' })).content), { query: '[missing]', total: 0, paths: [] });
});

void test('native search follows read-only chat eligibility and disappears when the core engine is unavailable', async (t) => {
	const { createRun, execute, handlers, layer, observed } = await fixture(t);
	const builder = createContextBuilder(layer.registry);
	for (const run of [await createRun('plan'), await createRun(undefined, true)]) {
		assert.ok((await builder.build(run, [], 100_000)).tools.some(({ name }) => name === obsidianSearchToolName));
	}
	for (const run of [await createRun('review'), await createRun(undefined, false, false)]) {
		assert.ok(!(await builder.build(run, [], 100_000)).tools.some(({ name }) => name === obsidianSearchToolName));
		assert.equal((await execute({ query: 'tag:#AI' }, Promise.resolve(run))).isError, true);
	}
	handlers.delete('search');
	assert.ok(!(await builder.build(await createRun(), [], 100_000)).tools.some(({ name }) => name === obsidianSearchToolName));
	assert.equal((await execute({ query: 'tag:#AI' })).isError, true);
	assert.deepEqual(observed, []);
});
