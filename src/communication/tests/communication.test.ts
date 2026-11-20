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
import * as bedrock from '@earendil-works/pi-ai/api/bedrock-converse-stream';
import { createCredentialStore } from '../credentials';
import { diagnostics } from '../diagnostics';
import { modelRequestConfirmation } from '../modelRequestConfirmation';
import { createNodeFetch, modelNodeFetch, nodeFetch } from '../nodeFetch';
import { createModelService } from '../providers';
import { conversationMetrics } from '../../interaction/chatMetrics';
import { providerCategory } from '../../interaction/providerCategories';
import { groupProviders } from '../../interaction/providerGroups';
import { providerIcon } from '../../interaction/providerIcons';
import { applyModelDraft } from '../../interaction/modelDraft';
import { normalizeSettings } from '../../orchestration/settings/defaults';
import { chatModelKey, updateChatThinking } from '../../orchestration/settings/thinking';
import { configureProxy } from '../proxy';
import type { CommunicationSettings, Transport } from '../../types';

let baseUrl = '';
let proxyUrl = '';
let openAIBody: Record<string, unknown> = {};
let openAIAuthorization = '';
let mirroredPath = '';
let mirroredAuthorization = '';
let crossOriginRequests = 0;
const redirectedModelBodies: string[] = [];
const confirmedRequestBodies: string[] = [];
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
		if (url === '/redirect-same-origin') {
			response.writeHead(307, { location: '/echo-method' }).end();
			return;
		}
		if (url === '/redirect-cross') {
			response.writeHead(302, { location: `${proxyUrl}/cross` }).end();
			return;
		}
		if (url === '/redirect-cross-post') {
			response.writeHead(307, { location: `${proxyUrl}/cross` }).end();
			return;
		}
		if (url.startsWith('/redirect-model/')) {
			redirectedModelBodies.push(body);
			response.writeHead(307, { location: `${proxyUrl}/cross` }).end();
			return;
		}
		if (url.startsWith('/confirmed-request?')) {
			confirmedRequestBodies.push(body);
			response.end('ok');
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
		if (url.startsWith('/anthropic/')) {
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
			response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
			response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OAuth OK"}}\n\n');
			response.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
			response.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n');
			response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
			return;
		}
		if (url === '/openai/chat/completions') {
			openAIBody = JSON.parse(body) as Record<string, unknown>;
			openAIAuthorization = String(request.headers.authorization ?? '');
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking' }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{"city":"Shenzhen"}' } }] }, finish_reason: null }] })}\n\n`);
			response.end(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
			return;
		}
		if (url === '/reported-usage/chat/completions') {
			const { model } = JSON.parse(body) as { model: string };
			const prompt = model === 'with-zero' ? 0 : 810;
			const usage = model === 'output-only' ? { completion_tokens: 42 } : {
				prompt_tokens: prompt, completion_tokens: 42,
				prompt_tokens_details: {
					cached_tokens: prompt ? 800 : 0,
					...(model === 'with-cache-read' ? {} : { cache_write_tokens: prompt ? 2 : 0 }),
				},
			};
			const chunk = { id: 'chat-usage-test', object: 'chat.completion.chunk', created: 1, model };
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] })}\n\n`);
			response.end(`data: ${JSON.stringify({ ...chunk, choices: [], usage })}\n\ndata: [DONE]\n\n`);
			return;
		}
		if (url === '/scan/models') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ id: 'scanned-1' }, { id: 'scanned-2' }] }));
			return;
		}
		if (url === '/protected/v1/models') {
			if (request.headers.authorization !== 'Bearer test-key') {
				response.writeHead(401).end();
				return;
			}
			response.setHeader('content-type', 'application/json').end(JSON.stringify({ data: [{ id: 'local-model' }] }));
			return;
		}
		if (url === '/mirror/chat/completions' || url === '/protected/v1/chat/completions') {
			mirroredPath = url;
			mirroredAuthorization = String(request.headers.authorization ?? '');
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write(`data: ${JSON.stringify({ id: 'chat-mirror', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Mirrored' }, finish_reason: null }] })}\n\n`);
			response.end(`data: ${JSON.stringify({ id: 'chat-mirror', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
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
		crossOriginRequests++;
		request.resume();
		response.end('{}');
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
	const sameOrigin = await fetch(`${baseUrl}/redirect-same-origin`, { method: 'POST', body: 'payload' });
	assert.deepEqual(await sameOrigin.json(), { method: 'POST', body: 'payload' });
});

void test('node fetch does not contact a different origin when following redirects', async () => {
	const fetch = createNodeFetch(() => undefined);
	await assert.rejects(fetch(`${baseUrl}/redirect-cross`), /Cross-origin redirect blocked/);
	await assert.rejects(fetch(`${baseUrl}/redirect-cross-post`, {
		method: 'POST',
		headers: { authorization: 'Bearer test-value', 'x-api-key': 'test-value' },
		body: 'temporary model request',
	}), /Cross-origin redirect blocked/);
	const manual = await fetch(`${baseUrl}/redirect-cross-post`, { redirect: 'manual' });
	assert.equal(manual.status, 307);
	await manual.body?.cancel();
	await assert.rejects(fetch(`${baseUrl}/redirect-cross`, { redirect: 'error' }), /Redirect rejected/);
	assert.equal(crossOriginRequests, 0);
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
	const settings: CommunicationSettings = {
		credentialIds: { openai: 'scribe-ai-openai' }, proxyUrl: '', providerNames: {}, baseUrls: {}, protocols: {},
	};
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
	values.set('new-link', 'different-key');
	const earlier = store.modify('openai', () => {
		settings.credentialIds.openai = 'new-link';
		return Promise.resolve({ type: 'api_key', key: 'must-not-be-written' });
	});
	const queued = store.modify('openai', () => assert.fail('A queued refresh must not see a replacement credential'));
	await Promise.all([earlier, queued].map((pending) => assert.rejects(pending, /Credential link is missing or changed/)));
	assert.equal(values.get('new-link'), 'different-key');
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

function testProvider(api: 'openai-completions' | 'google-generative-ai', reasoning = false): Provider {
	const id = api === 'openai-completions' ? 'test-openai' : 'test-google';
	const providerBaseUrl = api === 'openai-completions' ? `${baseUrl}/openai` : `${baseUrl}/v1beta`;
	return createProvider({
		id,
		name: id,
		baseUrl: providerBaseUrl,
		auth: { apiKey: { name: 'Test key', resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key } }) } },
		models: [{ id: 'test-model', name: 'Test model', provider: id, baseUrl: providerBaseUrl, api, reasoning, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		api: api === 'openai-completions' ? openAI : google,
	});
}

void test('OAuth login persists credentials and exposes subscription metadata', async () => {
	const values = new Map([['shared-key', 'shared-api-key']]);
	const app = { secretStorage: {
		getSecret: (id: string) => values.get(id) ?? null,
		setSecret: (id: string, value: string) => values.set(id, value),
	} } as unknown as App;
	const settings: CommunicationSettings = {
		credentialIds: { 'test-oauth': 'shared-key' }, proxyUrl: '', providerNames: {}, baseUrls: {}, protocols: {},
	};
	const store = createCredentialStore(app, { ...settings, credentialIds: { 'test-oauth': 'new-oauth-slot' } });
	const provider = createProvider({
		id: 'test-oauth',
		name: 'Test OAuth',
		baseUrl: `${baseUrl}/openai`,
		auth: {
			oauth: {
				name: 'Test subscription',
				isSubscription: true,
				login: async () => ({ type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000 }),
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		models: [{ id: 'test-model', name: 'Test model', provider: 'test-oauth', baseUrl: `${baseUrl}/openai`, api: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		api: openAI,
	});
	const service = createModelService(store, transport, { additionalProviders: [provider] });
	const credential = await service.login('test-oauth', { prompt: async () => '', notify: () => {} });
	assert.equal(credential.type, 'oauth');
	assert.deepEqual(await store.read('test-oauth'), credential);
	assert.deepEqual(await createCredentialStore(app, settings).read('test-oauth'), { type: 'api_key', key: 'shared-api-key' });
	assert.deepEqual(service.providers().find((entry) => entry.id === 'test-oauth')?.oauth, { subscription: true });
});

void test('Bundled OAuth flows derive Anthropic request auth without import.meta.url', async () => {
	const store: CredentialStore = {
		read: async () => ({ type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3_600_000 }),
		list: async () => [],
		modify: async () => { throw new Error('Unexpected token refresh'); },
		delete: async () => {},
	};
	const service = createModelService(store, transport, { baseUrls: () => ({ anthropic: `${baseUrl}/anthropic` }) });
	const model = service.providers().find((provider) => provider.id === 'anthropic')?.models[0];
	assert.ok(model);
	const response = await service.send({ providerId: 'anthropic', model: model.id, messages: [{ role: 'user', content: 'hi' }], tools: [] });
	assert.equal(response.content, 'OAuth OK');
});

void test('OpenAI SDK uses the unified transport and normalizes tool calls', async () => {
	const service = createModelService(credentials, transport, { additionalProviders: [testProvider('openai-completions')] });
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

void test('OpenAI, Google and Bedrock wait for the actual address to be confirmed before sending', async () => {
	const endpoint = `${baseUrl}/redirect-model`;
	const bedrockProvider = createProvider({
		id: 'test-bedrock',
		name: 'Test Bedrock',
		baseUrl: endpoint,
		auth: { apiKey: { name: 'Test key', resolve: async () => ({
			auth: { apiKey: 'test-key' },
			env: { AWS_BEDROCK_FORCE_HTTP1: '1', AWS_REGION: 'us-east-1' },
		}) } },
		models: [{ id: 'test-model', name: 'Test model', provider: 'test-bedrock', baseUrl: endpoint,
			api: 'bedrock-converse-stream', reasoning: false, input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		api: bedrock,
	});
	const providers = [testProvider('openai-completions'), testProvider('google-generative-ai'), bedrockProvider];
	const service = createModelService(credentials, transport, {
		additionalProviders: providers,
		baseUrls: () => Object.fromEntries(providers.map(({ id }) => [id, endpoint])),
	});
	for (const { id } of providers) {
		const prompt = `Temporary request for ${id}`;
		const rejection = new Error('本地测试拒绝发送');
		const addresses: string[] = [];
		const request = {
			providerId: id, model: 'test-model', messages: [{ role: 'user' as const, content: prompt }],
			tools: [], maxRetries: 0,
		};
		await assert.rejects(service.send({
			...request, signal: AbortSignal.timeout(3_000),
			beforeSend: async (address) => {
				addresses.push(address);
				throw rejection;
			},
		}), (error: unknown) => error === rejection);
		assert.equal(redirectedModelBodies.some((body) => body.includes(prompt)), false, `${id} sent before approval`);
		assert.equal(addresses.length, 1);
		await assert.rejects(service.send({
			...request, signal: AbortSignal.timeout(3_000),
			beforeSend: async (address) => { assert.equal(address, addresses[0]); },
		}));
		assert.ok(redirectedModelBodies.some((body) => body.includes(prompt)), `${id} did not reach the mock model endpoint`);
		assert.match(addresses[0] ?? '', /^http:\/\/127\.0\.0\.1:\d+\/redirect-model\/.+/);
		assert.doesNotMatch(addresses[0] ?? '', /[?#]/);
		assert.equal(crossOriginRequests, 0);
	}
});

void test('resume confirmation shows the actual request URL after an OAuth address override', async () => {
	const provider = createProvider({
		id: 'test-confirm-oauth',
		name: 'Test OAuth',
		baseUrl: `${baseUrl}/openai`,
		auth: { oauth: {
			name: 'Test OAuth',
			login: async () => { throw new Error('Unexpected login'); },
			refresh: async (credential) => credential,
			toAuth: async () => ({ apiKey: 'mock-session-key', baseUrl: `${baseUrl}/mirror` }),
		} },
		models: [{ id: 'test-model', name: 'Test model', provider: 'test-confirm-oauth', baseUrl: `${baseUrl}/openai`,
			api: 'openai-completions', reasoning: false, input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		api: openAI,
	});
	const oauthCredentials: CredentialStore = {
		...credentials,
		read: async () => ({ type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3_600_000 }),
	};
	const service = createModelService(oauthCredentials, transport, { additionalProviders: [provider] });
	mirroredPath = '';
	const result = await service.send({
		providerId: 'test-confirm-oauth', model: 'test-model', messages: [{ role: 'user', content: 'Local test' }],
		tools: [], maxRetries: 0, signal: AbortSignal.timeout(3_000),
		beforeSend: async (address) => {
			assert.equal(mirroredPath, '');
			assert.equal(address, `${baseUrl}/mirror/chat/completions`);
		},
	});
	assert.equal(result.content, 'Mirrored');
	assert.equal(mirroredPath, '/mirror/chat/completions');
});

void test('every repeated send checks the confirmed address and hidden URL changes are blocked', async () => {
	const address = `${baseUrl}/confirmed-request`;
	const shown: string[] = [];
	const beforeSend = async (destination: string) => { shown.push(destination); };
	const send = (query: string, body: string) => modelRequestConfirmation.run(
		{ beforeSend, controller: new AbortController() },
		() => modelNodeFetch(`${address}?route=${query}`, { method: 'POST', body }),
	);
	await (await send('mock-route-one', 'one')).text();
	await (await send('mock-route-one', 'two')).text();
	await assert.rejects(send('mock-route-two', 'unconfirmed'), /地址参数已变更/);
	assert.deepEqual(shown, [address, address]);
	assert.deepEqual(confirmedRequestBodies, ['one', 'two']);
});

void test('provider usage distinguishes real zeros, reported totals and missing input', async () => {
	const providerId = 'usage-test';
	const service = createModelService(credentials, transport, {
		customProviders: () => [{ id: providerId, label: 'Usage fixture', baseUrl: `${baseUrl}/reported-usage`,
			protocol: 'openai-completions', models: ['with-counts', 'with-cache-read', 'output-only', 'with-zero'] }],
	});
	async function measure(model: string) {
		const response = await service.send({ providerId, model, messages: [], tools: [] });
		const metrics = conversationMetrics([{ taskId: model, turn: 1, status: 'done', pendingCalls: [], messages: [{
			role: 'assistant', content: response.content, usage: response.usage, reportedUsage: response.reportedUsage,
			metrics: { endedAt: 10, modelMs: 1000, decodeMs: 500, contextWindow: 1000 },
		}] }]);
		return { report: response.reportedUsage, metrics };
	}
	const complete = await measure('with-counts');
	assert.deepEqual(complete.report, { input: 8, cacheRead: 800, cacheWrite: 2, prompt: 810, output: 42 });
	assert.deepEqual(complete.metrics.context, { prompt: 810, capacity: 1000, remaining: 190, percent: 81 });
	assert.equal(complete.metrics.usage?.total, 852);
	const withCacheRead = await measure('with-cache-read');
	assert.deepEqual(withCacheRead.report, { prompt: 810, cacheRead: 800, output: 42 });
	assert.equal(withCacheRead.metrics.usage?.input, 10);
	assert.equal(withCacheRead.metrics.usage?.cacheWrite, undefined);
	assert.equal(withCacheRead.metrics.usage?.total, 852);
	const partial = await measure('output-only');
	assert.deepEqual(partial.report, { output: 42 });
	assert.equal(partial.metrics.context, undefined);
	assert.equal(partial.metrics.usage?.total, undefined);
	assert.equal(partial.metrics.usage?.input, undefined);
	assert.equal(partial.metrics.usage?.cacheRead, undefined);
	assert.equal(partial.metrics.usage?.cacheWrite, undefined);
	assert.equal(partial.metrics.usage?.output, 42);
	assert.equal(partial.metrics.speed, 84);
	const zero = await measure('with-zero');
	assert.equal(zero.metrics.context?.percent, 0);
	assert.equal(zero.metrics.usage?.input, 0);
	assert.equal(zero.metrics.usage?.hit, undefined);
});

void test('Base URL override is used for every model of the provider', async () => {
	const service = createModelService(credentials, transport, {
		additionalProviders: [testProvider('openai-completions')],
		baseUrls: () => ({ 'test-openai': `${baseUrl}/mirror` }),
	});
	const result = await service.send({
		providerId: 'test-openai', model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: [],
	});
	assert.equal(result.content, 'Mirrored');
	assert.equal(mirroredPath, '/mirror/chat/completions');
});

void test('Provider catalog reports its built-in protocol', () => {
	const service = createModelService(credentials, transport, { additionalProviders: [testProvider('openai-completions')] });
	const provider = service.providers().find((entry) => entry.id === 'test-openai');
	assert.equal(provider?.protocol, 'openai-completions');
	assert.ok(provider?.protocols.includes('openai-completions'));
	assert.ok((provider?.protocols.length ?? 0) > 1);
});

void test('Protocol override switches the adapter for every model of the provider', async () => {
	// test-google 自带 google-generative-ai；切成 openai-completions 后请求打到 /chat/completions（服务器没有该路径）
	const service = createModelService(credentials, transport, {
		additionalProviders: [testProvider('google-generative-ai')],
		protocols: () => ({ 'test-google': 'openai-completions' }),
	});
	// 自带 google-generative-ai，切成 openai-completions 后请求路径变成 /chat/completions（服务器没有该路径）
	await assert.rejects(async () => {
		await service.send({ providerId: 'test-google', model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: [] });
	}, /404/);
});

void test('Google SDK uses Node fetch without touching global fetch', async () => {
	const service = createModelService(credentials, transport, { additionalProviders: [testProvider('google-generative-ai')] });
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.reject(new Error('Global fetch was used'));
	try {
		const result = await service.send({ providerId: 'test-google', model: 'test-model', messages: [{ role: 'user', content: 'Hello' }], tools: [] });
		assert.equal(result.content, 'Hello from Google');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

void test('Model override base URL wins over the provider base URL', async () => {
	const service = createModelService(credentials, transport, {
		additionalProviders: [testProvider('openai-completions')],
		baseUrls: () => ({ 'test-openai': `${baseUrl}/provider` }),
		modelOverrides: () => ({ 'test-openai': { 'test-model': { baseUrl: `${baseUrl}/mirror` } } }),
	});
	const result = await service.send({
		providerId: 'test-openai', model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: [],
	});
	assert.equal(result.content, 'Mirrored');
	assert.equal(mirroredPath, '/mirror/chat/completions');
});

void test('Model override protocol switches only through the model api', async () => {
	const service = createModelService(credentials, transport, {
		additionalProviders: [testProvider('google-generative-ai')],
		modelOverrides: () => ({ 'test-google': { 'test-model': { protocol: 'openai-completions' } } }),
	});
	await assert.rejects(async () => {
		await service.send({ providerId: 'test-google', model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: [] });
	}, /404/);
});

void test('Custom providers register themselves with fallback metadata', () => {
	const service = createModelService(credentials, transport, {
		customProviders: () => [{
			id: 'custom-1', label: 'My endpoint', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai-completions', models: ['my-model'],
		}],
	});
	const provider = service.providers().find((entry) => entry.id === 'custom-1');
	assert.ok(provider);
	assert.equal(provider?.label, 'My endpoint');
	assert.equal(provider?.models.length, 1);
	assert.equal(provider?.models[0]?.contextWindow, 128000);
	assert.equal(provider?.models[0]?.maxTokens, 8000);
	assert.deepEqual(provider?.models[0]?.input, ['text']);
	assert.equal(provider?.models[0]?.reasoning, false);
	assert.deepEqual(provider?.models[0]?.thinkingLevels, []);
});

void test('Bailian Token Plan and pay-as-you-go register with catalog metadata', () => {
	const service = createModelService(credentials, transport, {});
	const tokenPlan = service.providers().find((entry) => entry.id === 'bailian-token-plan');
	const payg = service.providers().find((entry) => entry.id === 'bailian-payg');
	assert.ok(tokenPlan && payg);
	// Token Plan 默认仅包含个人版/团队版共同支持的模型，并补上官方预览模型
	assert.equal(tokenPlan?.models.length, 9);
	assert.ok(!tokenPlan?.models.some((model) => model.id === 'kimi-k2.5'));
	assert.ok(!tokenPlan?.models.some((model) => model.id === 'qwen3.6-plus'));
	const deepseek = tokenPlan?.models.find((model) => model.id === 'deepseek-v4-pro');
	assert.equal(deepseek?.contextWindow, 1000000);
	assert.equal(deepseek?.maxTokens, 384000);
	const preview = tokenPlan?.models.find((model) => model.id === 'qwen4-max-preview');
	assert.equal(preview?.contextWindow, 1000000);
	assert.equal(preview?.maxTokens, 393216);
	assert.deepEqual(preview?.thinkingLevels, ['low', 'medium', 'xhigh']);
	assert.ok(!tokenPlan?.models.some((model) => model.id === 'qwen4-max'));
	// 按量付费限定了模型子集，不包含 Token Plan 独有的会员模型
	assert.equal(payg?.models.length, 13);
	assert.ok(payg?.models.some((model) => model.id === 'qwen3.8-max'));
	assert.ok(!payg?.models.some((model) => model.id === 'kimi-k2.5'));
	const qwen4 = payg?.models.find((model) => model.id === 'qwen4-max');
	assert.equal(qwen4?.contextWindow, 1000000);
	assert.equal(qwen4?.maxTokens, 262144);
	assert.deepEqual(qwen4?.input, ['text', 'image']);
	assert.deepEqual(qwen4?.thinkingLevels, ['low', 'medium', 'high', 'xhigh']);
	// Coding Plan 只能用它自己的 6 个精确模型，且模型列表不能通过接口查询
	const coding = service.providers().find((entry) => entry.id === 'bailian-coding-plan');
	assert.equal(coding?.models.length, 6);
	const qwen35 = coding?.models.find((model) => model.id === 'qwen3.5-plus');
	assert.equal(qwen35?.contextWindow, 1000000);
	assert.equal(qwen35?.maxTokens, 65536);
	assert.deepEqual(qwen35?.input, ['text', 'image']);
	assert.ok(!coding?.models.some((model) => model.id === 'qwen3.8-max'));
});

void test('Explicit Bailian models keep Qwen request compatibility', async () => {
	const service = createModelService(credentials, transport, {
		baseUrls: () => ({ 'bailian-payg': `${baseUrl}/openai` }),
	});
	await service.send({
		providerId: 'bailian-payg', model: 'qwen4-max', reasoning: 'low',
		messages: [{ role: 'user', content: 'hi' }], tools: [],
	});
	assert.equal(openAIBody.enable_thinking, true);
	assert.equal(openAIBody.reasoning_effort, 'low');
});

void test('Volcengine providers register with full pi catalog metadata', () => {
	const service = createModelService(credentials, transport, {});
	const ids = ['volcengine-agent-plan', 'volcengine-coding-plan', 'volcengine-doubao'];
	const providers = ids.map((id) => service.providers().find((entry) => entry.id === id));
	for (const provider of providers) {
		assert.ok(provider, 'missing volcengine provider');
		assert.equal(provider?.protocol, 'openai-completions');
		assert.ok(provider?.models.length);
	}
	const doubao = providers[2]?.models[0];
	assert.equal(doubao?.id, 'doubao-seed-2-1-pro-260915');
	assert.equal(doubao?.contextWindow, 128000);
	// 兜底是 8K；这里必须保留目录给出的 16K
	assert.equal(doubao?.maxTokens, 16384);
	assert.deepEqual(doubao?.input, ['text', 'image']);
	assert.equal(doubao?.reasoning, false);
	const plan = providers[0]?.models[0];
	assert.equal(plan?.maxTokens, 16384);
	assert.deepEqual(plan?.input, ['text']);
	assert.equal(plan?.reasoning, false);
});

void test('Recreated custom providers do not inherit old secrets and unlink stops using them', async () => {
	const values = new Map([['scribe-ai-custom-1', 'old-secret'], ['linked-key', 'new-secret']]);
	const app = { secretStorage: { getSecret: (id: string) => values.get(id) ?? null } } as unknown as App;
	const settings: CommunicationSettings = { credentialIds: {}, proxyUrl: '', providerNames: {}, baseUrls: {}, protocols: {} };
	const store = createCredentialStore(app, settings);
	const service = createModelService(store, transport, {
		customProviders: () => [{
			id: 'custom-1', label: 'Local', baseUrl: `${baseUrl}/mirror`, protocol: 'openai-completions', models: ['local-model'],
		}],
	});
	const send = () => service.send({
		providerId: 'custom-1', model: 'local-model', messages: [{ role: 'user', content: 'hi' }], tools: [],
	});
	assert.equal((await send()).content, 'Mirrored');
	assert.equal(mirroredPath, '/mirror/chat/completions');
	assert.equal(mirroredAuthorization, 'Bearer local');
	assert.deepEqual(await store.list(), []);
	settings.credentialIds['custom-1'] = 'linked-key';
	await send();
	assert.equal(mirroredAuthorization, 'Bearer new-secret');
	delete settings.credentialIds['custom-1'];
	await send();
	assert.equal(mirroredAuthorization, 'Bearer local');
	assert.equal(values.get('scribe-ai-custom-1'), 'old-secret');
});

void test('Custom model discovery authenticates and reports the working chat base URL', async () => {
	let discoveredBaseUrl = '';
	const service = createModelService(credentials, transport, {
		customProviders: () => [{ id: 'custom-1', label: 'Local', baseUrl: discoveredBaseUrl,
			protocol: 'openai-completions', models: ['local-model'] }],
	});
	assert.deepEqual(await service.listCustomModels('custom-1', `${baseUrl}/scan`), {
		models: ['scanned-1', 'scanned-2'], baseUrl: `${baseUrl}/scan`,
	});
	const found = await service.listCustomModels('custom-1', `${baseUrl}/protected`);
	assert.deepEqual(found, { models: ['local-model'], baseUrl: `${baseUrl}/protected/v1` });
	discoveredBaseUrl = found.baseUrl;
	const result = await service.send({ providerId: 'custom-1', model: 'local-model', messages: [], tools: [] });
	assert.equal(result.content, 'Mirrored');
	assert.equal(mirroredPath, '/protected/v1/chat/completions');
	assert.equal(mirroredAuthorization, 'Bearer test-key');
});

void test('Model settings control the actual tools, reasoning and output limit sent', async () => {
	const override = { capabilities: { reasoning: true, tools: false }, thinkingLevels: ['low', 'high'] as const, maxTokens: 8 };
	const service = createModelService(credentials, transport, {
		customProviders: () => [{ id: 'custom-1', label: 'Custom', baseUrl: `${baseUrl}/openai`,
			protocol: 'openai-completions', models: ['local-model'] }],
		modelOverrides: () => ({ 'custom-1': { 'local-model': { ...override, thinkingLevels: [...override.thinkingLevels] } } }),
	});
	const send = () => service.send({ providerId: 'custom-1', model: 'local-model', messages: [], reasoning: 'high', maxTokens: 16,
		tools: [{ name: 'weather', description: 'Weather', inputSchema: { type: 'object' } }],
	});
	await send();
	assert.equal(openAIBody.reasoning_effort, 'high');
	assert.equal(openAIBody.tools, undefined);
	assert.equal(openAIBody.max_completion_tokens, 8);
	override.capabilities = { reasoning: false, tools: true };
	await send();
	assert.equal(openAIBody.reasoning_effort, undefined);
	assert.ok(Array.isArray(openAIBody.tools));
});

void test('chat effort clamps to the allow-list, remembers each model, and drives the HTTP request', async () => {
	const providerId = 'effort-test';
	const first = { providerId, model: 'first-model' };
	const second = { providerId, model: 'second-model' };
	const disabled = { providerId, model: 'disabled-model' };
	const firstKey = chatModelKey(providerId, first.model);
	const secondKey = chatModelKey(providerId, second.model);
	const settings = normalizeSettings({
		...first, providerModels: { [providerId]: [first.model, second.model, disabled.model] },
		thinkingByModel: { [firstKey]: 'xhigh', [secondKey]: 'high' },
		modelOverrides: { [providerId]: {
			[first.model]: { capabilities: { reasoning: true }, thinkingLevels: ['medium', 'off', 'low', 'xhigh'] },
			[second.model]: { capabilities: { reasoning: true }, thinkingLevels: ['low', 'high'] },
			[disabled.model]: { capabilities: { reasoning: false }, thinkingLevels: ['high'] },
		} },
	});
	const service = createModelService(credentials, transport, {
		customProviders: () => [{ id: providerId, label: 'Custom', baseUrl: `${baseUrl}/openai`,
			protocol: 'openai-completions', models: settings.providerModels[providerId] ?? [] }],
		modelOverrides: () => settings.modelOverrides,
	});
	assert.deepEqual(service.thinkingOptions(first, 'xhigh'), { levels: ['medium', 'off', 'low'], level: 'medium' });
	assert.deepEqual(service.thinkingOptions(second, 'off'), { levels: ['low', 'high'], level: 'low' });
	assert.deepEqual(service.thinkingOptions(disabled).levels, []);
	settings.thinkingByModel = updateChatThinking(settings, first, service.thinkingOptions);
	assert.deepEqual(settings.thinkingByModel, { [firstKey]: 'medium', [secondKey]: 'high' });
	await service.send({ ...first, messages: [], tools: [], reasoning: settings.thinkingByModel[firstKey] });
	assert.equal(openAIBody.reasoning_effort, 'medium');
	settings.thinkingByModel = updateChatThinking(settings, { ...first, thinkingLevel: 'off' }, service.thinkingOptions);
	assert.equal(normalizeSettings(settings).thinkingByModel[firstKey], 'off');
	await service.send({ ...first, messages: [], tools: [], reasoning: settings.thinkingByModel[firstKey] });
	assert.equal(openAIBody.reasoning_effort, undefined);
	await service.send({ ...second, messages: [], tools: [], reasoning: settings.thinkingByModel[secondKey] });
	assert.equal(openAIBody.reasoning_effort, 'high');
	await service.send({ ...disabled, messages: [], tools: [], reasoning: null });
	assert.equal(openAIBody.reasoning_effort, undefined);
});

void test('optional reasoning has an off choice without setting an effort, and required reasoning ignores an old off override', async () => {
	const optional = { providerId: 'test-openai', model: 'test-model' };
	const required = { providerId: 'zai-coding-cn', model: 'glm-5.3' };
	const service = createModelService(credentials, transport, {
		additionalProviders: [testProvider('openai-completions', true)],
		baseUrls: () => ({ [required.providerId]: `${baseUrl}/openai` }),
		modelOverrides: () => ({ [required.providerId]: { [required.model]: {
			capabilities: { reasoning: false }, thinkingLevels: ['off'],
		} } }),
	});
	const options = service.thinkingOptions(optional);
	assert.equal(options.level, undefined);
	assert.equal(options.levels[0], 'off');
	await service.send({ ...optional, messages: [], tools: [], reasoning: options.level ?? null });
	assert.equal(openAIBody.reasoning_effort, undefined);
	const saved = service.thinkingOptions(required, 'high');
	assert.ok(!saved.levels.includes('off') && saved.levels.includes('high'));
	assert.equal(saved.level, 'high');
	await service.send({ ...required, messages: [], tools: [], reasoning: saved.level });
	assert.equal(openAIBody.reasoning_effort, 'high');
});

void test('new thinking settings remember custom English values and send them literally', async () => {
	const target = { providerId: 'custom-efforts', model: 'local-model' };
	const key = chatModelKey(target.providerId, target.model);
	const settings = normalizeSettings({
		...target,
		providerModels: { [target.providerId]: [target.model] },
		thinkingByModel: { [key]: 'Ultra-fast' },
		modelOverrides: { [target.providerId]: { [target.model]: {
			capabilities: { reasoning: true }, literalThinkingLevels: true,
			thinkingLevels: ['off', 'minimal', 'low', 'max', 'Ultra-fast', '中文'],
		} } },
	});
	const service = createModelService(credentials, transport, {
		customProviders: () => [{ id: target.providerId, label: 'Custom', baseUrl: `${baseUrl}/openai`,
			protocol: 'openai-completions', models: [target.model] }],
		modelOverrides: () => settings.modelOverrides,
	});
	const options = service.thinkingOptions(target, settings.thinkingByModel[key]);
	assert.deepEqual(options, { levels: ['off', 'minimal', 'low', 'max', 'Ultra-fast'], level: 'Ultra-fast' });
	await service.send({ ...target, messages: [], tools: [], reasoning: options.level });
	assert.equal(openAIBody.reasoning_effort, 'Ultra-fast');
	await service.send({ ...target, messages: [], tools: [], reasoning: 'max' });
	assert.equal(openAIBody.reasoning_effort, 'max');
});

void test('New provider model configuration updates only an isolated draft', () => {
	const originalModels = ['alpha', 'beta'];
	const originalOverrides = { alpha: { contextWindow: 64000 }, beta: { maxTokens: 8000 } };
	const next = applyModelDraft(originalModels, originalOverrides, {
		previousModel: 'alpha', model: 'renamed', override: { maxTokens: 16000 },
	});
	assert.deepEqual(next.models, ['renamed', 'beta']);
	assert.deepEqual(next.overrides, { renamed: { maxTokens: 16000 }, beta: { maxTokens: 8000 } });
	assert.deepEqual(originalModels, ['alpha', 'beta']);
	assert.deepEqual(originalOverrides, { alpha: { contextWindow: 64000 }, beta: { maxTokens: 8000 } });
	const cleared = applyModelDraft(next.models, next.overrides, {
		previousModel: 'beta', model: 'beta', override: {},
	});
	assert.deepEqual(cleared.overrides, { renamed: { maxTokens: 16000 } });
});

void test('Every built-in provider falls into one of four categories', () => {
	const service = createModelService(credentials, transport, {});
	const categories = new Set(service.providers().map((provider) => providerCategory(provider.id)));
	assert.ok(service.providers().length > 0);
	assert.deepEqual([...categories].sort(), ['aggregator', 'domestic', 'global', 'other']);
});

void test('Providers from the same vendor collapse into one group without URL duplicates', () => {
	const service = createModelService(credentials, transport, {});
	const groups = groupProviders(service.providers());
	const bailian = groups.find((group) => group.label === '阿里云百炼');
	const openai = groups.find((group) => group.label === 'OpenAI');
	// Token Plan CN / 按量付费 / Token Plan 国际；团队与个人套餐 URL 完全相同，只保留一套
	assert.equal(bailian?.providers.length, 4);
	assert.deepEqual(bailian?.providers.map((provider) => provider.id), ['bailian-token-plan', 'bailian-coding-plan', 'bailian-payg', 'qwen-token-plan']);
	assert.equal(openai?.providers.length, 2);
	const ids = groups.flatMap((group) => group.providers.map((provider) => provider.id));
	assert.ok(!ids.includes('qwen-token-plan-individual'));
	assert.ok(!ids.includes('qwen-token-plan-individual-cn'));
});

void test('Every provider group has an icon definition', () => {
	const groups = groupProviders(createModelService(credentials, transport, {}).providers());
	const missing = groups.filter((group) => !providerIcon(group.providers[0]?.id ?? group.id));
	assert.deepEqual(missing.map((group) => group.label), []);
	// 品牌 SVG 必须是内联内容，而不是只剩空壳
	assert.ok(providerIcon('openai')?.svg?.includes('<path'));
});
