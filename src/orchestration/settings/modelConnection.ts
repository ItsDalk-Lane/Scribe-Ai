import { createHash } from 'node:crypto';
import type { ModelService, QueuedModelDestination, RunContext, ScribeSettings } from '../../types';

export function queuedModelDestination({ providerId, model }: RunContext['model'], resolve?: ModelService['modelConnection']): QueuedModelDestination | undefined {
	const route = resolve?.(providerId, model);
	const url = route && !route.issue && URL.parse(route.baseUrl);
	if (!route || !url) return;
	return { providerId, model, baseUrl: url.origin + url.pathname, api: route.api,
		fingerprint: createHash('sha256').update(url.href).digest('hex') };
}

export function sameQueuedDestination(a: QueuedModelDestination | undefined, b: QueuedModelDestination | undefined): boolean {
	return a?.providerId === b?.providerId && a?.model === b?.model && a?.baseUrl === b?.baseUrl
		&& a?.api === b?.api && a?.fingerprint === b?.fingerprint;
}

function connectionKey(settings: ScribeSettings, provider: string, model: string): string {
	return JSON.stringify([
		settings.customProviders[provider],
		settings.communication.baseUrls[provider],
		settings.communication.protocols[provider],
		settings.communication.credentialIds[provider],
		settings.communication.proxyUrl,
		settings.communication.proxyCredentialId,
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
