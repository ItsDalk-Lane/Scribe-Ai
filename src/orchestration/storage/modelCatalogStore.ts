import { isVolcengineSubscriptionProvider } from '../../communication/extraProviders';
import { documentedModelDetails, mergeModelCatalogDetails, sourceModelCatalogDetails } from '../../communication/modelCatalog';
import { openCodeConnection } from '../../communication/openCodeModels';
import type { ModelCatalogDetails, ModelCatalogResult, ModelService, ModelProviderInfo, ScribeSettings } from '../../types';

export type Catalog = ModelCatalogResult & { baseUrl?: string };
type CatalogSettings = Pick<ScribeSettings, 'customProviders' | 'communication'>;
export type CatalogConnection = { baseUrl?: string; credentialId?: string; protocol?: string };
type CatalogReader = Pick<ModelService, 'listProviderModels' | 'listCustomModels'>;
const sourcePriority: Record<Catalog['source'], number> = { provider: 4, docs: 3, pi: 2, 'models.dev': 1, bundled: 0 };

export interface ModelCatalogStore {
	read(providerId: string, baseUrl?: string, credentialId?: string, protocol?: string): Promise<Catalog | undefined>;
	fetchConnection(provider: ModelProviderInfo, options: CatalogConnection, models: CatalogReader, signal: AbortSignal): Promise<Catalog | undefined>;
	rememberConnection(provider: ModelProviderInfo, options: CatalogConnection, result: Catalog): Promise<void>;
	details(providerId: string, model: string, baseUrl?: string): ModelCatalogDetails | undefined;
	protocol(providerId: string, model: string, credentialId?: string): string | undefined;
	subscribeProtocols(listener: () => void): () => void;
	clearSettings(): void;
	dispose(): void;
}

function address(value?: string): string {
	const trimmed = value?.trim() ?? '';
	return (URL.parse(trimmed)?.href ?? trimmed).replace(/\/+$/u, '');
}

export function catalogConnectionKey({ baseUrl, credentialId, protocol }: CatalogConnection): string {
	return JSON.stringify([address(baseUrl), credentialId || '', protocol || '']);
}

export function catalogConnection(settings: CatalogSettings, provider: ModelProviderInfo): CatalogConnection {
	const custom = settings.customProviders[provider.id];
	const base = address(settings.communication.baseUrls[provider.id] || custom?.baseUrl);
	const protocol = settings.communication.protocols[provider.id] || custom?.protocol;
	return {
		baseUrl: custom || (base && base !== address(provider.baseUrl)) ? base : undefined,
		credentialId: settings.communication.credentialIds[provider.id],
		protocol: custom || protocol !== provider.protocol ? protocol : undefined,
	};
}

export async function queryCatalog(provider: ModelProviderInfo, options: CatalogConnection, models: CatalogReader,
	signal: AbortSignal): Promise<Catalog | undefined> {
	if (options.baseUrl === '') return;
	if (options.baseUrl) return { ...await models.listCustomModels(provider.id, options.baseUrl, signal), source: 'provider' };
	if (options.protocol && isVolcengineSubscriptionProvider(provider.id)) return;
	return models.listProviderModels(provider.id, signal);
}

function bundledCatalog(provider: ModelProviderInfo): Catalog {
	const details = new Map<string, ModelCatalogDetails>(provider.models.map((model) => [model.id, {
		type: 'text', contextWindow: model.contextWindow || undefined, maxTokens: model.maxTokens || undefined,
		reasoning: model.reasoning, thinkingLevels: model.thinkingLevels, inputModalities: model.input, outputModalities: ['text'],
	}]));
	for (const [id, type] of provider.nonChatModelTypes ?? []) if (!details.has(id)) details.set(id, { type });
	return { source: 'bundled', models: provider.models.map(({ id }) => id),
		details: mergeModelCatalogDetails(details, documentedModelDetails(provider.id)) };
}

export function createModelCatalogStore(settings: CatalogSettings, models: Pick<ModelService, 'providers'>): ModelCatalogStore {
	type Entry = { providerId: string; options: CatalogConnection; result: Catalog; order: number };
	let epoch = new AbortController();
	let fetched = new WeakMap<Catalog, Entry>();
	let sequence = 0;
	const catalogs = new Map<string, Entry>();
	const listeners = new Set<() => void>();
	let disposed = false;
	const providerById = (id: string) => models.providers().find((provider) => provider.id === id);
	const match = (entry: Entry, current: CatalogConnection) => {
		if (catalogConnectionKey(entry.options) === catalogConnectionKey(current)) return true;
		const base = address(entry.options.baseUrl);
		return Boolean(base && entry.result.baseUrl === base + '/v1'
			&& catalogConnectionKey({ ...entry.options, baseUrl: entry.result.baseUrl }) === catalogConnectionKey(current));
	};
	const find = (id: string, options: CatalogConnection) => {
		const entry = catalogs.get(id);
		return entry && match(entry, options) ? entry : undefined;
	};
	const notify = () => {
		for (const listener of listeners) {
			try { listener(); } catch { /* 目录变更与界面重绘分开。 */ }
		}
	};
	const publish = (provider: ModelProviderInfo, entry: Entry) => {
		if ((catalogs.get(provider.id)?.order ?? 0) >= entry.order || !match(entry, catalogConnection(settings, provider))) return;
		catalogs.set(provider.id, entry);
		notify();
	};
	const clearSettings = () => {
		epoch.abort();
		epoch = new AbortController();
		fetched = new WeakMap();
		const changed = catalogs.size > 0;
		catalogs.clear();
		if (changed) notify();
	};
	return {
		async read(id, baseUrl, credentialId, protocol) {
			const provider = providerById(id);
			if (!provider) return;
			const selected = { baseUrl, credentialId, protocol: protocol ?? catalogConnection(settings, provider).protocol };
			return find(id, selected)?.result ?? (baseUrl === undefined && !selected.protocol && !settings.customProviders[id]
				? bundledCatalog(provider) : undefined);
		},
		async fetchConnection(provider, options, reader, requestSignal) {
			if (disposed) return;
			const signal = AbortSignal.any([epoch.signal, requestSignal]);
			signal.throwIfAborted();
			const order = ++sequence;
			const incoming = await queryCatalog(provider, options, reader, signal).catch(() => undefined);
			signal.throwIfAborted();
			const known = find(provider.id, options)?.result;
			if (!incoming && !known) return;
			const keepPrevious = known && (!incoming || sourcePriority[known.source] > sourcePriority[incoming.source]);
			const base = keepPrevious ? { ...known, stale: true as const } : incoming;
			if (!base) return;
			const checkedAt = new Date().toISOString();
			const result = {
				...base, updatedAt: keepPrevious ? base.updatedAt : checkedAt,
				details: mergeModelCatalogDetails(known?.details, incoming && sourceModelCatalogDetails(incoming.details, incoming.source, checkedAt)),
			};
			const entry = { providerId: provider.id, options, result, order };
			fetched.set(result, entry);
			publish(provider, entry);
			return result;
		},
		async rememberConnection(provider, options, result) {
			const entry = fetched.get(result);
			if (entry?.providerId === provider.id && match(entry, options)) publish(provider, entry);
		},
		details(id, model, baseUrl) {
			const provider = providerById(id);
			if (!provider) return;
			const current = { ...catalogConnection(settings, provider), baseUrl };
			return find(id, current)?.result.details?.get(model);
		},
		protocol(id, model, credentialId = settings.communication.credentialIds[id]) {
			const provider = providerById(id);
			if (!provider) return;
			const current = { ...catalogConnection(settings, provider), credentialId };
			if (current.baseUrl !== undefined || current.protocol) return;
			return openCodeConnection(id, find(id, current)?.result.details?.get(model)?.connectionProtocol)?.api;
		},
		subscribeProtocols(listener) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		clearSettings,
		dispose() {
			disposed = true;
			listeners.clear();
			clearSettings();
		},
	};
}
