import { AsyncLocalStorage } from 'node:async_hooks';
import { isOpenCodeProvider, openCodeConnection } from '../../communication/openCodeModels';
import type { ModelCatalogDetails, ModelProviderInfo, ModelService, ScribeSettings } from '../../types';
import { catalogConnection, catalogConnectionKey, queryCatalog } from '../storage/modelCatalogStore';

export function createRuntimeModelCatalog(settings: ScribeSettings, models: () => ModelService) {
	type Selection = { providerId: string; model: string };
	type Prepared = { provider: ModelProviderInfo; connection: string; details?: ModelCatalogDetails; protocol?: string };
	type Scope = { prepared: Map<string, Prepared>; pending: Map<string, Promise<void>>; users: number };
	const scope = new AsyncLocalStorage<Scope>();
	const key = ({ providerId, model }: Selection) => JSON.stringify([providerId, model]);

	function lookup(providerId: string, model: string, baseUrl?: string, checkBase = false): Prepared | undefined {
		const result = scope.getStore()?.prepared.get(key({ providerId, model }));
		if (!result) return;
		const current = catalogConnection(settings, result.provider);
		if (result.connection !== catalogConnectionKey(checkBase ? { ...current, baseUrl } : current)) return;
		return result;
	}

	async function withPreparedModels<T>(work: () => Promise<T>): Promise<T> {
		const use = async (current: Scope) => {
			current.users++;
			try { return await work(); }
			finally {
				if (--current.users === 0) {
					current.prepared.clear();
					current.pending.clear();
				}
			}
		};
		const parent = scope.getStore();
		if (parent?.users) return use(parent);
		const current: Scope = { prepared: new Map(), pending: new Map(), users: 0 };
		return scope.run(current, () => use(current));
	}

	async function prepareModel(selection: Selection, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const current = scope.getStore();
		if (!current?.users || lookup(selection.providerId, selection.model)) return;
		const { providerId, model } = selection;
		const service = models();
		const provider = service.providers().find((item) => item.id === providerId);
		if (!provider) return;
		const connection = catalogConnection(settings, provider);
		const binding = catalogConnectionKey(connection);
		const taskKey = key(selection);
		const existing = current.pending.get(taskKey);
		if (existing) {
			await existing;
			signal?.throwIfAborted();
			return;
		}
		const load = async () => {
			const override = settings.modelOverrides[providerId]?.[model];
			const known = provider.models.some(({ id }) => id === model) || provider.nonChatModelTypes?.has(model);
			// 已随插件提供的默认模型可以按本地资料解析。自建或未知条目在使用时核对目录。
			if (known && !isOpenCodeProvider(providerId) && !connection.baseUrl && !connection.protocol) {
				current.prepared.set(taskKey, { provider, connection: binding });
				return;
			}
			const requestSignal = signal ?? new AbortController().signal;
			const catalog = await queryCatalog(provider, connection, service, requestSignal).catch(() => undefined);
			requestSignal.throwIfAborted();
			if (!current.users) throw new Error('模型任务已结束。');
			if (binding !== catalogConnectionKey(catalogConnection(settings, provider))) {
				throw new Error('查询模型资料期间连接已变更，请重新提交。');
			}
			const details = catalog?.details?.get(model);
			const protocol = !connection.baseUrl && !connection.protocol
				? openCodeConnection(providerId, details?.connectionProtocol)?.api : undefined;
			if (isOpenCodeProvider(providerId) && !known && !protocol && !override?.protocol?.trim() && !connection.protocol) {
				throw new Error('无法确认所选 OpenCode 模型的 API 协议，请在模型配置中明确选择后重试。');
			}
			current.prepared.set(taskKey, { provider, connection: binding, details, protocol });
		};
		const task = load();
		current.pending.set(taskKey, task);
		try { await task; }
		finally { if (current.pending.get(taskKey) === task) current.pending.delete(taskKey); }
	}

	return {
		active: () => scope.getStore() !== undefined,
		withPreparedModels,
		prepareModel,
		details: (id: string, model: string, baseUrl?: string) => lookup(id, model, baseUrl, true)?.details,
		protocol: (id: string, model: string) => lookup(id, model)?.protocol,
	};
}
