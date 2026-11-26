import type { CustomProviderSettings, LegacyWritingRules, ModelOverride, ScribeSettings, SkillSettings } from '../../types';
import { normalizeMcpSettings } from '../../tools/external/mcpConfig';
import { normalizeWebSearchSettings } from '../../tools/external/webSearchSettings';
import { normalizeVaultRelativePath } from '../../tools/support/pathUtils';
import { DEFAULT_SUBAGENT_SETTINGS, normalizeSubagentSettings } from './subagentSettings';
import { chatModelKey, isThinkingLevel } from './thinking';
import { normalizePresets } from '../../interaction/slashPresets';
import { isProviderEnabled, reconcileDefaultModel } from './modelAvailability';

export function normalizeSkillSettings(raw?: Partial<SkillSettings>): SkillSettings {
	const strings = (items: unknown) => Array.isArray(items) ? [...new Set(items.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())))] : [];
	const percent = raw?.catalogBudgetPercent;
	const max = raw?.catalogBudgetMaxTokens;
	return {
		sharedDirectories: strings(raw?.sharedDirectories),
		disabledIds: strings(raw?.disabledIds),
		catalogBudgetPercent: typeof percent === 'number' && percent > 0 && percent <= 100 ? percent : 2,
		catalogBudgetMaxTokens: typeof max === 'number' && Number.isSafeInteger(max) && max > 0 ? max : 10_000,
	};
}

export const DEFAULT_SETTINGS: ScribeSettings = {
	providerId: '',
	model: '',
	providerModels: {},
	disabledProviderIds: [],
	modelOverrides: {},
	thinkingByModel: {},
	customProviders: {},
	chatLocation: 'right-sidebar',
	confirmChatRemoval: true,
	logRetentionDays: 30,
	spillCleanupDays: 30,
	subagents: DEFAULT_SUBAGENT_SETTINGS,
	skillSettings: normalizeSkillSettings(),
	mcp: normalizeMcpSettings(undefined),
	webSearch: normalizeWebSearchSettings(),
	videoLinkModel: null,
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
	const legacyRules = (value: LegacyWritingRules | undefined): LegacyWritingRules | undefined => {
		const vault = typeof value?.vault === 'string' ? value.vault.trim() : '';
		const folders = Object.fromEntries(Object.entries(strings(value?.folders)).flatMap(([path, rule]) => {
			const folder = normalizeVaultRelativePath(path);
			return folder && rule.trim() ? [[folder, rule.trim()]] : [];
		}));
		return vault || Object.keys(folders).length ? { vault, folders } : undefined;
	};
	const writingRules = legacyRules(stored.writingRules);
	const writingRulesBackup = legacyRules(stored.writingRulesBackup);
	const validVideoModel = (selection: ScribeSettings['videoLinkModel']) =>
		typeof selection?.providerId === 'string' && selection.providerId.trim() && typeof selection.model === 'string' && selection.model.trim()
			? { providerId: selection.providerId, model: selection.model } : undefined;
	const videoModel = validVideoModel(stored.videoModel);
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
	// 每模型覆盖配置：忽略无效条目，移除已退役的能力设置。
	const modelOverrides: ScribeSettings['modelOverrides'] = {};
	const rawOverrides = stored.modelOverrides as unknown;
	if (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
		for (const [providerId, perProvider] of Object.entries(rawOverrides as Record<string, unknown>)) {
			if (!perProvider || typeof perProvider !== 'object' || Array.isArray(perProvider)) continue;
			const models: Record<string, ModelOverride> = {};
			for (const [modelId, override] of Object.entries(perProvider as Record<string, unknown>)) {
				if (!override || typeof override !== 'object' || Array.isArray(override)) continue;
				const modelOverride = { ...override as ModelOverride };
				const current = modelOverride.capabilities;
				if (current && typeof current === 'object' && 'nativeWebSearch' in current) {
					const { nativeWebSearch: _removed, ...capabilities } = current;
					if (Object.keys(capabilities).length) modelOverride.capabilities = capabilities;
					else delete modelOverride.capabilities;
				}
				if (Object.keys(modelOverride).length) models[modelId] = modelOverride;
			}
			if (Object.keys(models).length) modelOverrides[providerId] = models;
		}
	}
	const settings: ScribeSettings = {
		providerId,
		model,
		providerModels,
		disabledProviderIds: Array.isArray(stored.disabledProviderIds)
			? [...new Set(stored.disabledProviderIds.filter((id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(providerModels, id)))]
			: [],
		modelOverrides,
		thinkingByModel,
		customProviders,
		chatLocation: stored.chatLocation === 'right-sidebar'
			|| stored.chatLocation === 'left-sidebar'
			|| stored.chatLocation === 'editor-tab'
			? stored.chatLocation
			: DEFAULT_SETTINGS.chatLocation,
		confirmChatRemoval: typeof stored.confirmChatRemoval === 'boolean'
			? stored.confirmChatRemoval
			: DEFAULT_SETTINGS.confirmChatRemoval,
		logRetentionDays: typeof stored.logRetentionDays === 'number' && Number.isSafeInteger(stored.logRetentionDays) && stored.logRetentionDays >= 0
			? stored.logRetentionDays
			: DEFAULT_SETTINGS.logRetentionDays,
		spillCleanupDays: typeof stored.spillCleanupDays === 'number'
			&& Number.isSafeInteger(stored.spillCleanupDays)
			&& stored.spillCleanupDays >= 0
			? stored.spillCleanupDays
			: DEFAULT_SETTINGS.spillCleanupDays,
		subagents: normalizeSubagentSettings(stored.subagents),
		skillSettings: normalizeSkillSettings(stored.skillSettings),
		mcp: normalizeMcpSettings(stored.mcp),
		webSearch: normalizeWebSearchSettings(stored.webSearch),
		...(videoModel && { videoModel }),
		videoLinkModel: (stored.videoLinkModel === undefined ? videoModel : validVideoModel(stored.videoLinkModel)) ?? null,
		...(stored.slashPresets !== undefined ? { slashPresets: normalizePresets(stored.slashPresets) } : {}),
		...(writingRules ? { writingRules } : {}),
		...(writingRulesBackup ? { writingRulesBackup } : {}),
		communication: {
			credentialIds: strings(stored.communication?.credentialIds),
			proxyUrl: typeof stored.communication?.proxyUrl === 'string' ? stored.communication.proxyUrl : '',
			...(typeof stored.communication?.proxyCredentialId === 'string' && stored.communication.proxyCredentialId
				&& { proxyCredentialId: stored.communication.proxyCredentialId }),
			providerNames: strings(stored.communication?.providerNames),
			baseUrls: strings(stored.communication?.baseUrls),
			protocols: strings(stored.communication?.protocols),
		},
	};
	if ((!providerId && !model) || !isProviderEnabled(settings, providerId)) reconcileDefaultModel(settings);
	return settings;
}
