import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { nodeFetch } from '../../communication/nodeFetch';
import { createMcpConnection, McpAuthRequiredError } from '../external/mcpConnection';
import type { McpServerDraft } from '../external/mcpConfig';

type RPC = { id?: number; method: string; params?: Record<string, unknown> };
const tools = [{ name: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }];
const initialize = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true }, resources: {} },
	serverInfo: { name: 'fixture', version: '1.0.0' } };

function json(response: ServerResponse, value: unknown, status = 200) {
	response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

function reply(id: number | undefined, result: unknown) { return { jsonrpc: '2.0', id, result }; }

async function listen(t: TestContext, work: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
	const server = createServer((request, response) => {
		void Promise.resolve(work(request, response)).catch(() => response.destroy());
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	}));
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
	request.setEncoding('utf8');
	let text = '';
	for await (const chunk of request) if (typeof chunk === 'string') text += chunk;
	return text;
}

function connect(t: TestContext, draft: Omit<McpServerDraft, 'id' | 'name' | 'enabled'>,
	callbacks: { openBrowser?: (url: string) => void; onToolsChanged?: () => void } = {},
) {
	let saved: string | undefined;
	const oauth = { read: () => saved, write: (value: string) => { saved = value; } };
	const connection = createMcpConnection({
		server: { id: 'fixture', name: 'fixture', enabled: true, startupTimeout: 2, ...draft },
		cwd: process.cwd(), clientInfo: { name: 'test', version: '1.0.0' }, signal: new AbortController().signal, oauth,
		openBrowser: callbacks.openBrowser ?? (() => assert.fail('unexpected OAuth browser window')),
		onClose: () => {}, onToolsChanged: callbacks.onToolsChanged ?? (() => {}),
	});
	t.after(() => connection.close());
	return { connection, oauth };
}

void test('MCP 连接显示服务商返回的认证原因，同时隐藏请求密钥', { timeout: 5_000 }, async (t) => {
	const key = 'fixture-mcp-key';
	const url = await listen(t, async (request, response) => {
		if (request.method === 'GET') { response.writeHead(405).end(); return; }
		const { id, method } = JSON.parse(await readBody(request)) as RPC;
		if (id === undefined) { response.writeHead(202).end(); return; }
		if (!request.headers.authorization) {
			json(response, { success: false, code: 1001, msg: '未收到 Authorization 参数' });
			return;
		}
		assert.equal(request.headers.authorization, `Bearer ${key}`);
		if (method === 'initialize') json(response, reply(id, initialize));
		else json(response, { success: false, code: 401, msg: `令牌无权访问 ${key}` });
	});
	const { connection: missing } = connect(t, { type: 'http', url });
	await assert.rejects(missing.start(), /1001.*未收到 Authorization 参数/);
	const { connection: rejected } = connect(t, { type: 'http', url, secrets: { bearerToken: `Bearer ${key}` } });
	await assert.rejects(rejected.start(), (error: Error) => {
		assert.match(error.message, /401.*令牌无权访问.*已隐藏/);
		assert.doesNotMatch(error.message, /fixture-mcp-key|invalid_union/);
		return true;
	});
});

void test('MCP keeps valid image and image resource blocks alongside text and URL references', { timeout: 5_000 }, async (t) => {
	const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
	const image = { type: 'image', mimeType: 'image/png', data: png };
	const resource = { uri: 'fixture://snapshot', mimeType: 'image/png', blob: png };
	const url = await listen(t, async (request, response) => {
		if (request.method === 'GET') { response.writeHead(405).end(); return; }
		const { id, method } = JSON.parse(await readBody(request)) as RPC;
		if (id === undefined) { response.writeHead(202).end(); return; }
		const result = method === 'initialize' ? initialize : method === 'tools/list' ? { tools }
			: method === 'resources/read' ? { contents: [resource] } : { content: [
				{ type: 'text', text: 'Preview' }, image, { type: 'resource', resource },
				{ type: 'resource_link', name: 'other', uri: 'https://images.example.com/image.png', mimeType: 'image/png' },
				{ ...image, data: 'invalid' },
			] };
		json(response, reply(id, result));
	});
	const { connection } = connect(t, { type: 'http', url });
	await connection.start();
	const signal = new AbortController().signal;
	const result = await connection.callTool('echo', {}, signal);
	assert.deepEqual(result.images, [image, image]);
	assert.match(result.content, /https:\/\/images\.example\.com\/image\.png/u);
	assert.deepEqual((await connection.readResource(resource.uri, signal)).images, [image]);
});

void test('Streamable HTTP paginates discovery and resources, handles updates, redacts secrets, and times out calls', { timeout: 5_000 }, async (t) => {
	let stream: ServerResponse | undefined;
	let notify!: () => void;
	const notified = new Promise<void>((resolve) => { notify = resolve; });
	const token = 'sample-bearer-value';
	let duplicate = false;
	const url = await listen(t, async (request, response) => {
		assert.equal(request.headers.authorization, `Bearer ${token}`);
		if (request.method === 'GET') {
			stream = response;
			response.writeHead(200, { 'Content-Type': 'text/event-stream' }).flushHeaders();
			return;
		}
		const message = JSON.parse(await readBody(request)) as RPC;
		if (message.id === undefined) { response.writeHead(202).end(); return; }
		let result: unknown;
		switch (message.method) {
			case 'initialize': result = initialize; break;
			case 'tools/list': result = message.params?.cursor ? { tools: [{ ...tools[0], name: duplicate ? 'echo' : 'later' }] }
				: { tools: [{ ...tools[0], description: `Configured with ${token}` },
					{ name: 'private', inputSchema: { type: 'object', description: token } }], nextCursor: 'next' };
				break;
			case 'tools/call':
				if (message.params?.name === 'later') return;
				assert.deepEqual(message.params?.arguments, { i: 'legitimate' });
				result = { content: [{ type: 'text', text: token }], structuredContent: { tag: token }, isError: true };
				break;
			case 'resources/list': result = { resources: [{ uri: 'fixture://resource', name: 'resource' }] }; break;
			case 'resources/templates/list': result = { resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'template' }] }; break;
			case 'resources/read': result = { contents: [{ uri: 'fixture://resource', text: 'note' }] }; break;
			default: assert.fail(message.method);
		}
		json(response, reply(message.id, result));
	});
	const { connection } = connect(t, { type: 'http', url, toolTimeout: 0.15, secrets: { bearerToken: token } }, { onToolsChanged: notify });
	const catalog = await connection.start();
	assert.deepEqual(catalog.tools.map(({ name }) => name), ['echo', 'later']);
	assert.equal(catalog.tools[0]?.description, 'Configured with [已隐藏]');
	assert.equal(catalog.resources, true);
	assert.ok(stream);
	stream.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
	await notified;
	const signal = new AbortController().signal;
	assert.deepEqual(await connection.callTool('echo', { i: 'legitimate' }, signal), { content: '[已隐藏]\n\n{"tag":"[已隐藏]"}', isError: true });
	assert.match((await connection.listResources(signal)).content, /fixture:\/\/\{id\}/);
	assert.equal((await connection.readResource('fixture://resource', signal)).content, 'fixture://resource\nnote');
	await assert.rejects(connection.callTool('later', {}, signal), /超时/);
	duplicate = true;
	await assert.rejects(connection.listTools(signal), /重复的工具名称/);
});

void test('stdio launches a local server with arguments and closes it; legacy SSE supports its own request endpoint', { timeout: 5_000 }, async (t) => {
	const stdioScript = `const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', (line) => { const msg = JSON.parse(line); if (msg.id === undefined) return;
const result = msg.method === 'initialize' ? ${JSON.stringify(initialize)} :
msg.method === 'tools/list' ? {tools:${JSON.stringify(tools)}} : {content:[{type:'text',text:process.argv.slice(1).join(' ')}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n'); });`;
	const { connection: stdio } = connect(t, { type: 'stdio', command: process.execPath,
		args: ['-e', stdioScript, 'from stdio', '--token='], secrets: { args: { '3': 'sample-stdio-secret' } } });
	assert.equal((await stdio.start()).tools[0]?.name, 'echo');
	assert.equal((await stdio.callTool('echo', {}, new AbortController().signal)).content, 'from stdio --token=[已隐藏]');
	await stdio.close();
	await assert.rejects(stdio.listTools(), /取消|aborted|尚未连接/i);

	let stream: ServerResponse | undefined;
	const url = await listen(t, async (request, response) => {
		assert.equal(request.headers['x-fixture'], 'same-origin');
		if (request.url === '/sse') {
			stream = response;
			response.writeHead(200, { 'Content-Type': 'text/event-stream' }).write('event: endpoint\ndata: /messages\n\n');
			return;
		}
		assert.equal(request.url, '/messages');
		const { id, method } = JSON.parse(await readBody(request)) as RPC;
		response.writeHead(202).end();
		if (id === undefined) return;
		const result = method === 'initialize' ? initialize : { tools };
		stream?.write(`data: ${JSON.stringify(reply(id, result))}\n\n`);
	});
	const { connection: sse } = connect(t, { type: 'sse', url: `${url}/sse`, secrets: { headers: { 'x-fixture': 'same-origin' } } });
	assert.equal((await sse.start()).tools[0]?.name, 'echo');
});

void test('OAuth waits for explicit login, verifies state and PKCE, and stores credentials for reconnect', { timeout: 8_000 }, async (t) => {
	const token = 'oauth-fixture-token';
	let url: string;
	let expectedChallenge: string | null = null;
	let browser: Promise<void> | undefined;
	url = await listen(t, async (request, response) => {
		if (request.url?.startsWith('/.well-known/oauth-protected-resource')) return json(response, { resource: `${url}/mcp`, authorization_servers: [url] });
		if (request.url === '/.well-known/oauth-authorization-server') {
			return json(response, { issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`,
				response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
		}
		if (request.url === '/token') {
			assert.equal(request.headers['x-fixture'], undefined);
			const body = new URLSearchParams(await readBody(request));
			assert.equal(body.get('code'), 'code-123');
			assert.equal(createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url'), expectedChallenge);
			return json(response, { access_token: token, token_type: 'Bearer', refresh_token: 'oauth-fixture-refresh' });
		}
		if (request.headers.authorization !== `Bearer ${token}`) {
			response.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource"` }).end();
			return;
		}
		if (request.method === 'GET') { response.writeHead(405).end(); return; }
		const { id, method } = JSON.parse(await readBody(request)) as RPC;
		if (id === undefined) { response.writeHead(202).end(); return; }
		json(response, reply(id, method === 'initialize' ? initialize : { tools }));
	});
	const { connection, oauth } = connect(t, { type: 'http', url: `${url}/mcp`, oauthClientId: 'fixture-client',
		oauthScopes: ['test:read'], secrets: { headers: { 'x-fixture': 'same-origin-only' } } }, {
		openBrowser(address) {
			browser = (async () => {
				const authorization = new URL(address);
				assert.equal(authorization.searchParams.get('client_id'), 'fixture-client');
				assert.equal(authorization.searchParams.get('scope'), 'test:read');
				expectedChallenge = authorization.searchParams.get('code_challenge');
				assert.ok(expectedChallenge);
				const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
				assert.equal(callback.hostname, '127.0.0.1');
				callback.searchParams.set('code', 'code-123');
				callback.searchParams.set('state', 'wrong-state');
				const wrong = await nodeFetch(callback);
				assert.equal(wrong.status, 400);
				await wrong.body?.cancel();
				callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
				const result = await nodeFetch(callback);
				assert.equal(result.status, 200);
				await result.text();
			})();
		},
	});
	await assert.rejects(connection.start(), McpAuthRequiredError);
	assert.equal(Boolean(browser), false);
	assert.equal((await connection.login()).tools[0]?.name, 'echo');
	await browser;
	assert.match(oauth.read() ?? '', /oauth-fixture-token/);
	assert.equal(connection.redact(token), '[已隐藏]');
});
