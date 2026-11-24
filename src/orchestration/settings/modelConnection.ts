import type { ModelService, RunContext, ScribeSettings } from '../../types';

function connectionKey(settings: ScribeSettings, provider: string, model: string): string {
	return JSON.stringify([
		settings.customProviders[provider],
		settings.communication.baseUrls[provider],
		settings.communication.protocols[provider],
		settings.communication.credentialIds[provider],
		settings.communication.proxyUrl,
		settings.modelOverrides[provider]?.[model],
		settings.providerModels[provider]?.[0],
		settings.providerModels[provider]?.includes(model),
	]);
}

export function guardModelConnection(
	settings: ScribeSettings, { providerId, model }: RunContext['model'], resolve?: ModelService['modelConnection'],
): () => void {
	const read = () => {
		const route = resolve?.(providerId, model);
		return JSON.stringify([connectionKey(settings, providerId, model), route?.api, route?.baseUrl, route?.issue]);
	};
	const original = read();
	return () => {
		if (original !== read()) {
			throw new Error('运行期间模型连接设置已变更，请重新提交任务。');
		}
	};
}
