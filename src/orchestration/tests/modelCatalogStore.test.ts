import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PI_AI_VERSION } from '@earendil-works/pi-ai';
import { createModelService } from '../../communication/providers';
import { prefillModelConfiguration } from '../../interaction/modelDraft';
import type { CredentialStore, ModelOverride, Transport } from '../../types';
import { normalizeSettings } from '../settings/defaults';
import { createModelCatalogStore } from '../storage/modelCatalogStore';
import { scribeDataPaths } from '../storage/paths';
import { openVaultStorage } from '../storage/vaultStorage';

void test('model catalog refresh saves merged data inside the vault and offline reads keep using it', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-model-catalog-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const { paths } = await openVaultStorage(root, join(root, 'legacy'), { storageVersion: 1 });
	assert.equal(paths.modelCatalog, join(root, '.scribe-ai', 'cache', 'model-catalog.json'));
	assert.equal(paths.modelCatalog, scribeDataPaths(root).modelCatalog);
	const settings = normalizeSettings(null);
	settings.providerModels.openrouter = ['google/gemini-3.8-flash'];
	settings.communication.credentialIds.openrouter = 'linked-secret';
	settings.customProviders['custom-1'] = {
		label: 'Local', baseUrl: 'http://127.0.0.1:11434', protocol: 'openai-completions',
	};
	const credentials: CredentialStore = {
		read: async (id) => id === 'openrouter' ? { type: 'api_key', key: 'test-secret-never-store' } : undefined,
		list: async () => [],
		modify: async (_id, update) => update(undefined),
		delete: async () => {},
	};
	const requests: string[] = [];
	let failProvider = false;
	let failLocal = false;
	let omitProviderField = false;
	const fetch: Transport['fetch'] = async (input, init) => {
		const url = new URL(new Request(input).url);
		requests.push(url.href);
		const authorization = new Headers(init?.headers).get('authorization');
		if (url.hostname === 'models.dev') {
			assert.equal(authorization, null);
			return Response.json({ openrouter: { models: {
				'google/gemini-3.8-flash': { tool_call: true, modalities: { input: ['text', 'image', 'audio'] } },
			} } });
		}
		if (url.hostname === 'openrouter.ai') {
			assert.equal(authorization, 'Bearer test-secret-never-store');
			return failProvider ? new Response(null, { status: 503 })
				: Response.json({ data: [{ id: 'google/gemini-3.8-flash', ...(!omitProviderField && { context_length: 250000 }) }] });
		}
		if (url.hostname === 'pi.dev') {
			assert.equal(authorization, null);
			return Response.json({ 'fallback-model': { id: 'fallback-model', type: 'chat' } });
		}
		if (url.hostname === '127.0.0.1') {
			return url.pathname === '/v1/models' && !failLocal
				? Response.json({ data: [{ id: 'local-verified', native_web_search: true, structured_output: false, supports_video_in: true }] }) : new Response(null, { status: 404 });
		}
		throw new Error(`Unexpected request to ${url.origin}`);
	};
	const transport: Transport = { fetch, configure: () => {}, onStatus: () => () => {}, logs: () => [] };
	const modelService = createModelService(credentials, transport, {
		customProviders: () => Object.entries(settings.customProviders).map(([id, provider]) => ({ id, ...provider, models: [] })),
	});
	const catalog = createModelCatalogStore(paths.modelCatalog, settings, modelService, fetch);
	const initial = catalog.refresh();
	assert.equal(catalog.refresh(), initial);
	assert.equal((await initial).failed, 0);
	assert.equal(requests.filter((url) => url === 'https://models.dev/api.json').length, 1);
	assert.equal(requests.filter((url) => url === `https://pi.dev/api/models?pi-version=${PI_AI_VERSION}`).length, 1);
	const file = await readFile(paths.modelCatalog, 'utf8');
	assert.ok(!file.includes('test-secret-never-store') && !file.includes('linked-secret'));
	assert.doesNotMatch(file, /nativeWebSearch/u);
	const addRetiredFields = async () => {
		const snapshot = JSON.parse(await readFile(paths.modelCatalog, 'utf8')) as {
			providers: Record<string, { details: Record<string, { evidence: Record<string, unknown> }> }>;
		};
		const details = snapshot.providers['custom-1']?.details['local-verified'];
		assert.ok(details);
		Object.assign(details, { nativeWebSearch: true });
		details.evidence.nativeWebSearch = { source: 'provider' };
		await writeFile(paths.modelCatalog, JSON.stringify(snapshot));
	};
	await addRetiredFields();
	catalog.dispose();

	const reopened = createModelCatalogStore(paths.modelCatalog, settings, modelService, fetch);
	requests.length = 0;
	await reopened.loadProtocols();
	const stored = await reopened.read('openrouter', undefined, 'linked-secret');
	assert.deepEqual(stored?.models, ['google/gemini-3.8-flash']);
	const details = stored?.details?.get('google/gemini-3.8-flash');
	assert.equal(details?.contextWindow, 250000);
	assert.equal(details?.tools, true);
	assert.deepEqual(details?.inputModalities, ['text', 'image', 'audio']);
	assert.ok(details?.thinkingLevels?.includes('high'));
	assert.equal((await reopened.read('openrouter', undefined, 'another-secret'))?.source, 'bundled');
	const local = await reopened.read('custom-1', 'http://127.0.0.1:11434');
	assert.deepEqual(local?.models, ['local-verified']);
	assert.equal(local?.baseUrl, 'http://127.0.0.1:11434/v1');
	assert.equal(local?.source, 'provider');
	assert.match(local?.updatedAt ?? '', /^\d{4}-/u);
	assert.deepEqual((await reopened.read('custom-1', 'http://127.0.0.1:11434/v1'))?.models, ['local-verified']);
	assert.equal(await reopened.read('custom-1', 'http://127.0.0.1:5678'), undefined);
	const localDetails = reopened.details('custom-1', 'local-verified', 'http://127.0.0.1:11434/v1');
	assert.doesNotMatch(JSON.stringify(localDetails), /nativeWebSearch/u);
	assert.equal(localDetails?.structuredOutput, false);
	assert.equal(localDetails?.videoInput, true);
	assert.deepEqual(prefillModelConfiguration(undefined, localDetails).input, ['text', 'video']);
	assert.equal(await reopened.read('custom-1', 'http://127.0.0.1:11434/v1', undefined, 'anthropic-messages'), undefined);
	assert.equal(reopened.details('custom-1', 'local-verified', 'http://127.0.0.1:5678'), undefined);
	assert.deepEqual(requests, []);

	omitProviderField = true;
	await reopened.refresh();
	assert.doesNotMatch(await readFile(paths.modelCatalog, 'utf8'), /nativeWebSearch/u);
	const refreshed = await reopened.read('openrouter', undefined, 'linked-secret');
	assert.equal(refreshed?.details?.get('google/gemini-3.8-flash')?.contextWindow, 250000);
	assert.deepEqual(refreshed?.details?.get('google/gemini-3.8-flash')?.evidence?.contextWindow, details?.evidence?.contextWindow);
	failProvider = true;
	failLocal = true;
	await addRetiredFields();
	settings.customProviders['custom-1'].baseUrl += '/v1';
	assert.equal((await reopened.refresh()).failed, 2);
	const stale = await reopened.read('openrouter', undefined, 'linked-secret');
	assert.equal(stale?.stale, true);
	assert.equal(stale?.updatedAt, refreshed?.updatedAt);
	assert.deepEqual(stale?.models, stored?.models);
	assert.equal(stale?.details?.get('google/gemini-3.8-flash')?.contextWindow, details?.contextWindow);
	assert.deepEqual((await reopened.read('custom-1', 'http://127.0.0.1:11434'))?.models, ['local-verified']);
	assert.doesNotMatch(await readFile(paths.modelCatalog, 'utf8'), /nativeWebSearch/u);
	reopened.dispose();
});

void test('OpenCode lists refresh before configuration and an unavailable supplement cannot block a successful official refresh', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-opencode-catalog-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const { paths } = await openVaultStorage(root, join(root, 'legacy'), { storageVersion: 1 });
	const settings = normalizeSettings(null);
	const credentials: CredentialStore = {
		read: async (id) => settings.communication.credentialIds[id] ? { type: 'api_key', key: 'workspace-key' } : undefined,
		list: async () => [],
		modify: async (_id, update) => update(undefined),
		delete: async () => {},
	};
	let supplementAvailable = true;
	const fetch: Transport['fetch'] = async (input, init) => {
		const url = new URL(new Request(input).url);
		const key = new Headers(init?.headers).get('authorization');
		if (url.hostname === 'models.dev') {
			assert.equal(key, null);
			return supplementAvailable ? Response.json({}) : new Response(null, { status: 503 });
		}
		assert.equal(url.hostname, 'opencode.ai');
		if (url.pathname === '/inference/go/v1/models') {
			assert.equal(key, null);
			return Response.json({ data: [{ id: 'qwen4-max', type: 'chat' }] });
		}
		assert.equal(url.pathname, '/inference/v1/models');
		assert.equal(key, supplementAvailable ? null : 'Bearer workspace-key');
		return Response.json({ data: [
			...(!supplementAvailable ? [{ id: 'gpt-6.2-sol', type: 'chat' }] : []),
			{ id: 'gemini-4-hydrogen', type: 'chat', modalities: { input: ['text', 'image/jpeg', 'image/png', 'audio/wav', 'video/mp4'] },
				limit: { context: 1048576, output: 65536 },
				capabilities: { reasoning: { supported: true, effort: ['low', 'high'] }, tools: { supported: true } },
				recommended_api: 'interactions', api: { 'generate-content': { base_url: 'https://opencode.ai/inference/google/v1beta' } } },
			{ id: 'gpt-image-2.5-sunburst', type: 'image' },
		] });
	};
	const transport: Transport = { fetch, configure: () => {}, onStatus: () => () => {}, logs: () => [] };
	const service = createModelService(credentials, transport);
	const models = { ...service, providers: () => service.providers().filter(({ id }) => id === 'opencode' || id === 'opencode-go') };
	const store = createModelCatalogStore(paths.modelCatalog, settings, models, fetch);
	t.after(() => store.dispose());
	const observed: Array<string | undefined> = [];
	const unsubscribe = store.subscribeProtocols(() => observed.push(store.protocol('opencode', 'gemini-4-hydrogen')));
	assert.deepEqual(await store.refresh(), { updated: 2, failed: 0 });
	assert.deepEqual(observed, ['google-generative-ai']);
	unsubscribe();
	const zen = await store.read('opencode', undefined, 'new-draft-key');
	assert.deepEqual(zen?.models, ['gemini-4-hydrogen']);
	assert.equal(zen?.source, 'provider');
	const { evidence, ...gemini } = zen?.details?.get('gemini-4-hydrogen') ?? {};
	assert.deepEqual(gemini, {
		inputModalities: ['text', 'image', 'audio', 'video'], reasoning: true, tools: true, reportedThinkingLevels: ['low', 'high'],
		connectionProtocol: 'google-generative-ai',
		contextWindow: 1048576, maxTokens: 65536,
		outputModalities: ['text'], thinkingLevels: ['low', 'medium', 'high', 'xhigh'],
	});
	assert.equal(evidence?.connectionProtocol?.source, 'provider');
	assert.equal(evidence?.reportedThinkingLevels?.source, 'provider');
	assert.equal(evidence?.thinkingLevels?.source, 'bundled');
	assert.deepEqual((await store.read('opencode-go'))?.models, ['qwen4-max']);

	settings.communication.credentialIds.opencode = 'saved-key';
	supplementAvailable = false;
	assert.deepEqual(await store.refresh(), { updated: 2, failed: 1 });
	assert.equal(observed.length, 1);
	assert.deepEqual((await store.read('opencode', undefined, 'saved-key'))?.models, ['gpt-6.2-sol', 'gemini-4-hydrogen']);

	const noNetwork = () => { throw new Error('Test must not send any request'); };
	const reopened = createModelCatalogStore(paths.modelCatalog, settings, models, noNetwork);
	t.after(() => reopened.dispose());
	await reopened.loadProtocols();
	const offline = await reopened.read('opencode', undefined, 'saved-key');
	const initial = prefillModelConfiguration(undefined, offline?.details?.get('gemini-4-hydrogen'));
	assert.deepEqual(initial.input, ['text', 'image', 'audio', 'video']);
	assert.equal(initial.contextWindow, 1048576);
	assert.equal(initial.maxTokens, 65536);
	assert.deepEqual(initial.thinkingLevels, ['low', 'high']);
	assert.equal(reopened.protocol('opencode', 'gemini-4-hydrogen', 'another-key'), undefined);
	const overrides: Record<string, ModelOverride> = {};
	const chat = createModelService(credentials, { ...transport, fetch: noNetwork }, {
		catalogProtocol: (id, model) => reopened.protocol(id, model),
		modelOverrides: () => ({ opencode: overrides }),
	});
	assert.deepEqual(chat.modelConnection?.('opencode', 'gemini-4-hydrogen'), {
		baseUrl: 'https://opencode.ai/inference/google/v1beta', api: 'google-generative-ai',
		source: 'catalog',
	});
	assert.deepEqual(chat.modelConnection?.('opencode-go', 'new-id-without-metadata'), {
		baseUrl: 'https://opencode.ai/inference/go/openai/v1', api: 'openai-completions',
		source: 'compatible',
	});
	const rejected = new Error('Stopped before sending');
	let destination: string | undefined;
	const send = () => chat.send({
		providerId: 'opencode', model: 'gemini-4-hydrogen', tools: [], messages: [{ role: 'user', content: 'Test' }],
		maxRetries: 0, signal: AbortSignal.timeout(3000),
		beforeSend: async (address) => { destination = address; throw rejected; },
	});
	await assert.rejects(send(), (error: unknown) => error === rejected);
	assert.equal(destination, 'https://opencode.ai/inference/google/v1beta/models/gemini-4-hydrogen:streamGenerateContent');
	overrides['gemini-4-hydrogen'] = { protocol: 'openai-completions' };
	assert.deepEqual(chat.modelConnection?.('opencode', 'gemini-4-hydrogen'), {
		baseUrl: 'https://opencode.ai/inference/openai/v1', api: 'openai-completions', source: 'configured',
	});
	await assert.rejects(send(), (error: unknown) => error === rejected);
	assert.equal(destination, 'https://opencode.ai/inference/openai/v1/chat/completions');
	for (const baseUrl of ['https://opencode.ai/inference/google/v1beta', 'https://opencode.ai/inference/go/openai/v1']) {
		overrides['gemini-4-hydrogen'] = { protocol: 'openai-completions', baseUrl };
		destination = undefined;
		assert.throws(send, /协议或 OpenCode 套餐不匹配/u);
		assert.equal(destination, undefined);
	}
});
