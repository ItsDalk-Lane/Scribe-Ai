import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import type { App } from 'obsidian';
import type { CredentialStore, Provider } from '@earendil-works/pi-ai';
import { createProvider } from '@earendil-works/pi-ai';
import * as openAI from '@earendil-works/pi-ai/api/openai-completions';
import * as google from '@earendil-works/pi-ai/api/google-generative-ai';
import { createCredentialStore } from '../credentials';
import { diagnostics } from '../diagnostics';
import { createNodeFetch, nodeFetch } from '../nodeFetch';
import { createModelService } from '../providers';
import { configureProxy } from '../proxy';
import type { CommunicationSettings, Transport } from '../../types';

let baseUrl = '';
let proxyUrl = '';
let openAIBody: Record<string, unknown> = {};
let openAIAuthorization = '';
const server = http.createServer((request, response) => {
	void (async () => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
		const body = Buffer.concat(chunks).toString('utf8');
		const url = request.url ?? '';
		if (url === '/gzip') {
			const compressed = gzipSync(JSON.stringify({ ok: true }));
			response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
			response.write(compressed.subarray(0, 5));
			response.end(compressed.subarray(5));
			return;
		}
		if (url === '/redirect') {
			response.writeHead(302, { location: '/final' }).end();
			return;
		}
		if (url === '/redirect-post') {
			response.writeHead(303, { location: '/echo-method' }).end();
			return;
		}
		if (url === '/redirect-cross') {
			response.writeHead(302, { location: `${proxyUrl}/cross` }).end();
			return;
		}
		if (url === '/first-byte') {
			const timer = setTimeout(() => response.end('late headers'), 150);
			response.on('close', () => clearTimeout(timer));
			return;
		}
		if (url === '/echo-method') {
			response.setHeader('content-type', 'application/json').end(JSON.stringify({ method: request.method, body }));
			return;
		}
		if (url === '/final') {
			response.end('redirected');
			return;
		}
		if (url === '/idle') {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.write('first');
			const timer = setTimeout(() => response.end('late'), 150);
			response.on('close', () => clearTimeout(timer));
			return;
		}
		if (url === '/abort') return;
		if (url === '/openai/chat/completions') {
			openAIBody = JSON.parse(body) as Record<string, unknown>;
			openAIAuthorization = String(request.headers.authorization ?? '');
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking' }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{"city":"Shenzhen"}' } }] }, finish_reason: null }] })}\n\n`);
			response.end(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
			return;
		}
		if (url.startsWith('/v1beta/models/test-model:streamGenerateContent')) {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello from Google' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } })}\n\n`);
			return;
		}
		response.writeHead(404).end();
	})().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
});
const proxy = http.createServer((request, response) => {
	response.setHeader('content-type', 'application/json');
	if (request.url === '/cross') {
		response.end(JSON.stringify({ authorization: request.headers.authorization ?? '' }));
		return;
	}
	response.end(JSON.stringify({ proxied: request.url === 'http://scribe.test/resource' }));
});

void test.before(async () => {
	server.listen(0, '127.0.0.1');
	proxy.listen(0, '127.0.0.1');
	await Promise.all([once(server, 'listening'), once(proxy, 'listening')]);
	baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
});

void test.after(async () => {
	server.close();
	proxy.close();
	await Promise.all([once(server, 'close'), once(proxy, 'close')]);
});

void test('node fetch streams and decompresses responses', async () => {
	const fetch = createNodeFetch(() => undefined);
	const response = await fetch(`${baseUrl}/gzip`);
	assert.ok(response.body instanceof ReadableStream);
	assert.deepEqual(await response.json(), { ok: true });
	assert.equal(response.headers.get('content-encoding'), null);
});

void test('node fetch follows redirects and drops POST bodies on 303', async () => {
	const fetch = createNodeFetch(() => undefined);
	assert.equal(await (await fetch(`${baseUrl}/redirect`)).text(), 'redirected');
	const response = await fetch(`${baseUrl}/redirect-post`, { method: 'POST', body: 'payload' });
	assert.deepEqual(await response.json(), { method: 'GET', body: '' });
	const cross = await fetch(`${baseUrl}/redirect-cross`, { headers: { authorization: 'Bearer secret' } });
	assert.deepEqual(await cross.json(), { authorization: '' });
});

void test('node fetch enforces first-byte timeout', async () => {
	const fetch = createNodeFetch(() => undefined, { timeouts: { firstByteMs: 20 } });
	await assert.rejects(fetch(`${baseUrl}/first-byte`), /First-byte timeout/);
});

void test('node fetch enforces stream idle timeout', async () => {
	const fetch = createNodeFetch(() => undefined, { timeouts: { streamIdleMs: 20 } });
	const response = await fetch(`${baseUrl}/idle`);
	await assert.rejects(response.text(), /Stream idle timeout/);
});

void test('node fetch aborts the socket', async () => {
	const fetch = createNodeFetch(() => undefined);
	const controller = new AbortController();
	const pending = fetch(`${baseUrl}/abort`, { signal: controller.signal });
	setTimeout(() => controller.abort(new Error('stop test')), 10);
	await assert.rejects(pending, /stop test/);
});

void test('configured HTTP proxy handles the request', async () => {
	configureProxy({ proxyUrl, systemProxy: false });
	try {
		const response = await nodeFetch('http://scribe.test/resource');
		assert.deepEqual(await response.json(), { proxied: true });
		assert.equal(diagnostics.list().at(-1)?.proxy, 'configured');
	} finally {
		configureProxy({ proxyUrl: '', systemProxy: false });
	}
});

void test('SecretStorage credentials preserve raw keys and serialize OAuth updates', async () => {
	const values = new Map<string, string>([['scribe-ai-openai', 'sk-test']]);
	const app = {
		secretStorage: {
			getSecret: (id: string) => values.get(id) ?? null,
			setSecret: (id: string, value: string) => values.set(id, value),
			listSecrets: () => [...values.keys()],
		},
	} as unknown as App;
	const settings: CommunicationSettings = { credentialIds: {}, proxyUrl: '' };
	const store = createCredentialStore(app, settings);
	assert.deepEqual(await store.read('openai'), { type: 'api_key', key: 'sk-test' });
	values.set('scribe-ai-openai', JSON.stringify({ type: 'oauth', refresh: 'r', access: 'a', expires: 0 }));
	await Promise.all([
		store.modify('openai', async (current) => {
			assert.equal(current?.type, 'oauth');
			return { ...current, expires: 1 };
		}),
		store.modify('openai', async (current) => {
			assert.equal(current?.type, 'oauth');
			return { ...current, expires: current.expires + 1 };
		}),
	]);
	assert.equal((await store.read('openai'))?.type, 'oauth');
	assert.equal(JSON.stringify(settings).includes('sk-test'), false);
});

const credentials: CredentialStore = {
	read: async () => ({ type: 'api_key', key: 'test-key' }),
	list: async () => [],
	modify: async (_provider, fn) => fn({ type: 'api_key', key: 'test-key' }),
	delete: async () => {},
};
const transport: Transport = {
	fetch: nodeFetch,
	configure: () => {},
	onStatus: () => () => {},
	logs: () => [],
};

function testProvider(api: 'openai-completions' | 'google-generative-ai'): Provider {
	const id = api === 'openai-completions' ? 'test-openai' : 'test-google';
	const providerBaseUrl = api === 'openai-completions' ? `${baseUrl}/openai` : `${baseUrl}/v1beta`;
	return createProvider({
		id,
		name: id,
		baseUrl: providerBaseUrl,
		auth: { apiKey: { name: 'Test key', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key } }) } },
		models: [{ id: 'test-model', name: 'Test model', provider: id, baseUrl: providerBaseUrl, api, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		api: api === 'openai-completions' ? openAI : google,
	});
}

void test('OpenAI SDK uses the unified transport and normalizes tool calls', async () => {
	const service = createModelService(credentials, transport, [testProvider('openai-completions')]);
	const stream = service.stream({
		providerId: 'test-openai', model: 'test-model', messages: [{ role: 'user', content: 'Check weather' }],
		tools: [{ name: 'weather', description: 'Check weather', inputSchema: { type: 'object' } }],
	});
	const eventTypes: string[] = [];
	for await (const event of stream) eventTypes.push(event.type);
	const result = await stream.result();
	assert.equal(result.content, 'Checking');
	assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'weather', input: { city: 'Shenzhen' } }]);
	assert.equal(result.stopReason, 'tool-calls');
	assert.equal(openAIAuthorization, 'Bearer test-key');
	assert.ok(openAIBody.tools);
	assert.ok(eventTypes.includes('text_delta'));
	assert.ok(eventTypes.includes('toolcall_end'));
	assert.equal(eventTypes.at(-1), 'done');
});

void test('Google SDK uses Node fetch without touching global fetch', async () => {
	const service = createModelService(credentials, transport, [testProvider('google-generative-ai')]);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.reject(new Error('Global fetch was used'));
	try {
		const result = await service.send({ providerId: 'test-google', model: 'test-model', messages: [{ role: 'user', content: 'Hello' }], tools: [] });
		assert.equal(result.content, 'Hello from Google');
	} finally {
		globalThis.fetch = originalFetch;
	}
});
