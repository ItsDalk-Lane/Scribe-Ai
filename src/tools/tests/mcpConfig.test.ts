import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpManager } from '../external/mcp';
import { restoreMcpArgumentSecrets } from '../external/mcpArgumentSecrets';
import { exportMcpJson, normalizeMcpSettings, previewMcpImport, validateMcpDraft } from '../external/mcpConfig';
import type { McpServerDraft } from '../external/mcpConfig';

void test('MCP 导入保留连接类型、参数和工具范围，新连接保持停用', () => {
	const json = previewMcpImport(JSON.stringify({ mcpServers: {
		Local: { command: 'fixture', args: ['', ' two words '], env: { TOKEN: 'local-secret' }, isActive: true },
		Alias: { name: 'local', command: 'other' },
		Old: { baseUrl: 'https://example.test/sse' },
		New: { type: 'streamable-http', url: 'https://example.test/tools', longRunning: true },
		bad: { url: 'file:///private' },
	} }), ['OLD']);
	assert.deepEqual(json.drafts.map(({ name, type, enabled }) => [name, type, enabled]), [
		['Local', 'stdio', false], ['New', 'http', false],
	]);
	assert.deepEqual(json.drafts[0]?.args, ['', ' two words ']);
	assert.equal(json.drafts[0]?.secrets?.env?.TOKEN, 'local-secret');
	assert.equal(json.issues.length, 4);
	assert.match(json.issues.join(' '), /longRunning/);
	assert.equal(previewMcpImport('{"Docs":{"baseUrl":"https://example.test/mcp?mode=docs"}}', []).drafts[0]?.type, 'http');

	const toml = previewMcpImport(`model = "example"
[mcp_servers.reference]
url = "https://example.test/tools?token=private-query"
enabled = true
required = true
startup_timeout_ms = 1500
tool_timeout_sec = 18
enabled_tools = []
disabled_tools = ["change"]
default_tools_approval_mode = "approve"
scopes = ["docs.read"]
[mcp_servers.reference.http_headers]
X-Tenant = "private-tenant"
[mcp_servers.reference.oauth]
client_id = "client"
client_secret = "private-client"
callback_port = 8123
[mcp_servers.runtime]
command = "fixture"
env_vars = ["PATH", { name = "LOCAL", source = "local" }]
[mcp_servers.remote]
command = "fixture"
environment_id = "elsewhere"
`, []);
	const [remote, local] = toml.drafts;
	assert.equal(remote?.type, 'http');
	assert.equal(remote?.enabled, false);
	assert.equal(remote?.required, true);
	assert.equal(remote?.startupTimeout, 1.5);
	assert.equal(remote?.toolTimeout, 18);
	assert.equal(remote?.oauthCallbackPort, 8123);
	assert.equal(remote?.secrets?.headers?.['x-tenant'], 'private-tenant');
	assert.equal(remote?.secrets?.oauthClientSecret, 'private-client');
	assert.deepEqual(remote?.enabledTools, []);
	assert.deepEqual(remote?.disabledTools, ['change']);
	assert.deepEqual(local?.envVars, ['PATH', 'LOCAL']);
	assert.equal('autoApproved' in (remote ?? {}), false);
	assert.equal(toml.issues.length, 2);
	const exported = exportMcpJson(toml.drafts);
	assert.doesNotMatch(exported, /private-query|private-tenant|private-client/);
	const restored = previewMcpImport(exported, []);
	assert.equal(restored.drafts[0]?.url, 'https://example.test/tools');
	assert.deepEqual(restored.drafts[0]?.enabledTools, []);
	assert.deepEqual(restored.issues, []);
});

void test('旧 MCP 自动批准配置不会继续生效，也不影响服务器加载', () => {
	const { servers } = normalizeMcpSettings({ servers: [{
		id: 'legacy', name: 'Legacy', type: 'stdio', command: 'fixture', enabled: true,
		autoApproved: { write: 'a'.repeat(64) },
	}] });
	assert.equal(servers[0]?.id, 'legacy');
	assert.equal(servers[0]?.enabled, true);
	assert.equal('autoApproved' in servers[0], false);
});

void test('restored local MCP commands require this device to approve the saved configuration', async (t) => {
	const original = { id: 'local', name: 'Local', type: 'stdio', command: 'fixture', args: ['one'], enabled: true };
	let settings = normalizeMcpSettings({ servers: [original] });
	const started: string[][] = [];
	const keychain = new Map<string, string>();
	const create = (keys: Map<string, string>) => {
		const manager = createMcpManager({
			settings: () => settings, commit: (next) => { settings = next; return Promise.resolve(); },
			storage: { getSecret: (key) => keys.get(key) || null, setSecret: (key, value) => { keys.set(key, value); } },
			cwd: process.cwd(), clientInfo: { name: 'fixture', version: '1' }, openBrowser: () => assert.fail(),
			connect: ({ server }) => { started.push(server.args ?? []); throw new Error('fixture ended'); },
		});
		t.after(() => manager.dispose());
		return manager;
	};
	const signal = new AbortController().signal;
	const manager = create(keychain);
	manager.reconcile();
	await manager.waitForServer('local', signal);
	await manager.retry('local');
	assert.equal(manager.snapshot()[0]?.server.enabled, false);
	assert.deepEqual(started, []);
	await manager.setEnabled('local', true, settings.servers[0]);
	await manager.waitForServer('local', signal);
	assert.deepEqual(started, [['one']]);
	manager.dispose();

	const freshDevice = create(new Map());
	await freshDevice.retry('local');
	assert.deepEqual(started, [['one']]);
	const reopened = create(keychain);
	await reopened.waitForServer('local', signal);
	assert.deepEqual(started, [['one'], ['one']]);
	const previous = settings.servers[0]!;
	settings = normalizeMcpSettings({ servers: [{ ...previous, args: ['two'] }] });
	await reopened.retry('local');
	await assert.rejects(reopened.setEnabled('local', true, previous), /已变化/);
	assert.deepEqual(started, [['one'], ['one']]);
	await reopened.setEnabled('local', true, settings.servers[0]);
	await reopened.waitForServer('local', signal);
	assert.deepEqual(started.at(-1), ['two']);
	settings = normalizeMcpSettings({ servers: [{ ...original, args: ['https://bridge.test/mcp?k=migration-fixture'] }] });
	await reopened.migrateLegacyArguments();
	assert.doesNotMatch(JSON.stringify(settings), /migration-fixture/);
	const saved = settings.servers[0]!;
	const ref = saved.secretRefs?.args?.[0];
	assert.ok(ref);
	assert.deepEqual(restoreMcpArgumentSecrets(saved.args, { 0: keychain.get(ref)! }), ['https://bridge.test/mcp?k=migration-fixture']);
	assert.equal(saved.enabled, false);
	assert.equal(started.length, 3);
});

void test('MCP 配置校验拦截无效认证，且提示不会回显密钥', () => {
	const secret = 'PRIVATE-VALUE';
	const mixed = previewMcpImport(JSON.stringify({ example: {
		type: 'http', url: 'https://example.test/mcp', bearerToken: secret, headers: { Authorization: secret },
	} }), []);
	assert.equal(mixed.drafts.length, 0);
	assert.doesNotMatch(mixed.issues.join(' '), /PRIVATE-VALUE/);
	assert.throws(() => validateMcpDraft({ id: '', name: 'bad', type: 'http', enabled: false,
		url: 'https://user:PRIVATE-VALUE@example.test/mcp' }), /有效/);
	const insecure = { id: 'old', name: 'Old', type: 'sse', enabled: true, url: 'http://remote.example.test/mcp' } as const;
	assert.throws(() => validateMcpDraft(insecure), /HTTPS/);
	assert.equal(normalizeMcpSettings({ servers: [insecure] }).servers[0]?.enabled, false);
	assert.deepEqual(normalizeMcpSettings({ loading: 'unknown', threshold: -4, servers: [{ id: 'invalid' }] }), {
		loading: 'auto', threshold: 4000, servers: [],
	});
});

void test('导入的 MCP 密钥使用服务器名称存入钥匙串，连接时读取并保留共用条目', async (t) => {
	let settings = normalizeMcpSettings({ servers: [{
		id: 'legacy', name: 'Legacy', type: 'http', url: 'https://example.test/legacy', enabled: false, secretKey: 'old-mcp-bundle',
	}] });
	const secrets = new Map([
		['web-reader', 'old-entry'], ['web-reader-2', ''], ['shared-key', 'shared-fixture-token'],
		['old-mcp-bundle', JSON.stringify({ bearerToken: 'legacy-token' })],
	]);
	const connections: McpServerDraft[] = [];
	const manager = createMcpManager({
		settings: () => settings, commit: (next) => { settings = next; return Promise.resolve(); },
		storage: { getSecret: (key) => secrets.get(key) || null, setSecret: (key, value) => { secrets.set(key, value); },
			listSecrets: () => [...secrets.keys()] },
		cwd: process.cwd(), clientInfo: { name: 'test', version: '0.1' }, openBrowser: () => assert.fail(),
		connect: ({ server }) => {
			connections.push(server);
			const load = () => Promise.resolve({ tools: [], resources: false });
			const result = () => Promise.resolve({ content: '', isError: false });
			return { start: load, login: load, listTools: () => Promise.resolve([]), callTool: result,
				listResources: result, readResource: result, close: () => Promise.resolve(), redact: (text) => text };
		},
	});
	t.after(() => manager.dispose());
	const { drafts, issues } = previewMcpImport(JSON.stringify({ mcpServers: {
		'web-reader': { url: 'https://example.test/mcp?token=query-fixture',
			headers: { 'X-Api-Key': 'header-fixture', Authorization: 'Bearer bearer-fixture' } },
		'Local Dev': { command: 'fixture', env: { API_KEY: 'environment-fixture', EMPTY: '' },
			args: ['--token', 'separate-fixture', '--api-key=inline-fixture', '--header', 'Authorization: Bearer cli-header-fixture', 'keep',
				'--', 'https://bridge.test/mcp?token=positional-fixture'] },
	} }), ['Legacy']);
	assert.deepEqual(issues, []);
	await manager.import(drafts);
	const [, web, local] = settings.servers;
	assert.ok(web && local);
	assert.ok(!web.enabled && !local.enabled);
	assert.equal(secrets.get('web-reader'), 'old-entry');
	assert.equal(secrets.get('web-reader-2'), '');
	assert.equal(web.secretRefs?.headers?.['x-api-key'], 'web-reader-3');
	assert.equal(local.secretRefs?.env?.API_KEY, 'local-dev');
	assert.doesNotMatch(JSON.stringify(settings) + exportMcpJson(drafts) + exportMcpJson(settings.servers),
		/query-fixture|header-fixture|bearer-fixture|environment-fixture|separate-fixture|inline-fixture|legacy-token|positional-fixture/);
	const signal = new AbortController().signal;
	for (const id of ['legacy', local.id, web.id]) {
		await manager.setEnabled(id, true);
		await manager.waitForServer(id, signal);
	}
	assert.equal(connections[0]?.secrets?.bearerToken, 'legacy-token');
	assert.deepEqual(connections[1]?.secrets?.env, { API_KEY: 'environment-fixture', EMPTY: '' });
	assert.deepEqual(restoreMcpArgumentSecrets(connections[1]?.args, connections[1]?.secrets?.args),
		['--token', 'separate-fixture', '--api-key=inline-fixture', '--header', 'Authorization: Bearer cli-header-fixture', 'keep',
			'--', 'https://bridge.test/mcp?token=positional-fixture']);
	assert.equal(connections[2]?.secrets?.url, 'https://example.test/mcp?token=query-fixture');
	assert.equal(connections[2]?.secrets?.headers?.['x-api-key'], 'header-fixture');
	assert.equal(connections[2]?.secrets?.bearerToken, 'bearer-fixture');
	const edit = manager.draft(web.id)!;
	assert.equal(edit.secrets, undefined);
	await manager.save({ ...edit, secretRefs: { ...edit.secretRefs, bearerToken: 'shared-key' } });
	await manager.waitForServer(web.id, signal);
	assert.equal(connections.at(-1)?.secrets?.bearerToken, 'shared-fixture-token');
	secrets.set('shared-key', 'updated-fixture-token');
	await manager.save(manager.draft(web.id)!, true);
	await manager.waitForServer(web.id, signal);
	assert.equal(connections.at(-1)?.secrets?.bearerToken, 'updated-fixture-token');
	secrets.delete('shared-key');
	await manager.retry(web.id);
	assert.equal(connections.length, 5);
	assert.match(manager.snapshot().find(({ server }) => server.id === web.id)?.error ?? '', /钥匙串/);
	secrets.delete('old-mcp-bundle');
	await manager.retry('legacy');
	assert.equal(connections.length, 5);
	assert.match(manager.snapshot().find(({ server }) => server.id === 'legacy')?.error ?? '', /钥匙串/);
	secrets.set('shared-key', 'shared-fixture-token');
	await manager.remove(web.id);
	assert.equal(secrets.get('shared-key'), 'shared-fixture-token');
});
