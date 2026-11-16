import type { ScribeSettings } from '../../types';

export const DEFAULT_SETTINGS: ScribeSettings = {
	enabled: true,
	providerId: '',
	model: '',
	run: { maxTurns: 20, maxToolCallsPerTurn: 8, maxContextNotes: 20 },
	communication: { credentialIds: {}, proxyUrl: '' },
};

/** 配置校验与迁移：磁盘上的旧配置补齐缺省值，字段类型不符时回落到默认值 */
export function normalizeSettings(raw: Partial<ScribeSettings> | null): ScribeSettings {
	const stored = raw ?? {};
	const run = { ...DEFAULT_SETTINGS.run, ...stored.run };
	const storedCredentials = stored.communication?.credentialIds;
	return {
		enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_SETTINGS.enabled,
		providerId: stored.providerId ?? DEFAULT_SETTINGS.providerId,
		model: stored.model ?? DEFAULT_SETTINGS.model,
		run,
		communication: {
			credentialIds: storedCredentials && typeof storedCredentials === 'object' && !Array.isArray(storedCredentials)
				? { ...storedCredentials }
				: {},
			proxyUrl: typeof stored.communication?.proxyUrl === 'string' ? stored.communication.proxyUrl : '',
		},
	};
}
