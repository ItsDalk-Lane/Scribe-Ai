import type { CustomProviderSettings, ModelOverride, ScribeSettings } from '../../types';
import { chatModelKey, isThinkingLevel } from './thinking';

export const DEFAULT_SETTINGS: ScribeSettings = {
	providerId: '',
	model: '',
	providerModels: {},
	modelOverrides: {},
	thinkingByModel: {},
	customProviders: {},
	chatLocation: 'right-sidebar',
	communication: { credentialIds: {}, proxyUrl: '', providerNames: {}, baseUrls: {}, protocols: {} },
};

/** 配置校验与迁移：磁盘上的旧配置补齐缺省值，字段类型不符时回落到默认值 */
export function normalizeSettings(raw: Partial<ScribeSettings> | null): ScribeSettings {
	const stored = raw ?? {};
	const strings = (value: unknown): Record<string, string> => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
		);
	};
	const providerId = stored.providerId ?? DEFAULT_SETTINGS.providerId;
	const model = stored.model ?? DEFAULT_SETTINGS.model;
	const providerModels: Record<string, string[]> = {};
	const rawProviderModels = stored.providerModels as unknown;
	if (rawProviderModels && typeof rawProviderModels === 'object' && !Array.isArray(rawProviderModels)) {
		for (const [key, value] of Object.entries(rawProviderModels as Record<string, unknown>)) {
			// 旧版本存的是单个模型字符串，新版本存字符串数组
			if (typeof value === 'string' && value) providerModels[key] = [value];
			else if (Array.isArray(value)) {
				providerModels[key] = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
			}
		}
	}
	// 旧配置只有一对 providerId/model，迁移成按服务商记录的模型表
	if (providerId && model && !providerModels[providerId]) providerModels[providerId] = [model];
	const thinkingByModel: ScribeSettings['thinkingByModel'] = {};
	const rawThinking = stored.thinkingByModel;
	if (rawThinking && typeof rawThinking === 'object' && !Array.isArray(rawThinking)) {
		for (const [id, models] of Object.entries(providerModels)) {
			for (const modelId of models) {
				const key = chatModelKey(id, modelId);
				const level = rawThinking[key];
				if (isThinkingLevel(level)) thinkingByModel[key] = level;
			}
		}
	}
	// 自建服务商：三个字段都必须是字符串
	const customProviders: ScribeSettings['customProviders'] = {};
	const rawCustom = stored.customProviders as unknown;
	if (rawCustom && typeof rawCustom === 'object' && !Array.isArray(rawCustom)) {
		for (const [id, entry] of Object.entries(rawCustom as Record<string, unknown>)) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
			const value = entry as Partial<CustomProviderSettings>;
			customProviders[id] = {
				label: typeof value.label === 'string' ? value.label : id,
				baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
				protocol: typeof value.protocol === 'string' ? value.protocol : '',
			};
		}
	}
	// 每模型覆盖配置：只保留对象形态，字段在读取时再逐项使用
	const modelOverrides: ScribeSettings['modelOverrides'] = {};
	const rawOverrides = stored.modelOverrides as unknown;
	if (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
		for (const [providerId, perProvider] of Object.entries(rawOverrides as Record<string, unknown>)) {
			if (!perProvider || typeof perProvider !== 'object' || Array.isArray(perProvider)) continue;
			const models: Record<string, ModelOverride> = {};
			for (const [modelId, override] of Object.entries(perProvider as Record<string, unknown>)) {
				if (override && typeof override === 'object' && !Array.isArray(override)) models[modelId] = override;
			}
			if (Object.keys(models).length) modelOverrides[providerId] = models;
		}
	}
	return {
		providerId,
		model,
		providerModels,
		modelOverrides,
		thinkingByModel,
		customProviders,
		chatLocation: stored.chatLocation === 'right-sidebar'
			|| stored.chatLocation === 'left-sidebar'
			|| stored.chatLocation === 'editor-tab'
			? stored.chatLocation
			: DEFAULT_SETTINGS.chatLocation,
		communication: {
			credentialIds: strings(stored.communication?.credentialIds),
			proxyUrl: typeof stored.communication?.proxyUrl === 'string' ? stored.communication.proxyUrl : '',
			providerNames: strings(stored.communication?.providerNames),
			baseUrls: strings(stored.communication?.baseUrls),
			protocols: strings(stored.communication?.protocols),
		},
	};
}
