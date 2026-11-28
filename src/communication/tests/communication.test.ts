import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import type { App } from 'obsidian';
import type { CredentialStore, ImageModel, Provider } from '@earendil-works/pi-ai';
import { createProvider, PI_AI_VERSION } from '@earendil-works/pi-ai';
import * as openAI from '@earendil-works/pi-ai/api/openai-completions';
import * as google from '@earendil-works/pi-ai/api/google-generative-ai';
import * as bedrock from '@earendil-works/pi-ai/api/bedrock-converse-stream';
import { createCredentialStore } from '../credentials';
import { diagnostics } from '../diagnostics';
import { createNodeFetch, modelNodeFetch, nodeFetch } from '../nodeFetch';
import { createModelService } from '../providers';
import { readProviderCatalog } from '../modelCatalog';
import { conversationMetrics } from '../../interaction/chatMetrics';
import { meteredService } from '../../orchestration/meteredService';
import { providerCategory } from '../../interaction/providerCategories';
import { groupProviders } from '../../interaction/providerGroups';
import { providerIcon } from '../../interaction/providerIcons';
import { applyModelDraft } from '../../interaction/modelDraft';
import { normalizeSettings } from '../../orchestration/settings/defaults';
import { AGENT_PLAN_PROVIDER_ID, IMAGE_MODELS } from '../../orchestration/settings/mediaSettings';
import { chatModelKey, updateChatThinking } from '../../orchestration/settings/thinking';
import { configureProxy, matchesLegacyProxy, readConfiguredProxy, storeProxyCredentials } from '../proxy';
import type { AuxiliaryUsage, CommunicationSettings, ModelUsageReceipt, Transport } from '../../types';

let baseUrl = '';
let proxyUrl = '';

void test('proxy settings persist only an endpoint and a secret bound to that endpoint', () => {
	const values = new Map<string, string>();
	const secrets = { getSecret: (id: string) => values.get(id), setSecret: (id: string, value: string) => { values.set(id, value); } };
	const address = 'socks5://account:demo-only@proxy.example:4321';
	const saved = storeProxyCredentials(address, secrets);
	assert.equal(saved.proxyUrl, 'socks5://proxy.example:4321');
	assert.doesNotMatch(JSON.stringify(saved), /demo-only|account/u);
	assert.equal(readConfiguredProxy(saved, secrets), address);
	assert.ok(matchesLegacyProxy(address, saved, secrets));
	assert.deepEqual(storeProxyCredentials(saved.proxyUrl, secrets, saved), saved);
	assert.throws(() => readConfiguredProxy({ ...saved, proxyUrl: 'socks5://other.example:4321' }, secrets), /没有匹配/u);
	assert.throws(() => readConfiguredProxy(saved), /没有匹配/u);
});
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
			response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
			response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
			response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OAuth OK"}}\n\n');
			if (url.startsWith('/anthropic/interrupt/')) return;
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
			let usage: Record<string, unknown> = {
				prompt_tokens: prompt, completion_tokens: 42,
				prompt_tokens_details: {
					cached_tokens: prompt ? 800 : 0,
					...(model === 'with-cache-read' ? {} : { cache_write_tokens: prompt ? 2 : 0 }),
				},
			};
			if (model === 'output-only') usage = { completion_tokens: 42 };
			if (model === 'total-only') usage = { total_tokens: 73 };
			const chunk = { id: 'chat-usage-test', object: 'chat.completion.chunk', created: 1, model };
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] })}\n\n`);
			response.end(`data: ${JSON.stringify({ ...chunk, choices: [], usage })}\n\ndata: [DONE]\n\n`);
			return;
		}
		if (url === '/scan/models') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ id: 'scanned-1', context_length: 16000, supported_parameters: ['tools'] }, { id: 'scanned-2' }] }));
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
		if (url.startsWith('/v1beta/models/test-model:streamGenerateContent')
			|| url.startsWith('/v1beta/publishers/google/models/test-model:streamGenerateContent')) {
			const videoReceipt = body.includes('Check receipt')
				? { promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1 }, { modality: 'VIDEO', tokenCount: 30 }] } : {};
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello from Google' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3, ...videoReceipt } })}\n\n`);
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
		createCredentialStore(app, { ...settings, credentialIds: { alternate: 'scribe-ai-openai' } }).modify('alternate', async (current) => {
			assert.equal(current?.type, 'oauth');
			assert.equal(current.expires, 1);
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

void test('the text transport rejects specialized models before any network request', async () => {
	const providerId = 'custom-media-type';
	const model = 'local-picture';
	const arkImage = IMAGE_MODELS[0];
	const overrides = normalizeSettings({ modelOverrides: {
		[providerId]: { [model]: { type: 'image' } },
		[AGENT_PLAN_PROVIDER_ID]: { [arkImage]: { type: 'text' } },
	} }).modelOverrides;
	const custom = overrides[providerId]?.[model];
	assert.ok(custom);
	let catalogType: 'text' | 'audio' | undefined;
	let sends = 0;
	const service = createModelService(credentials, { ...transport, fetch: async (...args) => {
		sends++;
		return transport.fetch(...args);
	} }, {
		baseUrls: () => ({ [AGENT_PLAN_PROVIDER_ID]: baseUrl + '/openai' }),
		modelOverrides: () => overrides,
		catalogDetails: (provider, id, address) => provider === providerId && id === model
			&& address === baseUrl + '/openai' && catalogType ? { type: catalogType } : undefined,
		customProviders: () => [{ id: providerId, label: 'Local fixture', baseUrl: baseUrl + '/openai',
			protocol: 'openai-completions', models: [model] }],
	});
	const request = { providerId, model, messages: [{ role: 'user' as const, content: 'Fixture' }], tools: [], maxRetries: 0 };
	assert.equal(service.modelType?.(providerId, model), undefined);
	assert.throws(() => service.stream(request), /无法处理文字对话/u);
	await assert.rejects(async () => service.send({ ...request, providerId: AGENT_PLAN_PROVIDER_ID, model: arkImage }), /无法处理文字对话/u);
	assert.equal(sends, 0);

	custom.type = 'text';
	await assert.rejects(service.send({ ...request, beforeSend: async () => { custom.type = 'image'; } }), /无法处理文字对话/u);
	assert.equal(sends, 0);

	custom.type = 'text';
	await assert.rejects(service.send({ ...request, beforeSend: async () => { catalogType = 'audio'; } }), /无法处理文字对话/u);
	assert.equal(sends, 0);
	assert.equal(service.modelType?.(providerId, model), 'audio');
	assert.throws(() => service.stream(request), /无法处理文字对话/u);
	catalogType = 'text';
	await assert.rejects(service.send({ ...request, onTransmission: async () => { catalogType = 'audio'; } }), /无法处理文字对话/u);
	assert.equal(sends, 0);
	custom.baseUrl = baseUrl + '/unconfirmed';
	assert.equal(service.modelType?.(providerId, model), undefined);
	delete custom.baseUrl;

	custom.type = 'image';
	catalogType = 'text';
	assert.equal(service.modelType?.(providerId, model), 'text');
	assert.equal((await service.send(request)).content, 'Checking');
	assert.equal(sends, 1);
});

void test('bundled specialized model data stays separate from the chat list and from overrides of the provider connection', async () => {
	const adapter = testProvider('openai-completions');
	const [chat] = adapter.getModels();
	assert.ok(chat);
	const image: ImageModel<'openrouter-images'> = { ...chat, id: 'fixture-picture', api: 'openrouter-images', type: 'image', output: ['image'] };
	const provider: Provider = { ...adapter, getAllModels: () => [chat, image] };
	const addresses: Record<string, string> = {};
	const service = createModelService(credentials, { ...transport, fetch: async () => new Response(null, { status: 404 }) },
		{ additionalProviders: [provider], baseUrls: () => addresses });
	assert.equal(service.modelType?.(provider.id, chat.id), 'text');
	assert.equal(service.modelType?.(provider.id, image.id), 'image');
	assert.equal(service.providers().find(({ id }) => id === provider.id)?.nonChatModelTypes?.get(image.id), 'image');

	const catalog = await service.listProviderModels(provider.id);
	assert.deepEqual(catalog.models, [chat.id]);
	assert.equal(catalog.details?.get(image.id)?.type, 'image');
	addresses[provider.id] = baseUrl + '/custom-route';
	assert.equal(service.modelType?.(provider.id, chat.id), undefined);
	assert.equal(service.modelType?.(provider.id, image.id), undefined);
});

void test('model requests wait for their own confirmation after leaving the Node async scope', async () => {
	const adapter = testProvider('openai-completions');
	// Simulate Obsidian scheduling the SDK callback outside the Node promise chain.
	const sdk = new AsyncResource('scribe-test-sdk');
	const provider: Provider = {
		...adapter,
		streamSimple: (...args) => sdk.runInAsyncScope(() => adapter.streamSimple(...args)),
	};
	const service = createModelService(credentials, transport, { additionalProviders: [provider] });
	const request = {
		providerId: provider.id, model: 'test-model', tools: [], maxRetries: 0,
		messages: [{ role: 'user' as const, content: 'Detached SDK fixture' }],
	};
	const rejected = new Error('拒绝测试请求');
	openAIBody = {};
	await assert.rejects(service.send({
		...request, signal: AbortSignal.timeout(3_000),
		beforeSend: async () => { throw rejected; },
	}), (error: unknown) => error === rejected);
	assert.deepEqual(openAIBody, {});

	let startCheckpoint!: () => void;
	const checkpointStarted = new Promise<void>((resolve) => { startCheckpoint = resolve; });
	let finishCheckpoint!: () => void;
	const checkpointSaved = new Promise<void>((resolve) => { finishCheckpoint = resolve; });
	const result = service.send({
		...request, signal: AbortSignal.timeout(3_000),
		beforeSend: async (address) => {
			assert.equal(address, `${baseUrl}/openai/chat/completions`);
			startCheckpoint();
			await checkpointSaved;
		},
	});
	try {
		await Promise.race([checkpointStarted, result.then(() => assert.fail('请求未等检查点保存就发出了'))]);
		assert.deepEqual(openAIBody, {});
	} finally {
		finishCheckpoint();
	}
	await result;
	assert.match(JSON.stringify(openAIBody), /Detached SDK fixture/u);
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
	const pinned = createModelService(oauthCredentials, transport, {
		additionalProviders: [provider], baseUrls: () => ({ [provider.id]: baseUrl + '/openai' }),
	});
	mirroredPath = '';
	await assert.rejects(pinned.send({ providerId: provider.id, model: 'test-model', messages: [], tools: [], maxRetries: 0 }), /偏离/u);
	assert.equal(mirroredPath, '');
});

void test('every repeated send checks the confirmed address and hidden URL changes are blocked', async () => {
	const address = `${baseUrl}/confirmed-request`;
	const shown: string[] = [];
	const beforeSend = async (destination: string) => { shown.push(destination); };
	const send = (query: string, body: string) => modelNodeFetch(
		`${address}?route=${query}`, { method: 'POST', body },
		{ beforeSend, controller: new AbortController() },
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
			protocol: 'openai-completions', models: ['with-counts', 'with-cache-read', 'output-only', 'with-zero', 'total-only'] }],
	});
	async function measure(model: string) {
		const receipts: ModelUsageReceipt[] = [];
		const response = await service.send({ providerId, model, messages: [{ role: 'user', content: 'Measure this prompt.' }], tools: [] },
			(usage) => receipts.push(usage));
		const prompt = receipts[0]?.estimatedUsage?.prompt;
		assert.ok(prompt && prompt > 0);
		assert.deepEqual(receipts.slice(0, 2), [
			{ reportedUsage: {}, estimatedUsage: { prompt, total: prompt }, usageStatus: 'provisional' },
			{ reportedUsage: {}, estimatedUsage: { prompt, output: 2 }, usageStatus: 'provisional' },
		]);
		const recorded = { reportedUsage: response.reportedUsage, ...(response.estimatedUsage && { estimatedUsage: response.estimatedUsage }),
			usageStatus: response.usageStatus ?? 'final' };
		assert.deepEqual(receipts.slice(2), [
			recorded,
			{ ...recorded, cost: undefined },
		]);
		const metrics = conversationMetrics([{ taskId: model, turn: 1, status: 'done', pendingCalls: [], messages: [{
			role: 'assistant', content: response.content, usage: response.usage, reportedUsage: response.reportedUsage,
			estimatedUsage: response.estimatedUsage, usageStatus: response.usageStatus,
			metrics: { endedAt: 10, modelMs: 1000, decodeMs: 500, contextWindow: 1000 },
		}] }]);
		return { report: response.reportedUsage, estimate: response.estimatedUsage, prompt, metrics };
	}
	const complete = await measure('with-counts');
	assert.deepEqual(complete.report, { input: 8, cacheRead: 800, cacheWrite: 2, prompt: 810, output: 42 });
	assert.deepEqual(complete.metrics.context, { prompt: 810, capacity: 1000, remaining: 190, percent: 81 });
	assert.equal(complete.metrics.usage?.total, 852);
	assert.equal(complete.estimate?.prompt, undefined);
	const withCacheRead = await measure('with-cache-read');
	assert.deepEqual(withCacheRead.report, { prompt: 810, cacheRead: 800, output: 42 });
	assert.equal(withCacheRead.metrics.usage?.input, undefined);
	assert.equal(withCacheRead.metrics.usage?.cacheWrite, undefined);
	assert.equal(withCacheRead.metrics.usage?.total, 852);
	const partial = await measure('output-only');
	assert.deepEqual(partial.report, { output: 42 });
	assert.equal(partial.metrics.context, undefined);
	assert.equal(partial.metrics.usage?.prompt, partial.prompt);
	assert.equal(partial.metrics.usage?.total, partial.prompt + 42);
	assert.equal(partial.metrics.usage?.input, undefined);
	assert.equal(partial.metrics.usage?.cacheRead, undefined);
	assert.equal(partial.metrics.usage?.cacheWrite, undefined);
	assert.equal(partial.metrics.usage?.output, 42);
	assert.equal(partial.metrics.speed, 84);
	const zero = await measure('with-zero');
	assert.equal(zero.metrics.context?.percent, 0);
	assert.equal(zero.metrics.usage?.input, 0);
	assert.equal(zero.metrics.usage?.hit, undefined);
	const totalOnly = await measure('total-only');
	assert.deepEqual(totalOnly.report, { total: 73 });
	assert.equal(totalOnly.metrics.usage?.partial?.total?.value, 73);
	assert.equal(totalOnly.metrics.usage?.partial?.output?.value, 2);
});

void test('a live Anthropic usage snapshot survives stopping after text but before the final usage frame', async () => {
	const providerId = 'anthropic-usage-test';
	const service = createModelService(credentials, transport, {
		customProviders: () => [{ id: providerId, label: 'Usage fixture', baseUrl: baseUrl + '/anthropic/interrupt',
			protocol: 'anthropic-messages', models: ['claude-test'] }],
	});
	const receipts: ModelUsageReceipt[] = [];
	const stream = service.stream({ providerId, model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }],
		tools: [], maxRetries: 0, signal: AbortSignal.timeout(3_000) }, (usage) => receipts.push(usage));
	let stopped = false;
	const initial = { reportedUsage: { input: 1, output: 0 }, usageStatus: 'provisional' };
	const withText = { ...initial, estimatedUsage: { output: 3 } };
	try {
		for await (const event of stream) {
			if (event.type !== 'text_delta') continue;
			assert.equal(event.delta, 'OAuth OK');
			const prompt = receipts[0]?.estimatedUsage?.prompt;
			assert.ok(prompt && prompt > 0);
			assert.deepEqual(receipts, [{ reportedUsage: {}, estimatedUsage: { prompt, total: prompt }, usageStatus: 'provisional' }, initial, withText]);
			stopped = true;
			break;
		}
	} finally {
		stream.cancel();
	}
	assert.ok(stopped);
	await assert.rejects(stream.result());
	assert.deepEqual(receipts.at(-1), { ...withText, cost: undefined });
});

void test('auxiliary metering saves each transmitted SDK attempt and ignores a pre-send refusal', async () => {
	const providerId = 'metered-retry';
	let sends = 0;
	const model = createModelService(credentials, { ...transport, fetch: async (...args) => {
		if (++sends === 1) return Response.json({ error: { message: 'Busy' } }, { status: 503, headers: { 'retry-after-ms': '1' } });
		return transport.fetch(...args);
	} }, { customProviders: () => [{ id: providerId, label: 'Usage fixture', baseUrl: baseUrl + '/reported-usage',
		protocol: 'openai-completions', models: ['output-only'] }] });
	const records: AuxiliaryUsage[] = [];
	const previews = new Map<symbol, AuxiliaryUsage>();
	const metered = meteredService(model, 'video', async (receipt, key) => {
		records.push(receipt);
		assert.ok(previews.delete(key));
	}, (key, receipt) => { previews.set(key, receipt); });
	const request = { providerId, model: 'output-only', messages: [{ role: 'user' as const, content: 'A model request' }], tools: [], maxRetries: 1 };
	await metered.send(request);
	assert.equal(sends, 2);
	const prompt = records[0]?.estimatedUsage?.prompt;
	assert.ok(prompt && prompt > 0);
	assert.deepEqual(records, [
		{ kind: 'video', reportedUsage: {}, estimatedUsage: { prompt, total: prompt }, usageStatus: 'provisional' },
		{ kind: 'video', reportedUsage: { output: 42 }, estimatedUsage: { prompt } },
	]);
	await assert.rejects(metered.send({ ...request, beforeSend: async () => { throw new Error('未确认'); } }), /未确认/u);
	assert.equal(sends, 2);
	assert.equal(records.length, 2);
	assert.equal(previews.size, 0);
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

void test('A configured provider connection switches adapter without rewriting its model catalog', async () => {
	const service = createModelService(credentials, transport, {
		additionalProviders: [testProvider('google-generative-ai')],
		protocols: () => ({ 'test-google': 'openai-completions' }),
		baseUrls: () => ({ 'test-google': `${baseUrl}/mirror` }),
	});
	const call = (model: string) => service.send({ providerId: 'test-google', model, messages: [{ role: 'user', content: 'hi' }], tools: [] });
	const results = await Promise.all([call('test-model'), call('manually-added')]);
	assert.deepEqual(results.map((result) => result.content), ['Mirrored', 'Mirrored']);
	assert.equal(mirroredPath, '/mirror/chat/completions');
	assert.equal(service.providers().find(({ id }) => id === 'test-google')?.models[0]?.api, 'google-generative-ai');
});

void test('Google SDK uses the configured transport without touching global fetch', async () => {
	const paths: string[] = [];
	const googleTransport: Transport = {
		...transport,
		fetch: (input, init) => {
			paths.push(new URL(input instanceof Request ? input.url : input).pathname);
			return nodeFetch(input, init);
		},
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.reject(new Error('Global fetch was used'));
	try {
		for (const protocol of ['google-generative-ai', 'google-vertex']) {
			const service = createModelService(credentials, googleTransport, {
				additionalProviders: [testProvider('google-generative-ai')],
				protocols: () => ({ 'test-google': protocol }),
				baseUrls: () => ({ 'test-google': `${baseUrl}/v1beta` }),
			});
			const result = await service.send({ providerId: 'test-google', model: 'test-model', messages: [{ role: 'user', content: 'Hello' }], tools: [] });
			assert.equal(result.content, 'Hello from Google');
		}
		assert.deepEqual(paths, [
			'/v1beta/models/test-model:streamGenerateContent',
			'/v1beta/publishers/google/models/test-model:streamGenerateContent',
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

void test('Google response records provider confirmation of video input', async () => {
	const service = createModelService(credentials, transport, { additionalProviders: [testProvider('google-generative-ai')] });
	const request = { providerId: 'test-google', model: 'test-model', tools: [] };
	const normal = await service.send({ ...request, messages: [{ role: 'user', content: 'Hello' }] });
	assert.equal(normal.reportedUsage?.videoInput, undefined);
	const confirmed = await service.send({ ...request, messages: [{ role: 'user', content: 'Check receipt' }] });
	assert.equal(confirmed.reportedUsage?.videoInput, 30);
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

void test('Protocol changes cannot silently reuse an address from a different API', async () => {
	const service = createModelService(credentials, transport, {
		additionalProviders: [testProvider('google-generative-ai')],
		modelOverrides: () => ({ 'test-google': { 'test-model': { protocol: 'openai-completions' } } }),
	});
	assert.deepEqual(service.modelConnection?.('test-google', 'test-model'), {
		source: 'unresolved', api: 'openai-completions', baseUrl: '', issue: 'missing-address',
	});
	let attempted = false;
	await assert.rejects(async () => {
		await service.send({ providerId: 'test-google', model: 'test-model', messages: [{ role: 'user', content: 'hi' }], tools: [],
			beforeSend: async () => { attempted = true; } });
	}, /填写对应的请求地址/u);
	assert.equal(attempted, false);
});

void test('An unlisted model on a multi-protocol provider needs explicit evidence before sending', async () => {
	const service = createModelService(credentials, transport);
	const providerId = 'github-copilot';
	const model = 'unlisted-model-fixture';
	assert.equal(service.modelConnection?.(providerId, model).issue, 'missing-protocol');
	assert.equal(service.modelOrigin?.({ providerId, model }), undefined);
	await assert.rejects(async () => {
		await service.send({ providerId, model, messages: [], tools: [] });
	}, /无法确认此模型的 API 协议/u);
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
	assert.ok(payg?.models.some((model) => model.id === 'deepseek-v4-flash-0731'));
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

void test('MiniMax M Plan uses independent regional routes and never sends a linked pay-as-you-go key', async () => {
	const model = 'MiniMax-M3.1-Flash';
	const globalPlan = 'minimax-m-plan';
	const chinaPlan = 'minimax-m-plan-cn';
	const keys = new Map([['global-slot', 'sk-cp-global-fixture'], ['china-slot', 'sk-cp-china-fixture'], ['payg-slot', 'sk-api-payg-fixture']]);
	const app = { secretStorage: { getSecret: (id: string) => keys.get(id) ?? null } } as unknown as App;
	const settings: CommunicationSettings = { credentialIds: { [globalPlan]: 'global-slot', [chinaPlan]: 'china-slot', minimax: 'payg-slot' },
		proxyUrl: '', providerNames: {}, baseUrls: {}, protocols: {} };
	const requests: Array<{ url: string; key: string | null; model?: string }> = [];
	const service = createModelService(createCredentialStore(app, settings), {
		...transport,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.hostname === 'pi.dev' || url.hostname === 'models.dev') {
				assert.equal(request.headers.get('x-api-key'), null);
				return Response.json({});
			}
			const anthropic = url.pathname.startsWith('/anthropic/');
			const key = anthropic ? request.headers.get('x-api-key') : request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? null;
			assert.equal(request.headers.get('anthropic-version'), anthropic ? '2023-06-01' : null);
			if (url.pathname.endsWith('/models')) {
				requests.push({ url: url.href, key });
				return Response.json({ data: [{ id: model }, { id: 'MiniMax-M3' }] });
			}
			assert.equal(url.pathname, '/anthropic/v1/messages');
			const payload = JSON.parse(await request.text()) as { model: string; thinking?: { type: string } };
			assert.equal(payload.thinking?.type, 'adaptive');
			requests.push({ url: url.origin + url.pathname, key, model: payload.model });
			const events = [
				{ type: 'message_start', message: { id: 'msg-plan', type: 'message', role: 'assistant', model,
					content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
				{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
				{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'M Plan OK' } },
				{ type: 'content_block_stop', index: 0 },
				{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
				{ type: 'message_stop' },
			];
			return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
				{ headers: { 'content-type': 'text/event-stream' } });
		},
	}, { protocols: () => settings.protocols });
	const send = (providerId: string) => service.send({ providerId, model, messages: [{ role: 'user', content: 'Plan fixture' }], tools: [], maxRetries: 0 });
	for (const [providerId, origin, key] of [
		[globalPlan, 'https://api.minimax.io', 'sk-cp-global-fixture'],
		[chinaPlan, 'https://api.minimax.cn', 'sk-cp-china-fixture'],
	] as const) {
		const provider = service.providers().find(({ id }) => id === providerId);
		assert.deepEqual(provider?.models.map(({ id }) => id), [model]);
		assert.equal(provider?.models[0]?.requiresReasoning, true);
		assert.deepEqual(service.modelConnection(providerId, model), { api: 'anthropic-messages', baseUrl: `${origin}/anthropic`, source: 'catalog' });
		assert.equal((await send(providerId)).content, 'M Plan OK');
		assert.deepEqual(requests.at(-1), { url: `${origin}/anthropic/v1/messages`, key, model });
		assert.deepEqual((await service.listProviderModels(providerId)).models, [model]);
		assert.deepEqual(requests.at(-1), { url: `${origin}/anthropic/v1/models`, key });
		for (const api of ['openai-completions', 'openai-responses']) {
			settings.protocols[providerId] = api;
			assert.deepEqual(service.modelConnection(providerId, model), { api, baseUrl: `${origin}/v1`, source: 'configured' });
			const catalog = await service.listProviderModels(providerId);
			assert.deepEqual(catalog.models, [model]);
			assert.equal(catalog.details?.get(model)?.connectionProtocol, api);
			assert.deepEqual(requests.at(-1), { url: `${origin}/v1/models`, key });
		}
		delete settings.protocols[providerId];
	}
	settings.credentialIds[globalPlan] = 'payg-slot';
	const sent = requests.length;
	await assert.rejects(send(globalPlan), /API key auth failed for provider minimax-m-plan/u);
	const offlineCatalog = await service.listProviderModels(globalPlan);
	assert.equal(offlineCatalog.source, 'bundled');
	assert.deepEqual(offlineCatalog.models, [model]);
	assert.equal(requests.length, sent);
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
	const planNames = [
		'ark-code-latest', 'doubao-seed-evolving', 'doubao-seed-2.1-pro', 'doubao-seed-2.1-lite', 'doubao-seed-2.0-mini',
		'glm-5.4', 'glm-5.3', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-economy', 'deepseek-v4-flash',
		'deepseek-v4-pro', 'kimi-k2.8-preview', 'kimi-k3.1-pro',
	];
	for (const provider of providers.slice(0, 2)) {
		assert.ok(provider);
		assert.deepEqual(new Set(provider.models.map(({ id }) => id)), new Set(planNames));
		const auto = provider.models.find(({ id }) => id === 'ark-code-latest');
		assert.equal(auto?.maxTokens, 16_384);
		assert.deepEqual(auto?.input, ['text']);
		assert.equal(auto?.reasoning, false);
		const doubaoPro = provider.models.find(({ id }) => id === 'doubao-seed-2.1-pro');
		assert.equal(doubaoPro?.contextWindow, 1_024_000);
		assert.equal(doubaoPro?.maxTokens, 256_000);
		assert.deepEqual(doubaoPro?.input, ['text', 'image']);
		assert.equal(service.modelType?.(provider.id, 'doubao-embedding-vision'), 'embedding');
		assert.equal(service.modelConnection(provider.id, 'deepseek-v4.1-flash').baseUrl, provider.baseUrl);
	}
});

void test('built-in models require explicitly linked credentials and restrict HTTP to loopback', async (t) => {
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = 'synthetic-other-project-key';
	t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
	let address = baseUrl + '/mirror';
	let linked = false;
	const service = createModelService({ ...credentials, read: async () => linked ? { type: 'api_key', key: 'linked-fixture' } : undefined },
		transport, { baseUrls: () => ({ openai: address }), protocols: () => ({ openai: 'openai-completions' }) });
	const request = { providerId: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], maxRetries: 0 };
	mirroredAuthorization = '';
	await assert.rejects(service.send(request));
	assert.equal(mirroredAuthorization, '');
	linked = true;
	assert.equal((await service.send(request)).content, 'Mirrored');
	assert.equal(mirroredAuthorization, 'Bearer linked-fixture');
	address = 'http://an-offsite-gateway.invalid/v1';
	assert.equal(service.modelConnection('openai', request.model).issue, 'invalid-address');
	await assert.rejects(async () => service.send(request), /HTTPS/u);
	await assert.rejects(service.listCustomModels('openai', address), /HTTPS/u);
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
	const scanned = await service.listCustomModels('openai', `${baseUrl}/scan`);
	assert.deepEqual(scanned.models, ['scanned-1', 'scanned-2']);
	assert.equal(scanned.baseUrl, `${baseUrl}/scan`);
	assert.equal(scanned.details?.get('scanned-1')?.tools, true);
	assert.equal(scanned.details?.get('scanned-1')?.contextWindow, 16000);
	assert.deepEqual(scanned.details?.get('scanned-2'), {});
	const found = await service.listCustomModels('custom-1', `${baseUrl}/protected`);
	assert.deepEqual(found.models, ['local-model']);
	assert.equal(found.baseUrl, `${baseUrl}/protected/v1`);
	discoveredBaseUrl = found.baseUrl;
	const result = await service.send({ providerId: 'custom-1', model: 'local-model', messages: [], tools: [] });
	assert.equal(result.content, 'Mirrored');
	assert.equal(mirroredPath, '/protected/v1/chat/completions');
	assert.equal(mirroredAuthorization, 'Bearer test-key');
});

void test('Official model discovery uses the selected endpoint and falls back to Pi without the provider key', async () => {
	const urls: string[] = [];
	const service = createModelService(credentials, {
		...transport,
		fetch: async (input, init) => {
			const url = new URL(new Request(input).url);
			urls.push(url.href);
			const headers = new Headers(init?.headers);
			switch (url.origin) {
				case 'https://api.openai.com':
					assert.equal(headers.get('authorization'), 'Bearer test-key');
					return Response.json({ data: [{ id: 'new-model' }, { id: 'new-model' }] });
				case 'https://api.anthropic.com':
					assert.equal(headers.get('x-api-key'), 'test-key');
					assert.equal(headers.get('anthropic-version'), '2023-06-01');
					return new Response(null, { status: 401 });
				case 'https://pi.dev':
					assert.equal(headers.get('authorization'), null);
					assert.equal(headers.get('x-api-key'), null);
					return Response.json(url.pathname.endsWith('/anthropic') ? {
						'pi-chat': { id: 'pi-chat', type: 'chat', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
						'other-host': { id: 'other-host', type: 'chat', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://unused.example/v1' },
					} : {});
				case 'https://models.dev':
					return Response.json({});
				default:
					throw new Error(`Unexpected catalog request ${url.href}`);
			}
		},
	});
	const openai = await service.listProviderModels('openai');
	assert.deepEqual(openai.models, ['new-model']);
	assert.equal(openai.source, 'provider');
	const anthropic = await service.listProviderModels('anthropic');
	assert.deepEqual(anthropic.models, ['pi-chat']);
	assert.equal(anthropic.source, 'pi');
	assert.deepEqual([...urls].sort(), [
		'https://api.openai.com/v1/models',
		'https://api.anthropic.com/v1/models',
		'https://models.dev/api.json',
		'https://models.dev/api.json',
		`https://pi.dev/api/models/providers/anthropic?pi-version=${PI_AI_VERSION}`,
		`https://pi.dev/api/models/providers/openai?pi-version=${PI_AI_VERSION}`,
	].sort());
});

void test('Gemini discovery reads every page and keeps generation models only', async () => {
	const urls: string[] = [];
	const service = createModelService(credentials, {
		...transport,
		fetch: async (input, init) => {
			const url = new URL(new Request(input).url);
			if (url.origin === 'https://models.dev' || url.origin === 'https://pi.dev') return Response.json({});
			urls.push(url.href);
			assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'test-key');
			return url.searchParams.has('pageToken')
				? Response.json({ models: [{ name: 'models/gemini-second', supportedGenerationMethods: ['generateContent'] }] })
				: Response.json({
					models: [
						{ name: 'models/gemini-first', supportedGenerationMethods: ['generateContent'] },
						{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
					],
					nextPageToken: 'second',
				});
		},
	});
	const catalog = await service.listProviderModels('google');
	assert.deepEqual(catalog.models, ['gemini-first', 'gemini-second']);
	assert.equal(catalog.source, 'provider');
	assert.deepEqual(urls, [
		'https://generativelanguage.googleapis.com/v1beta/models',
		'https://generativelanguage.googleapis.com/v1beta/models?pageToken=second',
	]);
});

void test('Discovery keeps the bundled list offline and skips all sources when already cancelled', async () => {
	const urls: string[] = [];
	const controller = new AbortController();
	const service = createModelService(credentials, {
		...transport,
		fetch: async (input) => {
			urls.push(new Request(input).url);
			return new Response(null, { status: 404 });
		},
	});
	const bundled = service.providers().find((entry) => entry.id === 'deepseek')?.models.map((model) => model.id);
	assert.ok(bundled?.length);
	const catalog = await service.listProviderModels('deepseek');
	assert.deepEqual(catalog.models, bundled);
	assert.equal(catalog.source, 'bundled');
	assert.ok(catalog.details?.size);
	assert.deepEqual(urls.sort(), [
		'https://api.deepseek.com/models',
		'https://api.deepseek.com/v1/models',
		'https://models.dev/api.json',
		`https://pi.dev/api/models/providers/deepseek?pi-version=${PI_AI_VERSION}`,
	].sort());
	controller.abort();
	await assert.rejects(service.listProviderModels('openai', controller.signal), { name: 'AbortError' });
	assert.equal(urls.length, 4);
});

void test('Adding models merges exact catalog matches and keeps unpublished ids out of the picker', async () => {
	const seen: { origin: string; authorization: string | null }[] = [];
	const service = createModelService(credentials, {
		...transport,
		fetch: (input, init) => {
			const url = new URL(new Request(input).url);
			const authorization = new Headers(init?.headers).get('authorization');
			seen.push({ origin: url.origin, authorization });
			if (url.origin === 'https://openrouter.ai') return Promise.resolve(Response.json({ data: [
				{ id: 'google/gemini-3.8-flash', context_length: 250000, architecture: { input_modalities: ['text', 'image', 'audio', 'file'] },
					supported_parameters: ['reasoning', 'structured_outputs'] },
				{ id: 'new-only' },
			] }));
			if (url.origin === 'https://models.dev') return Promise.resolve(Response.json({
				openrouter: { api: 'https://openrouter.ai/api/v1', models: {
					'google/gemini-3.8-flash': { tool_call: true, limit: { context: 500000, output: 30000 }, modalities: { input: ['text', 'pdf'], output: ['text'] } },
					'public-only': { tool_call: true },
				} },
				google: { models: { 'new-only': { tool_call: true } } },
			}));
			if (url.origin === 'https://pi.dev') return Promise.resolve(Response.json({
				gemini: {
					id: 'google/gemini-3.8-flash', type: 'chat', provider: 'openrouter',
					api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
					reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
				},
			}));
			return Promise.reject(new Error(`Unexpected catalog request ${url.href}`));
		},
	});
	const catalog = await service.listProviderModels('openrouter');
	assert.deepEqual(catalog.models, ['google/gemini-3.8-flash', 'new-only']);
	const details = catalog.details?.get('google/gemini-3.8-flash');
	assert.ok(details);
	assert.equal(details.contextWindow, 250000);
	assert.equal(details.maxTokens, 30000);
	assert.equal(details.tools, true);
	assert.equal(details.reasoning, true);
	assert.equal(details.structuredOutput, true);
	assert.deepEqual(details.inputModalities, ['text', 'image', 'audio', 'file', 'pdf']);
	assert.deepEqual(details.outputModalities, ['text']);
	assert.ok(details.thinkingLevels?.includes('high'));
	assert.equal(details.evidence?.contextWindow?.source, 'provider');
	assert.equal(details.evidence?.maxTokens?.source, 'models.dev');
	assert.deepEqual(details.reportedThinkingLevels, ['low', 'high']);
	assert.equal(details.evidence?.reportedThinkingLevels?.source, 'pi');
	assert.deepEqual(catalog.details?.get('new-only'), {});
	assert.deepEqual(seen.find(({ origin }) => origin === 'https://models.dev'), { origin: 'https://models.dev', authorization: null });
	assert.deepEqual(seen.find(({ origin }) => origin === 'https://pi.dev'), { origin: 'https://pi.dev', authorization: null });
	assert.deepEqual(seen.find(({ origin }) => origin === 'https://openrouter.ai'), { origin: 'https://openrouter.ai', authorization: 'Bearer test-key' });
});

void test('Public sources contribute matched candidates without overriding an empty account list', async () => {
	let officialAvailable = false;
	let piAvailable = true;
	const service = createModelService(credentials, {
		...transport,
		fetch: async (input) => {
			const url = new URL(new Request(input).url);
			if (url.hostname === 'api.deepseek.com') return officialAvailable
				? Response.json({ data: [] }) : new Response(null, { status: 403 });
			if (url.hostname === 'pi.dev') return piAvailable
				? Response.json({ model: { id: 'pi-candidate', type: 'chat', provider: 'deepseek',
					api: 'openai-completions', baseUrl: 'https://api.deepseek.com' } }) : new Response(null, { status: 404 });
			if (url.hostname === 'models.dev') return Response.json({
				deepseek: { api: 'https://api.deepseek.com', npm: '@ai-sdk/openai-compatible', models: {
					'public-candidate': { modalities: { input: ['text'], output: ['text'] } },
					'public-embedding': { type: 'embedding', modalities: { input: ['text'], output: ['embedding'] } },
					'public-retired': { type: 'chat', status: 'deprecated' },
				} },
			});
			throw new Error(`Unexpected catalog request ${url.href}`);
		},
	});
	const fallback = await service.listProviderModels('deepseek');
	assert.deepEqual(fallback.models, ['pi-candidate', 'public-candidate']);
	assert.deepEqual(fallback.specializedModels, ['public-embedding']);
	assert.equal(fallback.source, 'pi');
	piAvailable = false;
	const publicOnly = await service.listProviderModels('deepseek');
	assert.deepEqual(publicOnly.models, ['public-candidate']);
	assert.equal(publicOnly.source, 'models.dev');
	officialAvailable = true;
	const empty = await service.listProviderModels('deepseek');
	assert.deepEqual(empty.models, []);
	assert.deepEqual(empty.specializedModels, []);
	assert.equal(empty.source, 'provider');
});

void test('OpenCode Go discovers matching Pi routes without keeping them in the SDK catalog', async () => {
	const service = createModelService(credentials, {
		...transport,
		fetch: async (input) => {
			const url = new URL(new Request(input).url);
			if (url.hostname === 'opencode.ai') return new Response(null, { status: 503 });
			if (url.hostname === 'models.dev') return Response.json({});
			assert.equal(url.pathname, '/api/models/providers/opencode-go');
			const candidate = {
				id: 'pi-gemini', provider: 'opencode-go', type: 'chat', api: 'google-generative-ai',
				baseUrl: 'https://opencode.ai/inference/go/google/v1beta', input: ['text', 'image', 'video'], supports_video_in: true,
			};
			return Response.json({
				valid: candidate,
				'wrong-plan': { ...candidate, id: 'wrong-plan', baseUrl: 'https://opencode.ai/inference/google/v1beta' },
				'wrong-provider': { ...candidate, id: 'wrong-provider', provider: 'opencode' },
			});
		},
	});
	const before = service.providers().find(({ id }) => id === 'opencode-go')?.models;
	const catalog = await service.listProviderModels('opencode-go');
	assert.deepEqual(catalog.models, ['pi-gemini']);
	const gemini = catalog.details?.get('pi-gemini');
	assert.equal(gemini?.connectionProtocol, 'google-generative-ai');
	assert.deepEqual(gemini?.inputModalities, ['text', 'image']);
	assert.equal(gemini?.videoInput, undefined);
	assert.deepEqual(service.providers().find(({ id }) => id === 'opencode-go')?.models, before);
});

void test('catalog rows ignore web search fields while retaining supported input and function tools', () => {
	const catalog = readProviderCatalog({ data: [
		{ id: 'native', capabilities: { server_tools: { web_search: { supported: true } } }, input_modalities: ['text', 'audio', 'video'] },
		{ id: 'flag', capabilities: { native_web_search: true }, native_web_search: true },
		{ id: 'gateway', supported_parameters: ['tools', 'web_search_options', 'structured_outputs'] },
		{ id: 'web-fetch', capabilities: { server_tools: { web_fetch: { supported: true }, supported: true } } },
	] });
	assert.deepEqual(catalog.details?.get('native'), { inputModalities: ['text', 'audio', 'video'] });
	assert.deepEqual(catalog.details?.get('flag'), {});
	assert.deepEqual(catalog.details?.get('gateway'), { tools: true, structuredOutput: true });
	assert.deepEqual(catalog.details?.get('web-fetch'), {});
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

void test('Provider groups preserve distinct billing products even at a shared endpoint', () => {
	const service = createModelService(credentials, transport, {});
	const groups = groupProviders(service.providers());
	const bailian = groups.find((group) => group.label === '阿里云百炼');
	const openai = groups.find((group) => group.label === 'OpenAI');
	const minimax = groups.find((group) => group.label === 'MiniMax');
	const zai = groups.find((group) => group.label === 'Z.AI');
	assert.deepEqual(bailian?.providers.map((provider) => provider.id), [
		'bailian-token-plan', 'bailian-coding-plan', 'bailian-payg', 'qwen-token-plan', 'qwen-token-plan-cn',
		'qwen-token-plan-individual', 'qwen-token-plan-individual-cn',
	]);
	assert.equal(openai?.providers.length, 2);
	assert.deepEqual(minimax?.providers.map(({ id }) => id), ['minimax', 'minimax-cn', 'minimax-m-plan', 'minimax-m-plan-cn']);
	assert.deepEqual(zai?.providers.map(({ id }) => id), ['zai', 'zai-coding-cn', 'zai-payg', 'zai-payg-cn']);
});

void test('Every preset connection has a bundled brand icon, including variants', () => {
	const providers = createModelService(credentials, transport, {}).providers();
	const missing = providers.filter(({ id }) => {
		const brand = providerIcon(id);
		return !brand?.svg?.includes('<path') && !/^data:image\/(?:png|svg\+xml);base64,/u.test(brand?.image ?? '');
	});
	assert.deepEqual(missing.map(({ id }) => id), []);
	assert.equal(providerIcon('opencode-go'), providerIcon('opencode'));
	assert.equal(providerIcon('volcengine-coding-plan'), providerIcon('volcengine-agent-plan'));
	assert.notEqual(providerIcon('google-vertex')?.svg, providerIcon('google')?.svg);
	assert.equal(providerIcon('custom-unknown'), undefined);
	assert.ok(providerIcon('openai')?.svg?.includes('<path'));
});
