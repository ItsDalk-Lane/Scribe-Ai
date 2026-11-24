import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchModelList, mergeModelCatalogDetails, modelsDevDetails, sourceModelCatalogDetails } from '../modelCatalog';
import { fetchAccountModelCatalog } from '../modelCatalogAccounts';
import { fetchOfficialModelCatalog } from '../modelCatalogProviders';
import type { CredentialStore, Transport } from '../../types';

const signal = new AbortController().signal;

void test('public model evidence matches the exact product and keeps generic JSON separate from schemas', () => {
	const baseUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
	const scope = { baseUrl, protocol: 'openai-completions', models: [] };
	const upstream = {
		'alibaba-token-plan-cn': { api: baseUrl, models: {
			'model-with-video': { modalities: { input: ['text', 'video'] }, structured_output: true },
			'model-without-json': { structured_output: false },
		} },
	};
	const rows = modelsDevDetails('qwen-token-plan-individual-cn', upstream, scope);
	assert.deepEqual(rows.get('model-with-video')?.inputModalities, ['text', 'video']);
	assert.equal(rows.get('model-with-video')?.jsonOutput, true);
	assert.equal(rows.get('model-with-video')?.structuredOutput, undefined);
	assert.equal(rows.get('model-without-json')?.structuredOutput, false);
	assert.equal(rows.get('model-without-json')?.evidence?.structuredOutput?.source, 'models.dev');
	assert.equal(modelsDevDetails('qwen-token-plan-individual-cn', upstream, { ...scope, baseUrl: baseUrl.replace('cn-beijing', 'ap-southeast-1') }).size, 0);
	assert.equal(modelsDevDetails('qwen-token-plan-individual', upstream, scope).size, 0);
});

void test('field conflicts are explicit and model protocol changes discard previous evidence', () => {
	const model = 'model';
	const docs = sourceModelCatalogDetails(new Map([[model, { structuredOutput: true }]]), 'docs');
	const provider = sourceModelCatalogDetails(new Map([[model, { connectionProtocol: 'openai-completions', structuredOutput: false }]]), 'provider');
	const changed = mergeModelCatalogDetails(docs, provider, docs).get(model);
	assert.equal(changed?.structuredOutput, false);
	assert.equal(changed?.evidence?.structuredOutput?.conflict, true);
	const fresh = sourceModelCatalogDetails(new Map([[model, { connectionProtocol: 'anthropic-messages', contextWindow: 5000 }]]), 'provider');
	const rerouted = mergeModelCatalogDetails(provider, fresh).get(model);
	assert.equal(rerouted?.structuredOutput, undefined);
	assert.equal(rerouted?.contextWindow, 5000);
});

void test('OpenCode only saves supported protocols with the official endpoint for that service', async () => {
	const fetch: Transport['fetch'] = async () => Response.json({ data: [
		{ id: 'gemini-new', type: 'chat', recommended_api: 'interactions', api: {
			interactions: { base_url: 'https://opencode.ai/inference/go/google/v1beta' },
			'generate-content': { base_url: 'https://opencode.ai/inference/go/google/v1beta' },
		} },
		{ id: 'other-origin', type: 'chat', api: {
			responses: { base_url: 'https://unrelated.example/inference/go/openai/v1' },
		} },
		{ id: 'other-plan', type: 'chat', api: {
			messages: { base_url: 'https://opencode.ai/inference/anthropic/v1' },
		} },
	] });
	const catalog = await fetchModelList(fetch, new URL('https://opencode.ai/inference/go/v1/models'), {}, signal, 'opencode-go');
	assert.deepEqual(catalog.models, ['gemini-new', 'other-origin', 'other-plan']);
	assert.equal(catalog.details?.get('gemini-new')?.connectionProtocol, 'google-generative-ai');
	assert.equal(catalog.details?.get('other-origin')?.connectionProtocol, undefined);
	assert.equal(catalog.details?.get('other-plan')?.connectionProtocol, undefined);
});

void test('official lists follow all same-endpoint pages and exclude only known non-chat models', async () => {
	const calls: string[] = [];
	const fetch: Transport['fetch'] = async (input, init) => {
		const url = new URL(new Request(input).url);
		calls.push(url.href);
		assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer catalog-key');
		assert.equal(new Headers(init?.headers).get('user-agent'), 'Scribe-Ai');
		return url.searchParams.has('offset')
			? Response.json({ data: [{ id: 'new-chat-v2' }], total_count: 3 })
			: Response.json({ data: [{ id: 'new-chat', type: 'chat' }, { id: 'fast-embed', type: 'embedding' }],
				total_count: 3, links: { next: '/api/v1/models?offset=2' } });
	};
	const catalog = await fetchModelList(fetch, new URL('https://example.com/api/v1/models'), { authorization: 'Bearer catalog-key' }, signal);
	assert.deepEqual(catalog.models, ['new-chat', 'new-chat-v2']);
	assert.deepEqual(calls, ['https://example.com/api/v1/models', 'https://example.com/api/v1/models?offset=2']);
});

void test('a broken or cross-origin next page makes an official catalog unavailable', async () => {
	const base = new URL('https://example.com/v1/models');
	let requested = 0;
	await assert.rejects(fetchModelList(async () => {
		requested++;
		return Response.json({ data: [{ id: 'partial' }], links: { next: 'https://other.example/v1/models' } });
	}, base, { authorization: 'Bearer private-key' }, signal), /changed the endpoint/);
	assert.equal(requested, 1);
	await assert.rejects(fetchModelList(async () => Response.json({ data: [{ id: 'partial' }], total_count: 2 }),
		base, {}, signal), /incomplete list/);
});

void test('official catalog readers accept Together arrays and choose anonymous Cerebras only when no key is linked', async () => {
	const calls: string[] = [];
	const fetch: Transport['fetch'] = async (input, init) => {
		const url = new URL(new Request(input).url);
		calls.push(url.href);
		if (url.hostname === 'api.together.ai') {
			assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer together-key');
			return Response.json([{ id: 'chat-first', type: 'chat' }, { id: 'code', type: 'code' }, { id: 'image-gen', type: 'image' }]);
		}
		assert.equal(new Headers(init?.headers).get('authorization'), null);
		return Response.json({ data: [{ id: 'latest-public-chat' }] });
	};
	const credentials: CredentialStore = {
		read: async (id) => id === 'together' ? { type: 'api_key', key: 'together-key' } : undefined,
		list: async () => [], modify: async () => undefined, delete: async () => {},
	};
	assert.deepEqual((await fetchOfficialModelCatalog('together', 'https://api.together.ai/v1', credentials, fetch, signal))?.models, ['chat-first', 'code']);
	assert.deepEqual((await fetchOfficialModelCatalog('cerebras', 'https://api.cerebras.ai/v1', credentials, fetch, signal))?.models, ['latest-public-chat']);
	assert.equal(await fetchOfficialModelCatalog('meta', 'https://api.meta.ai/v1', credentials, fetch, signal), undefined);
	assert.deepEqual(calls, ['https://api.together.ai/v1/models', 'https://api.cerebras.ai/public/v1/models']);
});

void test('configured account catalogs use their own hosts and authentication formats', async () => {
	const calls: string[] = [];
	const fetch: Transport['fetch'] = async (input, init) => {
		const url = new URL(new Request(input).url);
		calls.push(url.href);
		const headers = new Headers(init?.headers);
		if (url.hostname === 'resource.openai.azure.com') {
			assert.equal(headers.get('api-key'), 'azure-key');
			return Response.json({ data: [{ id: 'chat-model' }, { id: 'embedding', capabilities: { chat_completion: false } }] });
		}
		if (url.hostname === 'api.cloudflare.com') {
			assert.equal(headers.get('authorization'), 'Bearer cloudflare-key');
			const second = url.searchParams.get('page') === '2';
			return Response.json({ result: [
				second ? { name: '@cf/chat-new', task: { name: 'Text Generation' } }
					: { name: '@cf/embed', task: { name: 'Text Embeddings' } },
			], result_info: { page: second ? 2 : 1, per_page: 1, total_count: 2 } });
		}
		assert.equal(url.hostname, 'chatgpt.com');
		assert.equal(headers.get('chatgpt-account-id'), 'workspace');
		assert.equal(headers.get('authorization'), 'Bearer access');
		return Response.json({ models: [{ slug: 'codex-account-latest' }] });
	};
	const azure = { type: 'api_key', key: 'azure-key' } as const;
	assert.deepEqual((await fetchAccountModelCatalog('azure', 'https://resource.openai.azure.com', azure, undefined, fetch, signal))?.models, ['chat-model']);
	const cloudflare = { type: 'api_key', key: 'cloudflare-key', env: { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) } } as const;
	assert.deepEqual((await fetchAccountModelCatalog('cloudflare-workers-ai', '', cloudflare, undefined, fetch, signal))?.models, ['@cf/chat-new']);
	assert.equal(await fetchAccountModelCatalog('cloudflare-workers-ai', 'https://custom.example/v1', cloudflare, undefined, fetch, signal), undefined);
	const codex = { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000, accountId: 'workspace' } as const;
	assert.deepEqual((await fetchAccountModelCatalog('openai-codex', '', codex, { auth: { apiKey: 'access' } }, fetch, signal))?.models, ['codex-account-latest']);
	assert.equal(calls.length, 4);
});
