import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createModelService } from '../../communication/providers';
import type { CredentialStore, ModelCatalogResult, ModelProviderInfo, Transport } from '../../types';
import { normalizeSettings } from '../settings/defaults';
import { createRuntimeModelCatalog } from '../settings/runtimeModelCatalog';
import { createModelCatalogStore } from '../storage/modelCatalogStore';
import { scribeDataPaths } from '../storage/paths';

const provider: ModelProviderInfo = {
	id: 'opencode-go', label: 'OpenCode Go', models: [],
	baseUrl: 'https://opencode.ai/inference/go/openai/v1', protocol: 'openai-completions', protocols: ['openai-completions'],
};
const selected = { providerId: provider.id, model: 'gemini-catalog-fixture' };
const catalog: ModelCatalogResult = {
	source: 'provider', models: [selected.model], specializedModels: [],
	details: new Map([[selected.model, { type: 'text', connectionProtocol: 'google-generative-ai', contextWindow: 90_000 }]]),
};

void test('the settings directory ignores the old disk cache, scopes results to credentials and releases them when leaving', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-memory-catalog-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const { cache } = scribeDataPaths(root);
	await mkdir(cache, { recursive: true });
	const legacy = join(cache, 'model-catalog.json');
	const oldData = JSON.stringify({ version: 1, providers: { [provider.id]: { models: ['retired-result'] } } });
	await writeFile(legacy, oldData);

	const settings = normalizeSettings(null);
	settings.providerModels[provider.id] = [selected.model];
	settings.communication.credentialIds[provider.id] = 'saved-credential';
	const readers = {
		providers: () => [provider],
		listProviderModels: async () => catalog,
		listCustomModels: async (id: string, baseUrl: string) => {
			assert.equal(id, 'custom-1');
			return { models: ['local-chat'], baseUrl: baseUrl + '/v1' };
		},
	};
	const store = createModelCatalogStore(settings, readers);
	t.after(() => store.dispose());
	assert.deepEqual((await store.read(provider.id, undefined, 'saved-credential'))?.models, []);
	const signal = new AbortController().signal;
	const options = { credentialId: 'saved-credential' };
	const fetched = await store.fetchConnection(provider, options, readers, signal);
	assert.ok(fetched);
	assert.equal(store.protocol(provider.id, selected.model), 'google-generative-ai');
	assert.equal(store.details(provider.id, selected.model)?.contextWindow, 90_000);
	assert.deepEqual((await store.read(provider.id, undefined, 'another-credential'))?.models, []);

	store.clearSettings();
	await store.rememberConnection(provider, options, fetched);
	assert.equal(store.protocol(provider.id, selected.model), undefined);
	assert.equal(store.details(provider.id, selected.model), undefined);
	assert.deepEqual((await store.read(provider.id, undefined, 'saved-credential'))?.models, []);
	assert.deepEqual(settings.providerModels[provider.id], [selected.model]);
	assert.equal(await readFile(legacy, 'utf8'), oldData);

	const custom: ModelProviderInfo = { ...provider, id: 'custom-1', baseUrl: 'http://127.0.0.1:11434' };
	const draft = { baseUrl: custom.baseUrl, protocol: custom.protocol, credentialId: 'local-credential' };
	const discovered = await store.fetchConnection(custom, draft, readers, signal);
	assert.ok(discovered);
	assert.equal(discovered.baseUrl, draft.baseUrl + '/v1');
	settings.customProviders[custom.id] = { label: 'Local', baseUrl: discovered.baseUrl, protocol: custom.protocol };
	settings.communication.credentialIds[custom.id] = draft.credentialId;
	const withCustom = { ...readers, providers: () => [provider, custom] };
	const scoped = createModelCatalogStore(settings, withCustom);
	t.after(() => scoped.dispose());
	const result = await scoped.fetchConnection(custom, draft, withCustom, signal);
	assert.ok(result);
	await scoped.rememberConnection(custom, draft, result);
	assert.equal((await scoped.read(custom.id, discovered.baseUrl, draft.credentialId))?.baseUrl, discovered.baseUrl);
	assert.equal(await scoped.read(custom.id, discovered.baseUrl, 'another-credential'), undefined);
});

void test('closing settings aborts its outstanding directory query and a late result cannot populate the next visit', async () => {
	const settings = normalizeSettings(null);
	let release: ((result: ModelCatalogResult) => void) | undefined;
	let observed: AbortSignal | undefined;
	const readers = {
		providers: () => [provider],
		listProviderModels: (_id: string, signal?: AbortSignal) => {
			observed = signal;
			return new Promise<ModelCatalogResult>((resolve) => { release = resolve; });
		},
		listCustomModels: async () => ({ models: [], baseUrl: '' }),
	};
	const store = createModelCatalogStore(settings, readers);
	const pending = store.fetchConnection(provider, {}, readers, new AbortController().signal);
	store.clearSettings();
	assert.equal(observed?.aborted, true);
	release?.(catalog);
	await assert.rejects(pending, { name: 'AbortError' });
	assert.equal(store.protocol(provider.id, selected.model), undefined);
	assert.deepEqual((await store.read(provider.id))?.models, []);
	store.dispose();
});

void test('a cold OpenCode model resolves its official protocol and limits only within the active request', async () => {
	const settings = normalizeSettings(null);
	const credentials: CredentialStore = {
		read: async () => ({ type: 'api_key', key: 'fixture' }), list: async () => [],
		modify: async (_id, change) => change(undefined), delete: async () => {},
	};
	let requested = 0;
	let unavailable = false;
	const fetch: Transport['fetch'] = async (input) => {
		const url = new Request(input).url;
		if (url === 'https://opencode.ai/inference/go/v1/models') {
			requested++;
			if (unavailable) return new Response(null, { status: 503 });
			return Response.json({ data: [{
				id: selected.model, type: 'chat', context_length: 90_000,
				api: { 'generate-content': { base_url: 'https://opencode.ai/inference/go/google/v1beta' } },
			}] });
		}
		return Response.json({});
	};
	const runtime = createRuntimeModelCatalog(settings, () => service);
	const service = createModelService(credentials, { fetch, configure: () => {}, onStatus: () => () => {}, logs: () => [] }, {
		modelOverrides: () => settings.modelOverrides,
		catalogProtocol: runtime.protocol, catalogDetails: runtime.details,
	});
	await runtime.withPreparedModels(async () => {
		await runtime.prepareModel(selected);
		assert.equal(service.contextLimits?.(selected)?.contextWindow, 90_000);
		assert.deepEqual(service.modelConnection(selected.providerId, selected.model), {
			api: 'google-generative-ai', baseUrl: 'https://opencode.ai/inference/go/google/v1beta', source: 'catalog',
		});
		await runtime.withPreparedModels(() => runtime.prepareModel(selected));
		assert.equal(requested, 1);
		const stopped = new Error('Stop before inference');
		await assert.rejects(service.send({
			...selected, messages: [{ role: 'user', content: 'Fixture' }], tools: [], maxRetries: 0,
			beforeSend: async (address) => {
				assert.match(address, /^https:\/\/opencode\.ai\/inference\/go\/google\/v1beta\//u);
				throw stopped;
			},
		}), (error: unknown) => error === stopped);
	});
	assert.equal(runtime.protocol(selected.providerId, selected.model), undefined);
	assert.equal(runtime.details(selected.providerId, selected.model), undefined);
	unavailable = true;
	await assert.rejects(runtime.withPreparedModels(() => runtime.prepareModel(selected)), /无法确认.*API 协议/u);
	assert.equal(requested, 2);
	settings.modelOverrides[provider.id] = { [selected.model]: { protocol: 'openai-responses', contextWindow: 20_000 } };
	await runtime.withPreparedModels(async () => {
		await runtime.prepareModel(selected);
		assert.equal(service.modelConnection(selected.providerId, selected.model).api, 'openai-responses');
		assert.equal(service.contextLimits?.(selected)?.contextWindow, 20_000);
	});
});
