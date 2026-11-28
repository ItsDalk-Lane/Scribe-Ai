import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchModelList, mergeModelCatalogDetails, readModelsDevCatalog, readPiModelCatalog, readProviderCatalog,
	sourceModelCatalogDetails } from '../modelCatalog';
import { fetchAccountModelCatalog } from '../modelCatalogAccounts';
import { fetchOfficialModelCatalog } from '../modelCatalogProviders';
import type { CredentialStore, Transport } from '../../types';

const signal = new AbortController().signal;

void test('catalog type uses explicit model data without mistaking input modalities or a generic object kind for the model type', () => {
	const catalog = readProviderCatalog({ data: [
		{ id: 'vision-chat', model_type: 'text', input_modalities: ['text', 'image'] },
		{ id: 'voice', type: 'audio', model_type: 'text to speech' },
		{ id: 'transcriber', type: 'model', model_type: 'ASR', domain: 'audio' },
		{ id: 'unclassified-audio', type: 'audio' },
		{ id: 'opaque', type: 'constructor' },
	] });
	assert.deepEqual(catalog.models, ['vision-chat', 'opaque']);
	assert.equal(catalog.details?.get('vision-chat')?.type, 'text');
	assert.equal(catalog.details?.get('voice')?.type, 'speech-synthesis');
	assert.equal(catalog.details?.get('transcriber')?.type, 'speech-recognition');
	assert.equal(catalog.details?.get('unclassified-audio')?.type, 'audio');
	assert.equal(catalog.details?.get('opaque')?.type, undefined);
	const pi = readPiModelCatalog({ vision: { id: 'vision', type: 'chat' }, painter: { id: 'painter', type: 'image' } });
	assert.deepEqual(pi.models, ['vision']);
	assert.equal(pi.details?.get('painter')?.type, 'image');
});

void test('public model evidence matches the exact product and keeps generic JSON separate from schemas', () => {
	const baseUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
	const scope = { baseUrl, protocol: 'openai-completions', models: [] };
	const upstream = {
		'alibaba-token-plan-cn': { api: baseUrl, npm: '@ai-sdk/openai-compatible', models: {
			'model-with-video': { modalities: { input: ['text', 'video'], output: ['text'] }, structured_output: true },
			'model-without-json': { structured_output: false },
		} },
	};
	const { models, details: rows } = readModelsDevCatalog('qwen-token-plan-individual-cn', upstream, scope);
	assert.deepEqual(models, ['model-with-video']);
	assert.deepEqual(rows.get('model-with-video')?.inputModalities, ['text', 'video']);
	assert.equal(rows.get('model-with-video')?.jsonOutput, true);
	assert.equal(rows.get('model-with-video')?.structuredOutput, undefined);
	assert.equal(rows.get('model-without-json')?.structuredOutput, false);
	assert.equal(rows.get('model-without-json')?.evidence?.structuredOutput?.source, 'models.dev');
	assert.equal(readModelsDevCatalog('qwen-token-plan-individual-cn', upstream, { ...scope, baseUrl: baseUrl.replace('cn-beijing', 'ap-southeast-1') }).details.size, 0);
	assert.deepEqual(readModelsDevCatalog('qwen-token-plan-individual-cn', upstream, { ...scope, protocol: 'openai-responses' }).models, []);
	assert.equal(readModelsDevCatalog('qwen-token-plan-individual', upstream, scope).details.size, 0);
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
	assert.equal(catalog.details?.get('new-chat')?.type, 'text');
	assert.equal(catalog.details?.get('fast-embed')?.type, 'embedding');
	assert.equal(catalog.details?.get('new-chat-v2')?.type, undefined);
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
	const together = await fetchOfficialModelCatalog('together', 'https://api.together.ai/v1', credentials, fetch, signal);
	assert.deepEqual(together?.models, ['chat-first', 'code']);
	assert.equal(together?.details?.get('chat-first')?.type, 'text');
	assert.equal(together?.details?.get('code')?.type, 'text');
	assert.equal(together?.details?.get('image-gen')?.type, 'image');
	assert.deepEqual((await fetchOfficialModelCatalog('cerebras', 'https://api.cerebras.ai/v1', credentials, fetch, signal))?.models, ['latest-public-chat']);
	assert.equal(await fetchOfficialModelCatalog('meta', 'https://api.meta.ai/v1', credentials, fetch, signal), undefined);
	assert.deepEqual(calls, ['https://api.together.ai/v1/models', 'https://api.cerebras.ai/public/v1/models']);
});

void test('Vercel lists the official unfiltered directory and retains explicit specialized model types', async () => {
	const credentials: CredentialStore = {
		read: () => { throw Error('The public Vercel directory does not need a credential'); },
		list: async () => [], modify: async () => undefined, delete: async () => {},
	};
	const result = await fetchOfficialModelCatalog('vercel-ai-gateway', 'https://ai-gateway.vercel.sh', credentials, async (input) => {
		assert.equal(new Request(input).url, 'https://ai-gateway.vercel.sh/v1/models');
		return Response.json({ data: [
			{ id: 'text', type: 'language' }, { id: 'voice', type: 'speech' }, { id: 'listen', type: 'transcription' },
			{ id: 'rank', type: 'reranking' }, { id: 'vector', type: 'embedding' },
			{ id: 'paint', type: 'image' }, { id: 'movie', type: 'video' },
		] });
	}, signal);
	assert.deepEqual(result?.models, ['text']);
	assert.deepEqual([...result?.details ?? []].map(([id, row]) => [id, row.type]), [
		['text', 'text'], ['voice', 'speech-synthesis'], ['listen', 'speech-recognition'], ['rank', 'rerank'],
		['vector', 'embedding'], ['paint', 'image'], ['movie', 'video'],
	]);
});

void test('Volcengine subscription inference endpoints are not generic catalog endpoints', async () => {
	const reads: string[] = [];
	const credentials: CredentialStore = {
		read: async (id) => { reads.push(id); return { type: 'api_key', key: 'fixture' }; },
		list: async () => [], modify: async () => undefined, delete: async () => {},
	};
	const ark = 'https://ark.cn-beijing.volces.com';
	const fetch: Transport['fetch'] = async (input) => {
		assert.equal(new Request(input).url, `${ark}/api/v3/models`);
		return Response.json({ data: [{ id: 'doubao-seed-version' }] });
	};
	assert.equal(await fetchOfficialModelCatalog('volcengine-agent-plan', `${ark}/api/plan/v3`, credentials, fetch, signal), undefined);
	assert.equal(await fetchOfficialModelCatalog('volcengine-coding-plan', `${ark}/api/coding/v3`, credentials, fetch, signal), undefined);
	assert.deepEqual((await fetchOfficialModelCatalog('volcengine-doubao', `${ark}/api/v3`, credentials, fetch, signal))?.models,
		['doubao-seed-version']);
	assert.deepEqual(reads, ['volcengine-doubao']);
});

void test('Bailian US uses the native paginated directory and allows compatible discovery when denied or incomplete', async () => {
	const base = 'https://dashscope-us.aliyuncs.com/compatible-mode/v1';
	const key = { type: 'api_key', key: 'bailian-us-fixture' } as const;
	const requests: string[] = [];
	let rejected = false;
	let incomplete = false;
	const fetch: Transport['fetch'] = async (input, init) => {
		const url = new URL(new Request(input).url);
		assert.equal(url.origin, 'https://dashscope-us.aliyuncs.com');
		assert.equal(url.pathname, '/api/v1/models');
		assert.equal(url.searchParams.get('capabilities'), 'TG');
		assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer bailian-us-fixture');
		const page = Number(url.searchParams.get('page_no'));
		requests.push(url.href);
		return rejected ? Response.json({ success: false }, { status: 403 }) : Response.json({
			success: true, output: {
				total: 2, page_no: page, page_size: 1,
				models: incomplete && page === 2 ? [] : [{ model: `qwen-us-${page}` }],
			},
		});
	};
	const load = () => fetchAccountModelCatalog('bailian-payg', base, key, undefined, fetch, signal);
	assert.deepEqual((await load())?.models, ['qwen-us-1', 'qwen-us-2']);
	assert.equal(requests.length, 2);
	rejected = true;
	assert.equal(await load(), undefined);
	rejected = false;
	incomplete = true;
	assert.equal(await load(), undefined);
	assert.equal(await fetchAccountModelCatalog('bailian-payg', 'https://dashscope-us.aliyuncs.com.example.com/compatible-mode/v1', key, undefined, fetch, signal), undefined);
	assert.equal(requests.length, 5);
});

void test('Kimi Code authenticates discovery with the resolved SDK OAuth bearer on the official coding endpoint', async () => {
	const base = 'https://api.kimi.com/coding/v1';
	const credential = { type: 'oauth', access: 'old-token', refresh: 'refresh-token', expires: 0 } as const;
	const auth = { auth: { headers: { Authorization: 'Bearer refreshed-token', 'x-not-needed': 'omit' } } };
	let requests = 0;
	const fetch: Transport['fetch'] = async (input, init) => {
		assert.equal(new Request(input).url, base + '/models');
		assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer refreshed-token');
		assert.equal(new Headers(init?.headers).get('x-not-needed'), null);
		requests++;
		return Response.json({ data: [{ id: 'k3.1-pro' }] });
	};
	assert.deepEqual((await fetchAccountModelCatalog('kimi-coding', base, credential, auth, fetch, signal))?.models, ['k3.1-pro']);
	assert.equal(await fetchAccountModelCatalog('kimi-coding', base, credential, undefined, fetch, signal), undefined);
	assert.equal(await fetchAccountModelCatalog('kimi-coding', 'https://api.moonshot.cn/v1', credential, auth, fetch, signal), undefined);
	assert.equal(await fetchAccountModelCatalog('kimi-coding', 'https://api.kimi.com.example.com/coding/v1', credential, auth, fetch, signal), undefined);
	assert.equal(requests, 1);
});

void test('MiMo and TypeSafe catalogs keep documented non-chat models as typed candidates', async () => {
	let requests = 0;
	const credentials: CredentialStore = {
		read: async () => ({ type: 'api_key', key: 'directory-fixture' }),
		list: async () => [], modify: async () => undefined, delete: async () => {},
	};
	const fetch: Transport['fetch'] = async (input, init) => {
		const url = new Request(input).url;
		assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer directory-fixture');
		requests++;
		if (url === 'https://api.typesafe.ai/v1/models') {
			return Response.json({ models: [{ name: 'jev-latest', description: 'System One', release_date: '2026-09-15' }] });
		}
		assert.equal(url, 'https://token-plan-cn.xiaomimimo.com/v1/models');
		return Response.json({ data: ['mimo-v2.6-pro', 'mimo-v2.5-asr', 'mimo-v2.5-tts',
			'mimo-v2.5-tts-voiceclone', 'mimo-v2.5-tts-voicedesign'].map((id) => ({ id, object: 'model' })) });
	};
	const mimo = await fetchOfficialModelCatalog('xiaomi-token-plan-cn', 'https://token-plan-cn.xiaomimimo.com/v1', credentials, fetch, signal);
	assert.deepEqual(mimo?.models, ['mimo-v2.6-pro']);
	assert.deepEqual([...mimo?.details ?? []].flatMap(([id, row]) => row.type ? [[id, row.type]] : []), [
		['mimo-v2.5-asr', 'speech-recognition'], ['mimo-v2.5-tts', 'speech-synthesis'],
		['mimo-v2.5-tts-voiceclone', 'speech-synthesis'], ['mimo-v2.5-tts-voicedesign', 'speech-synthesis'],
	]);
	const typesafe = await fetchOfficialModelCatalog('typesafe', '', credentials, fetch, signal);
	assert.deepEqual(typesafe?.models, []);
	assert.equal(typesafe?.details?.get('jev-latest')?.type, 'other');
	assert.equal(await fetchOfficialModelCatalog('typesafe', '', { ...credentials, read: async () => undefined }, fetch, signal), undefined);
	assert.equal(requests, 2);
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
			return Response.json({ result: second ? [{ name: '@cf/chat-new', task: { name: 'Text Generation' } }] : [
				{ name: '@cf/embed', task: { name: 'Text Embeddings' } },
				{ name: '@cf/asr', task: 'Automatic Speech Recognition' },
			], result_info: { page: second ? 2 : 1, per_page: 2, total_count: 3 } });
		}
		assert.equal(url.hostname, 'chatgpt.com');
		assert.equal(headers.get('chatgpt-account-id'), 'workspace');
		assert.equal(headers.get('authorization'), 'Bearer access');
		return Response.json({ models: [{ slug: 'codex-account-latest' }] });
	};
	const azure = { type: 'api_key', key: 'azure-key' } as const;
	assert.deepEqual((await fetchAccountModelCatalog('azure', 'https://resource.openai.azure.com', azure, undefined, fetch, signal))?.models, ['chat-model']);
	const cloudflare = { type: 'api_key', key: 'cloudflare-key', env: { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) } } as const;
	const cloudflareCatalog = await fetchAccountModelCatalog('cloudflare-workers-ai', '', cloudflare, undefined, fetch, signal);
	assert.deepEqual(cloudflareCatalog?.models, ['@cf/chat-new']);
	assert.equal(cloudflareCatalog?.details?.get('@cf/embed')?.type, 'embedding');
	assert.equal(cloudflareCatalog?.details?.get('@cf/asr')?.type, 'speech-recognition');
	assert.equal(await fetchAccountModelCatalog('cloudflare-workers-ai', 'https://custom.example/v1', cloudflare, undefined, fetch, signal), undefined);
	const codex = { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000, accountId: 'workspace' } as const;
	assert.deepEqual((await fetchAccountModelCatalog('openai-codex', '', codex, { auth: { apiKey: 'access' } }, fetch, signal))?.models, ['codex-account-latest']);
	assert.equal(calls.length, 4);
});

void test('Bedrock reads eligible foundation models and active same-account inference profiles in the configured region', async () => {
	const calls: string[] = [];
	let denyProfiles = false;
	let denyFoundations = false;
	const appProfile = 'arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/app-id';
	const modelArn = (id: string) => ({ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${id}` });
	const fetch: Transport['fetch'] = async (input, init) => {
		const url = new URL(new Request(input).url);
		calls.push(url.href);
		assert.equal(url.hostname, 'bedrock.eu-west-1.amazonaws.com');
		assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer bedrock-fixture');
		if (url.pathname === '/foundation-models') {
			assert.equal(url.searchParams.get('byOutputModality'), 'TEXT');
			return denyFoundations ? new Response(null, { status: 403 }) : Response.json({ modelSummaries: [
				{ modelId: 'anthropic.chat', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], responseStreamingSupported: true },
			] });
		}
		assert.equal(url.pathname, '/inference-profiles');
		if (denyProfiles) return new Response(null, { status: 403 });
		if (url.searchParams.has('nextToken')) {
			assert.equal(url.searchParams.get('nextToken'), 'next/profile+');
			return Response.json({ inferenceProfileSummaries: [{
				inferenceProfileArn: appProfile, type: 'APPLICATION', status: 'ACTIVE', models: [modelArn('anthropic.chat')],
			}] });
		}
		return Response.json({ nextToken: 'next/profile+', inferenceProfileSummaries: [
			{ inferenceProfileId: 'eu.anthropic.chat', type: 'SYSTEM_DEFINED', status: 'ACTIVE', models: [modelArn('anthropic.chat')] },
			{ inferenceProfileId: 'eu.inactive.chat', type: 'SYSTEM_DEFINED', status: 'INACTIVE', models: [modelArn('anthropic.chat')] },
			{ inferenceProfileId: 'eu.embedding', type: 'SYSTEM_DEFINED', status: 'ACTIVE', models: [modelArn('text.vector')] },
		] });
	};
	const read = () => fetchAccountModelCatalog('amazon-bedrock', 'https://bedrock-runtime.eu-west-1.amazonaws.com',
		{ type: 'api_key', key: 'bedrock-fixture', env: { AWS_REGION: 'us-east-1' } }, undefined, fetch, signal,
		new Set(['text.vector']), new Set(['anthropic.chat']));
	const full = await read();
	assert.deepEqual(full?.models, ['anthropic.chat', 'eu.anthropic.chat', appProfile]);
	assert.deepEqual(full?.details?.get(appProfile), { type: 'text', inputModalities: ['text', 'image'], outputModalities: ['text'] });
	assert.equal(full?.partial, undefined);
	assert.equal(calls.length, 3);
	denyProfiles = true;
	const onlyFoundations = await read();
	assert.deepEqual(onlyFoundations?.models, ['anthropic.chat']);
	assert.equal(onlyFoundations?.partial, true);
	denyProfiles = false;
	denyFoundations = true;
	const onlyProfiles = await read();
	assert.deepEqual(onlyProfiles?.models, ['eu.anthropic.chat', appProfile]);
	assert.equal(onlyProfiles?.partial, true);
	denyProfiles = true;
	await assert.rejects(read(), /HTTP 403/);
});
