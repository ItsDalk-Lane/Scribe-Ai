import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { documentedModelDetails, fetchModelsDevCatalog, fetchPiCatalog, mergeModelCatalogDetails, readStoredModelDetails, sourceModelCatalogDetails } from '../../communication/modelCatalog';
import { hasPublicModelCatalog } from '../../communication/modelCatalogProviders';
import { openCodeConnection, OPEN_CODE_MODEL_PROVIDERS } from '../../communication/openCodeModels';
import type { ModelCatalogDetails, ModelCatalogResult, ModelService, ModelProviderInfo, ScribeSettings, Transport } from '../../types';
import { ensureStoredDirectory, readStoredJson, storageStat, writeStoredJson } from './jsonFile';

type Catalog = ModelCatalogResult & { baseUrl?: string };
type CatalogSettings = Pick<ScribeSettings, 'customProviders' | 'communication'>;

interface StoredCatalog {
	key: string;
	models: string[];
	source: ModelCatalogResult['source'];
	details?: Record<string, ModelCatalogDetails>;
	versionPrefix?: true;
	protocol?: string;
	updatedAt?: string;
	stale?: true;
}

export interface ModelCatalogStore {
	read(providerId: string, baseUrl?: string, credentialId?: string, protocol?: string): Promise<Catalog | undefined>;
	loadProtocols(): Promise<void>;
	details(providerId: string, model: string, baseUrl?: string): ModelCatalogDetails | undefined;
	protocol(providerId: string, model: string, credentialId?: string): string | undefined;
	subscribeProtocols(listener: () => void): () => void;
	refresh(): Promise<{ updated: number; failed: number }>;
	dispose(): void;
}

function normalizeAddress(address?: string): string {
	const trimmed = address?.trim() ?? '';
	return (URL.parse(trimmed)?.href ?? trimmed).replace(/\/+$/, '');
}

function connectionKey(baseUrl?: string, credentialId?: string): string {
	return createHash('sha256').update(JSON.stringify([normalizeAddress(baseUrl), credentialId ?? ''])).digest('hex');
}

function usesSavedPrefix(entry: StoredCatalog, baseUrl: string | undefined, credentialId: string | undefined): boolean {
	const address = normalizeAddress(baseUrl);
	return entry.versionPrefix === true && address.endsWith('/v1')
		&& entry.key === connectionKey(address.slice(0, -3), credentialId);
}

function bundledCatalog(provider: ModelProviderInfo): ModelCatalogResult {
	const details = new Map(provider.models.map((model) => [model.id, {
		contextWindow: model.contextWindow || undefined,
		maxTokens: model.maxTokens || undefined,
		reasoning: model.reasoning,
		thinkingLevels: model.thinkingLevels,
		inputModalities: model.input,
		outputModalities: ['text'],
	} satisfies ModelCatalogDetails]));
	return { source: 'bundled', models: [...details.keys()], details };
}

function unpack(entry: StoredCatalog, baseUrl?: string): Catalog {
	const details = new Map(Object.entries(entry.details ?? {}).map(([id, value]) => [id, restoreDetails(value)]));
	return {
		models: entry.models,
		source: entry.source,
		details,
		...(entry.updatedAt && { updatedAt: entry.updatedAt }),
		...(entry.stale && { stale: true }),
		...(baseUrl && entry.versionPrefix && { baseUrl: normalizeAddress(baseUrl) + '/v1' }),
	};
}

function restoreDetails(value: unknown): ModelCatalogDetails {
	const details = readStoredModelDetails(value);
	if (details.structuredOutput === true && !details.evidence?.structuredOutput) {
		// Old snapshots did not distinguish generic JSON claims from schema support.
		delete details.structuredOutput;
		details.jsonOutput ??= true;
	}
	return details;
}

function isStoredCatalog(entry: unknown): entry is StoredCatalog {
	return Boolean(entry && typeof entry === 'object'
		&& 'key' in entry && typeof entry.key === 'string'
		&& 'source' in entry && (entry.source === 'provider' || entry.source === 'pi' || entry.source === 'bundled')
		&& 'models' in entry && Array.isArray(entry.models) && entry.models.every((id) => typeof id === 'string'));
}

async function readSnapshot(path: string): Promise<Map<string, StoredCatalog>> {
	const directory = await storageStat(dirname(path));
	if (!directory) return new Map();
	if (!directory.isDirectory()) throw new Error('Scribe Ai 的模型资料目录无效。');
	const value = await readStoredJson(path).catch((error: unknown) => {
		if (!(error instanceof SyntaxError)) throw error;
	});
	if (value === undefined) return new Map();
	if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
		|| !('providers' in value) || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) {
		throw new Error('Scribe Ai 的模型资料格式无法识别。');
	}
	return new Map(Object.entries(value.providers).filter((entry): entry is [string, StoredCatalog] => isStoredCatalog(entry[1])));
}

export function createModelCatalogStore(
	path: string, settings: CatalogSettings,
	models: Pick<ModelService, 'providers' | 'listProviderModels' | 'listCustomModels'>, fetch: Transport['fetch'],
): ModelCatalogStore {
	const lifetime = new AbortController();
	let pending: ReturnType<ModelCatalogStore['refresh']> | undefined;
	let snapshot = new Map<string, StoredCatalog>();
	const protocols = new Map<string, { key: string; byModel: Map<string, string> }>();
	const protocolListeners = new Set<() => void>();

	function indexSnapshot(entries: Map<string, StoredCatalog>) {
		snapshot = entries;
		protocols.clear();
		for (const id of OPEN_CODE_MODEL_PROVIDERS) {
			const entry = entries.get(id);
			if (!entry) continue;
			const byModel = new Map<string, string>();
			for (const model of entry.models) {
				const connection = openCodeConnection(id, entry.details?.[model]?.connectionProtocol);
				if (connection) byModel.set(model, connection.api);
			}
			protocols.set(id, { key: entry.key, byModel });
		}
	}

	function stored(entries: Map<string, StoredCatalog> | undefined, providerId: string, baseUrl?: string, credentialId?: string, protocol?: string) {
		const saved = entries?.get(providerId);
		return saved && saved.protocol === protocol && (saved.key === connectionKey(baseUrl, credentialId) || (!baseUrl && saved.key === connectionKey())
			|| usesSavedPrefix(saved, baseUrl, credentialId)) ? saved : undefined;
	}

	function configuredProtocol(providerId: string): string | undefined {
		const configured = settings.communication.protocols[providerId] || settings.customProviders[providerId]?.protocol;
		if (!configured) return undefined;
		const provider = models.providers().find(({ id }) => id === providerId);
		return settings.customProviders[providerId] || configured !== provider?.protocol ? configured : undefined;
	}

	function connection(provider: ModelProviderInfo) {
		const custom = settings.customProviders[provider.id];
		const savedAddress = normalizeAddress(settings.communication.baseUrls[provider.id] || custom?.baseUrl);
		const baseUrl = custom || (savedAddress && savedAddress !== normalizeAddress(provider.baseUrl)) ? savedAddress : undefined;
		const credentialId = settings.communication.credentialIds[provider.id];
		const configured = settings.communication.protocols[provider.id] || custom?.protocol;
		const protocol = configured && (custom || configured !== provider.protocol) ? configured : undefined;
		return { baseUrl, credentialId, key: connectionKey(baseUrl, credentialId), protocol };
	}

	async function refresh() {
		const signal = lifetime.signal;
		signal.throwIfAborted();
		const previous = await readSnapshot(path);
		const providers = models.providers();
		const targets = providers.map((provider) => ({ provider, ...connection(provider) }));
		const publicCatalog = fetchModelsDevCatalog(fetch, AbortSignal.any([signal, AbortSignal.timeout(8_000)])).catch(() => undefined);
		let piCatalog: Promise<unknown> | undefined;
		const sharedPiCatalog = () => piCatalog ??= fetchPiCatalog(fetch, AbortSignal.any([signal, AbortSignal.timeout(8_000)])).catch(() => undefined);
		const entries = new Map<string, StoredCatalog>();
		let updated = 0;
		let failed = 0;

		const refreshProvider = async ({ provider, baseUrl, credentialId, key, protocol }: (typeof targets)[number]) => {
			const { id } = provider;
			const publicProvider = !baseUrl && hasPublicModelCatalog(id);
			const saved = previous.get(id);
			const old = saved && saved.protocol === protocol && (saved.key === key || usesSavedPrefix(saved, baseUrl, credentialId)
				|| (publicProvider && saved.key === connectionKey())) ? saved : undefined;
			try {
				const catalog: Catalog = baseUrl
					? { ...await models.listCustomModels(id, baseUrl, signal), source: 'provider' }
					: await models.listProviderModels(id, signal, publicCatalog, sharedPiCatalog);
				const current = connection(provider);
				if (current.key !== key || current.protocol !== protocol) return;
				const checkedAt = new Date().toISOString();
				const catalogDetails = sourceModelCatalogDetails(catalog.details, catalog.source, checkedAt);
				const keepList = old && ((old.source === 'provider' && catalog.source !== 'provider')
					|| (old.source === 'pi' && catalog.source === 'bundled'));
				const details = mergeModelCatalogDetails(old && unpack(old).details, catalogDetails);
				entries.set(id, {
					key, protocol, models: keepList ? old.models : catalog.models, source: keepList ? old.source : catalog.source,
					updatedAt: keepList ? old.updatedAt : checkedAt, ...(keepList && { stale: true }),
					details: Object.fromEntries(details),
					...(baseUrl && catalog.baseUrl === baseUrl + '/v1' && { versionPrefix: true }),
				});
				if (keepList) failed++;
				else updated++;
			} catch {
				if (old) entries.set(id, { ...old, stale: true, details: Object.fromEntries(unpack(old).details ?? []) });
				failed++;
			}
		};
		for (let index = 0; index < targets.length; index += 8) {
			signal.throwIfAborted();
			await Promise.all(targets.slice(index, index + 8).map(refreshProvider));
		}
		if (!await publicCatalog) failed++;
		signal.throwIfAborted();
		if (updated || entries.size && failed) {
			await ensureStoredDirectory(dirname(path));
			signal.throwIfAborted();
			await writeStoredJson(path, { version: 1, providers: Object.fromEntries(entries) });
			indexSnapshot(entries);
			for (const listener of protocolListeners) {
				try { listener(); } catch { /* 已保存的目录不受界面更新影响。 */ }
			}
		}
		return { updated, failed };
	}

	return {
		async loadProtocols() {
			indexSnapshot(await readSnapshot(path).catch(() => new Map<string, StoredCatalog>()));
		},
		details(providerId, model, baseUrl) {
			const protocol = configuredProtocol(providerId);
			const entry = stored(snapshot, providerId, baseUrl, settings.communication.credentialIds[providerId], protocol);
			const details = entry && Object.prototype.hasOwnProperty.call(entry.details ?? {}, model)
				? restoreDetails(entry.details?.[model]) : undefined;
			if (baseUrl || protocol || settings.customProviders[providerId]) return details;
			const documented = documentedModelDetails(providerId).get(model);
			return documented ? mergeModelCatalogDetails(details && new Map([[model, details]]), new Map([[model, documented]])).get(model) : details;
		},
		protocol(providerId, model, credentialId = settings.communication.credentialIds[providerId]) {
			const entry = protocols.get(providerId);
			if (entry && (entry.key === connectionKey(undefined, credentialId) || entry.key === connectionKey())) {
				return entry.byModel.get(model);
			}
			return undefined;
		},
		subscribeProtocols(listener) {
			protocolListeners.add(listener);
			return () => { protocolListeners.delete(listener); };
		},
		async read(providerId, baseUrl, credentialId, protocol = configuredProtocol(providerId)) {
			protocol ||= undefined;
			const previous = await readSnapshot(path).catch(() => undefined);
			const saved = stored(previous, providerId, baseUrl, credentialId, protocol);
			if (saved) {
				const catalog = unpack(saved, baseUrl);
				if (!baseUrl && !protocol) catalog.details = mergeModelCatalogDetails(catalog.details, documentedModelDetails(providerId));
				return catalog;
			}
			const legacy = protocol && stored(previous, providerId, baseUrl, credentialId);
			if (legacy && !legacy.updatedAt) return { ...unpack(legacy, baseUrl), details: undefined, stale: true };
			if (baseUrl || protocol || settings.customProviders[providerId]) return undefined;
			const provider = models.providers().find(({ id }) => id === providerId);
			if (!provider) return undefined;
			const catalog = bundledCatalog(provider);
			return { ...catalog, details: mergeModelCatalogDetails(catalog.details, documentedModelDetails(providerId)) };
		},
		refresh() {
			pending ??= refresh().finally(() => { pending = undefined; });
			return pending;
		},
		dispose() {
			lifetime.abort();
			protocolListeners.clear();
		},
	};
}
