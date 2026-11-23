import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { App } from 'obsidian';
import { createContextBuilder } from '../../orchestration/context/contextBuilder';
import { createRunContext } from '../../orchestration/runContext';
import { createTask } from '../../orchestration/taskManager';
import { createAgentLoop } from '../../runtime/agentLoop';
import { bindAgent } from '../../runtime/createAgent';
import { createToolCoordinator } from '../../runtime/toolCoordinator';
import type { ModelResponse } from '../../types';
import { ToolReviewDeniedError } from '../../types';
import { createReadDelivery } from '../../runtime/readDelivery';
import { createToolRegistry } from '..';
import { createToolExecutor } from '../executor';
import { createMcpManager } from '../external/mcp';
import { normalizeMcpSettings } from '../external/mcpConfig';
import type { createMcpConnection, McpToolInfo } from '../external/mcpConnection';
import { createMcpRun, createMcpTools } from '../external/mcpTools';
import { readTools } from '../readTools';

void test('MCP 按需发现保留原参数，遵循聊天权限模式并复核工具变化', async (t) => {
	let settings = normalizeMcpSettings(undefined);
	let change = () => {};
	let fail = false;
	let lastArguments: unknown;
	let calls = 0;
	let closing = 0;
	let saveFailure = false;
	const secrets = new Map<string, string>();
	const schema = { type: 'object', properties: { i: { type: 'string' } }, required: ['i'], additionalProperties: false };
	let listing: McpToolInfo[] = [{ name: 'record', description: 'save test record', inputSchema: schema }];
	const manager = createMcpManager({
		settings: () => settings,
		commit(next) {
			if (saveFailure) return Promise.reject(new Error('保存失败'));
			settings = next;
			return Promise.resolve();
		},
		cwd: process.cwd(), clientInfo: { name: 'fixture', version: '0.1' }, openBrowser: () => {},
		storage: { getSecret: (key) => secrets.get(key) ?? null, setSecret: (key, value) => { secrets.set(key, value); } },
		connect: ((options) => {
			change = options.onToolsChanged;
			const load = () => Promise.resolve({ tools: listing, resources: true, version: '1' });
			return {
				start: load, login: load, listTools: () => Promise.resolve(listing),
				listResources: () => Promise.resolve({ content: 'resource template', isError: false }),
				readResource: () => Promise.resolve({ content: 'resource text', isError: false }),
				callTool(_name, args, signal) {
					signal.throwIfAborted();
					calls++;
					lastArguments = args;
					return Promise.resolve({ content: fail ? 'external failure' : 'ok', isError: fail });
				},
				close: () => { closing++; return Promise.resolve(); },
				redact: (text) => text.replaceAll('token-fixture', '[redacted]'),
			};
		}) satisfies typeof createMcpConnection,
	});
	t.after(() => manager.dispose());
	await manager.import([{ name: 'Example', id: '', type: 'http', url: 'https://example.test/mcp?key=token-fixture',
		enabled: true, secrets: { bearerToken: 'token-fixture' }, required: true }]);
	const server = settings.servers[0]!;
	assert.equal(server.enabled, false);
	assert.doesNotMatch(JSON.stringify(settings), /token-fixture/);
	assert.equal(manager.draft(server.id)?.url, 'https://example.test/mcp');
	assert.equal(secrets.get(server.secretRefs?.bearerToken ?? ''), 'token-fixture');
	saveFailure = true;
	await assert.rejects(manager.save({ ...manager.draft(server.id)!, secrets: { bearerToken: 'new-secret' } }), /保存失败/);
	assert.equal(secrets.get(settings.servers[0]?.secretRefs?.bearerToken ?? ''), 'token-fixture');
	assert.equal([...secrets.values()].some((value) => value.includes('new-secret')), false);
	saveFailure = false;
	await manager.setEnabled(server.id, true);
	await manager.setLoading('deferred', 4000);
	const registry = createToolRegistry([() => createMcpTools(manager)]);
	const app = {} as App;
	const task = createTask({ instruction: 'fixture', conversationId: 'fixture', refs: [] });
	const signal = new AbortController().signal;
	const run = await createRunContext(task, { cwd: process.cwd(), model: { providerId: 'fixture', model: 'fixture' }, signal, observer: {} },
		'fixture-vault-config', () => true, false, 'ask');
	run.mcpRun = createMcpRun(manager);
	const context = createContextBuilder(registry);
	const executor = createToolExecutor(registry);
	const prepare = async () => context.build(run, [{ role: 'user', content: 'fixture' }], 40_000);
	const invoke = (name: string, input: unknown, approve?: Parameters<typeof executor.execute>[1]['approve']) =>
		executor.execute({ id: 'call', name, input }, { ...run, app, approve, readDelivery: createReadDelivery() });

	let request = await prepare();
	assert.ok(request.tools.some(({ name }) => name === 'search_mcp_tools'));
	const alias = createMcpTools(manager).find(({ name }) => name.includes('__record_'))!.name;
	assert.equal(request.tools.some(({ name }) => name === alias), false);
	assert.equal((await invoke(alias, { i: 'literal' })).isError, true);
	assert.match((await invoke('search_mcp_tools', { query: 'save record' })).content, /record/);
	request = await prepare();
	assert.deepEqual(request.tools.find(({ name }) => name === alias)?.inputSchema, schema);
	assert.ok(request.tools.some(({ name }) => name.includes('__list_resources_')));
	assert.equal((await invoke(alias, { i: 'denied' }, () => Promise.resolve(false))).isError, true);
	assert.equal(calls, 0);
	const receipt = await invoke(alias, { i: 'token-fixture' }, (approval) => {
		assert.equal(approval.kind, 'mcp');
		assert.match(approval.reason ?? '', /https:\/\/example\.test/);
		assert.match(approval.after ?? '', /\[redacted\]/);
		assert.doesNotMatch(approval.after ?? '', /token-fixture/);
		return Promise.resolve(true);
	});
	assert.equal(receipt.content, 'ok');
	assert.deepEqual(lastArguments, { i: 'token-fixture' });

	assert.equal((await invoke(alias, { i: 'needs-approval-again' })).isError, true);
	listing = [{ ...listing[0]!, description: 'new definition' }];
	change();
	await setImmediate();
	assert.equal((await invoke(alias, { i: 'stale' })).isError, true);
	await invoke('search_mcp_tools', { query: 'new definition' });
	await prepare();
	fail = true;
	assert.deepEqual((await invoke(alias, { i: 'approved' }, () => Promise.resolve(true))).isError, true);

	const blocked = await invoke(alias, { i: 'outdated' }, async () => {
		await manager.setEnabled(server.id, false);
		return true;
	});
	assert.equal(blocked.isError, true);
	assert.equal(calls, 2);
	assert.equal(closing, 1);
	assert.equal((await prepare()).tools.length, 0);

	await manager.setEnabled(server.id, true);
	await manager.setLoading('direct', 4000);
	fail = false;
	const models = {
		async nextTurn(state: { messages: Parameters<typeof context.build>[1] }, current: typeof run): Promise<ModelResponse> {
			const request = await context.build(current, state.messages, 40_000);
			assert.ok(request.tools.some(({ name }) => name === alias));
			const result = state.messages.find(({ role }) => role === 'tool');
			const toolCalls = result ? [] : [{ id: 'agent-mcp', name: alias, input: { i: 'via-agent' } }];
			return {
				content: result ? 'complete' : '', toolCalls, stopReason: result ? 'end' : 'tool-calls',
				raw: { role: 'assistant', content: [], api: 'openai-completions', provider: 'fixture', model: 'fixture',
					timestamp: 1, stopReason: result ? 'stop' : 'toolUse',
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
			};
		},
	};
	const bind = bindAgent(createAgentLoop(models, createToolCoordinator(app, executor), manager));
	for (const [mode, allow] of [
		['ask', true], ['auto-review', true], ['auto-review', false], ['full-access', true],
	] as const) {
		let manual = 0;
		let reviewed = 0;
		const before: number = calls;
		const current = await createRunContext(task, {
			cwd: process.cwd(), model: run.model, signal,
			observer: { approve: (approval) => {
				manual++;
				assert.equal(approval.kind, 'mcp');
				return Promise.resolve(allow);
			} },
			reviewTool: (approval) => {
				reviewed++;
				assert.equal(approval.kind, 'mcp');
				return allow ? Promise.resolve(true) : Promise.reject(new ToolReviewDeniedError('AI 审核未批准'));
			},
		}, 'fixture-vault-config', () => true, false, mode);
		const agent = bind(current);
		const completed = await agent.loop.run(current, agent.state);
		assert.equal(completed.status, 'done');
		assert.equal(manual, mode === 'ask' ? 1 : 0);
		assert.equal(reviewed, mode === 'auto-review' ? 1 : 0);
		assert.equal(calls - before, allow ? 1 : 0);
		const result = completed.messages.find(({ role }) => role === 'tool');
		assert.equal(result?.isError, !allow);
		assert.equal(result?.approvalReview, mode === 'auto-review' ? allow ? 'approved' : 'denied' : undefined);
	}
});

void test('点选 MCP 后仅公开该服务器的工具，溢出搜索、审批和工具开关仍生效', async (t) => {
	let settings = normalizeMcpSettings({ loading: 'deferred', servers: [
		{ id: 'selected', name: 'Selected', type: 'http', url: 'https://selected.test/mcp', enabled: true },
		{ id: 'other', name: 'Other', type: 'http', url: 'https://other.test/mcp', enabled: true },
		{ id: 'required', name: 'Unavailable', type: 'http', url: 'https://unavailable.test/mcp', enabled: true, required: true },
	] });
	const schema = { type: 'object', properties: {} };
	const calls: string[] = [];
	const manager = createMcpManager({
		settings: () => settings,
		commit: (next) => { settings = next; return Promise.resolve(); },
		cwd: process.cwd(), clientInfo: { name: 'fixture', version: '0.1' }, openBrowser: () => {},
		storage: { getSecret: () => null, setSecret: () => {} },
		connect: ({ server }) => {
			const catalog = (server.id === 'selected' ? ['first', 'second'] : ['foreign'])
				.map((name) => ({ name, description: name.repeat(200), inputSchema: schema }));
			const load = () => server.id === 'required' ? Promise.reject(new Error('fixture unavailable'))
				: Promise.resolve({ tools: catalog, resources: false });
			return {
				start: load, login: load, listTools: () => Promise.resolve(catalog),
				listResources: () => Promise.resolve({ content: '', isError: false }),
				readResource: () => Promise.resolve({ content: '', isError: false }),
				callTool(name) { calls.push(server.id + ' / ' + name); return Promise.resolve({ content: 'ok', isError: false }); },
				close: () => Promise.resolve(), redact: (value) => value,
			};
		},
	});
	t.after(() => manager.dispose());
	manager.reconcile();
	const signal = new AbortController().signal;
	await manager.waitForServer('other', signal);
	const target = { kind: 'mcp' as const, id: 'selected', label: 'Old name' };
	const task = createTask({ instruction: 'fixture', conversationId: 'fixture', refs: [], target });
	const run = await createRunContext(task, { cwd: process.cwd(), model: { providerId: 'fixture', model: 'fixture' }, signal, observer: {} },
		'fixture-vault-config', () => true, false, 'ask');
	const scope = createMcpRun(manager, target.id);
	run.mcpRun = scope;
	const registry = createToolRegistry([readTools, () => createMcpTools(manager)]);
	const context = createContextBuilder(registry);
	const build = async () => context.build(run, [{ role: 'user', content: 'fixture' }], 40_000);
	const request = await build();
	const first = createMcpTools(manager).find(({ mcp }) => mcp.label === 'Selected / first')!;
	const second = createMcpTools(manager).find(({ mcp }) => mcp.label === 'Selected / second')!;
	const foreign = createMcpTools(manager).find(({ mcp }) => mcp.label === 'Other / foreign')!;
	assert.match(request.system ?? '', /用户本次点选的 MCP 服务器是 "Selected"/);
	assert.ok(request.tools.some(({ name }) => name === 'Read'));
	assert.deepEqual(request.tools.filter(({ name }) => name.startsWith('mcp__')).map(({ name }) => name), [first.name, second.name]);
	const executor = createToolExecutor(registry);
	const execute = (name: string, input: unknown, approve?: Parameters<typeof executor.execute>[1]['approve']) =>
		executor.execute({ id: 'mcp-call', name, input }, { ...run, app: {} as App, approve, readDelivery: createReadDelivery() });
	assert.equal((await execute(foreign.name, {})).isError, true);
	assert.equal((await execute(first.name, {}, () => Promise.resolve(false))).isError, true);
	assert.equal((await execute(first.name, {}, () => Promise.resolve(true))).content, 'ok');
	assert.deepEqual(calls, ['selected / first']);

	assert.ok(scope.project(registry.all(), 1_750).some(({ name }) => name === 'search_mcp_tools'));
	assert.match((await execute('search_mcp_tools', { query: 'foreign' })).content, /没有更多匹配/);
	assert.match((await execute('search_mcp_tools', { query: 'second' })).content, /Selected \/ second/);
	assert.ok(scope.project(registry.all(), 1_750).some(({ name }) => name === second.name));
	await assert.rejects(context.build({ ...run, permissions: { ...run.permissions, canCallTool: () => false } }, [], 40_000), /当前聊天无法调用/);
	await manager.setToolEnabled(target.id, 'first', false);
	await manager.setToolEnabled(target.id, 'second', false);
	await assert.rejects(build(), /没有可用工具/);
	await manager.setEnabled(target.id, false);
	await assert.rejects(build(), /已停用或移除/);
});
