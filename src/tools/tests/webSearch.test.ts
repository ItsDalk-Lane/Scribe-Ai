import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';
import { createContextBuilder } from '../../orchestration/context/contextBuilder';
import { createRunContext } from '../../orchestration/runContext';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../orchestration/settings/defaults';
import { createTask } from '../../orchestration/taskManager';
import type { ExecutionMode, ToolApproval } from '../../types';
import { createToolLayer } from '..';
import type { createMcpConnection } from '../external/mcpConnection';
import { WEB_SEARCH_PROVIDERS, type WebSearchProvider } from '../external/webSearchSettings';
import { createWebSearchService } from '../external/webTools';

const query = 'Obsidian developer documentation plugin API';
const resultUrl = 'https://docs.obsidian.md/';
const model = { providerId: 'another-llm', model: 'fixture' };

function fixture() {
	const settings = normalizeSettings({ communication: { ...DEFAULT_SETTINGS.communication,
		credentialIds: { 'zai-coding-cn': 'zhipu-key', deepseek: 'deepseek-key' } } });
	const secrets = new Map([['zhipu-key', 'zhipu-fixture'], ['deepseek-key', 'deepseek-fixture'], ['tavily-key', 'tavily-fixture']]);
	const calls: { destination: string | undefined; auth: string | undefined; args: unknown }[] = [];
	let aborted = false;
	let badStatus: number | undefined;
	let closed = 0;
	const connect: typeof createMcpConnection = ({ server }) => {
		const name = server.id === 'zhipu-coding' ? 'web_search_prime' : 'web_search_exa';
		const start = async () => ({ resources: false, tools: [{ name, inputSchema: {} }] });
		return {
			start, login: start, listTools: async () => (await start()).tools,
			callTool: async (_name, args, signal) => {
				assert.equal(_name, name);
				signal.throwIfAborted();
				calls.push({ destination: server.url, auth: server.secrets?.bearerToken, args });
				const content = server.id === 'zhipu-coding'
					? JSON.stringify(JSON.stringify([{ title: 'Obsidian', link: resultUrl, content: 'Zhipu excerpt' }]))
					: `Title: Obsidian\nURL: ${resultUrl}\nPublished: N/A\nHighlights:\nExa excerpt`;
				return { content, isError: false };
			},
			listResources: async () => ({ content: '', isError: false }),
			readResource: async () => ({ content: '', isError: false }),
			close: async () => { closed++; }, redact: (value) => value,
		};
	};
	const fetchSearch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.redirect, 'error');
		calls.push({ destination: request.url, auth: request.headers.get('Authorization') ?? undefined, args: await request.json() });
		if (aborted) await new Promise((_resolve, reject) => {
			const cancel = () => reject(new Error('请求已取消'));
			if (request.signal.aborted) cancel();
			else request.signal.addEventListener('abort', cancel, { once: true });
		});
		if (badStatus) return new Response(null, { status: badStatus });
		const excerpt = request.url === WEB_SEARCH_PROVIDERS.tavily.endpoint ? { content: 'Tavily excerpt' } : { summary: 'DeepSeek excerpt' };
		return Response.json({ results: [{ title: 'Obsidian', url: resultUrl, ...excerpt },
			{ title: 'invalid', url: 'javascript:void(0)' }, { title: 'duplicate', url: resultUrl }] });
	};
	const service = createWebSearchService(settings, { getSecret: (id) => secrets.get(id) ?? null }, process.cwd(),
		{ name: 'test', version: '1' }, fetchSearch, connect);
	const layer = createToolLayer(undefined, undefined, undefined, service.tools);
	const select = (provider: WebSearchProvider, enable = true) => {
		settings.webSearch = normalizeSettings({ webSearch: { enabled: enable, provider, credentialIds: { tavily: 'tavily-key' } } }).webSearch;
	};
	return {
		settings, select, calls, layer, service, closed: () => closed,
		waitForAbort: () => { aborted = true; }, failWith: (status: number) => { badStatus = status; },
	};
}

async function runContext(executionMode: ExecutionMode, options: {
	signal?: AbortSignal; tools?: boolean; sideChat?: boolean; intent?: 'plan';
} = {}) {
	return createRunContext(createTask({ conversationId: 'fixture', instruction: 'fixture', refs: [], intent: options.intent }),
		{ cwd: process.cwd(), model, signal: options.signal ?? new AbortController().signal, observer: {} },
		'fixture-vault-config', () => options.tools !== false, options.sideChat, executionMode);
}

void test('普通 Agent 获得独立网页搜索工具，审批拒绝或切换接收方不会发送查询', async () => {
	const { select, calls, layer, closed } = fixture();
	const context = createContextBuilder(layer.registry);
	const ask = await runContext('ask');
	const visible = async (run = ask) => (await context.build(run, [{ role: 'user', content: query }], 40_000)).tools.map(({ name }) => name);
	assert.equal((await visible()).includes('web_search'), false);
	select('zhipu-coding');
	assert.ok((await visible()).includes('web_search'));
	assert.ok((await visible()).includes('Read'));
	for (const options of [{ tools: false }, { sideChat: true }, { intent: 'plan' }] as const) {
		assert.equal((await visible(await runContext('ask', options))).includes('web_search'), false);
	}
	const invoke = (approve: (approval: ToolApproval) => Promise<boolean>, run = ask, text = query) =>
		layer.executor.execute({ id: 'search', name: 'web_search', input: { query: text, i: '查找开发文档' } },
			{ ...run, app: {} as App, approve });

	assert.equal((await invoke(async (approval) => {
		assert.equal(approval.kind, 'web-search');
		assert.equal(approval.after, query);
		assert.match(approval.reason ?? '', /https:\/\/open\.bigmodel\.cn/);
		return false;
	})).isError, true);
	assert.equal((await invoke(async () => { select('exa'); return true; })).isError, true);
	assert.equal((await invoke(async () => true, ask, '长'.repeat(129))).isError, true);
	assert.equal(calls.length, 0);

	select('zhipu-coding');
	const approved = await invoke(async () => true, await runContext('auto-review'));
	assert.equal(approved.isError, false);
	assert.deepEqual(JSON.parse(approved.content), { source: '智谱 Coding Plan',
		results: [{ title: 'Obsidian', url: resultUrl, summary: 'Zhipu excerpt' }] });
	assert.deepEqual(calls, [{ destination: WEB_SEARCH_PROVIDERS['zhipu-coding'].endpoint,
		auth: 'zhipu-fixture', args: { search_query: query } }]);
	assert.equal(closed(), 1);
});

void test('搜索服务按所选服务商发送参数，处理免费服务、协议错误与取消', async () => {
	const { select, calls, layer, service, waitForAbort, failWith } = fixture();
	const execute = async (signal?: AbortSignal) => layer.executor.execute({ id: 'search', name: 'web_search', input: { query } },
		{ ...await runContext('full-access', { signal }), app: {} as App, approve: async () => { assert.fail('全访问模式不应再次审批'); } });
	assert.equal(service.isConfigured('tavily'), false);
	for (const provider of ['deepseek', 'exa', 'tavily'] as const) {
		select(provider);
		const result = await execute();
		assert.equal(result.isError, false);
		const summary = `${WEB_SEARCH_PROVIDERS[provider].label} excerpt`;
		assert.deepEqual(JSON.parse(result.content), { source: WEB_SEARCH_PROVIDERS[provider].label, results: [{ title: 'Obsidian', url: resultUrl, summary }] });
	}
	assert.deepEqual(calls, [
		{ destination: WEB_SEARCH_PROVIDERS.deepseek.endpoint, auth: 'Bearer deepseek-fixture', args: { query, count: 6, need_content: false } },
		{ destination: WEB_SEARCH_PROVIDERS.exa.endpoint, auth: undefined, args: { query, numResults: 6 } },
		{ destination: WEB_SEARCH_PROVIDERS.tavily.endpoint, auth: 'Bearer tavily-fixture',
			args: { query, search_depth: 'basic', max_results: 6, auto_parameters: false } },
	]);
	failWith(429);
	const failure = await execute();
	assert.equal(failure.isError, true);
	assert.match(failure.content, /HTTP 429/);
	waitForAbort();
	const controller = new AbortController();
	const pending = execute(controller.signal);
	for (let attempt = 0; calls.length < 5 && attempt < 100; attempt++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	controller.abort();
	assert.equal(calls.length, 5);
	assert.match((await pending).content, /任务已停止/);
});

void test('解除搜索密钥链接后重开设置也不会复用模型密钥，重新链接后可搜索', async () => {
	const { settings, select, service, layer, calls } = fixture();
	select('zhipu-coding');
	assert.equal(service.credentialId('zhipu-coding'), 'zhipu-key');
	assert.ok(layer.registry.find('web_search'));

	settings.webSearch!.credentialIds['zhipu-coding'] = null;
	const saved = JSON.stringify(settings);
	Object.assign(settings, normalizeSettings(JSON.parse(saved) as typeof settings));
	assert.equal(settings.communication.credentialIds['zai-coding-cn'], 'zhipu-key');
	assert.equal(service.credentialId('zhipu-coding'), undefined);
	assert.equal(layer.registry.find('web_search'), undefined);
	const signal = new AbortController().signal;
	await assert.rejects(service.test('zhipu-coding', signal), /关联 .*API 密钥/);
	assert.equal(calls.length, 0);

	settings.webSearch!.credentialIds['zhipu-coding'] = 'zhipu-key';
	assert.ok(layer.registry.find('web_search'));
	assert.equal((await service.test('zhipu-coding', signal))[0]?.url, resultUrl);
});
