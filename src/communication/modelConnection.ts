import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import type { ModelConnection, ModelConnectionIssue, ModelOverride } from '../types';
import { isOpenCodeProvider, openCodeConfiguredAddress, openCodeConnection } from './openCodeModels';

const responsesAddresses = new Map([
	['groq', 'https://api.groq.com/openai/v1'],
	['huggingface', 'https://router.huggingface.co/v1'],
	['moonshotai', 'https://api.moonshot.ai/v1'],
	['moonshotai-cn', 'https://api.moonshot.cn/v1'],
	['volcengine-doubao', 'https://ark.cn-beijing.volces.com/api/v3'],
]);

function onlyValue(values: string[]): string {
	const first = values[0] ?? '';
	return first && values.every((value) => value === first) ? first : '';
}

export function resolveModelConnection(options: {
	provider?: Provider;
	model?: Pick<Model<Api>, 'api' | 'baseUrl'>;
	catalogProtocol?: string;
	providerOverride: Pick<ModelOverride, 'baseUrl' | 'protocol'>;
	modelOverride?: Pick<ModelOverride, 'baseUrl' | 'protocol'>;
	protocols: readonly string[];
}): ModelConnection {
	const { provider, model, catalogProtocol, providerOverride, modelOverride, protocols } = options;
	const manualApi = modelOverride?.protocol?.trim() || providerOverride.protocol?.trim() || '';
	const manualUrl = modelOverride?.baseUrl?.trim() || providerOverride.baseUrl?.trim() || '';
	let api = manualApi;
	let baseUrl = manualUrl;
	const unresolved = (issue: ModelConnectionIssue): ModelConnection => ({ api, baseUrl, source: 'unresolved', issue });
	if (!provider) return unresolved('unknown-provider');

	const known = provider.getModels();
	const official = openCodeConnection(provider.id, catalogProtocol) ?? model;
	const compatible = !official && openCodeConnection(provider.id, 'openai-completions');
	api ||= official?.api || (compatible && compatible.api) || onlyValue(known.map((entry) => entry.api));
	if (!api) return unresolved('missing-protocol');
	if (!protocols.includes(api)) return unresolved('unsupported-protocol');

	if (!baseUrl) {
		const native = openCodeConnection(provider.id, api);
		const compatibleResponses = api === 'openai-responses' && responsesAddresses.get(provider.id);
		baseUrl = native?.baseUrl || (official?.api === api ? official.baseUrl : '')
			|| (provider.id === 'meta' && api === 'openai-completions' && official?.baseUrl === 'https://api.meta.ai/v1' ? official.baseUrl : '')
			|| compatibleResponses
			|| onlyValue(known.filter((entry) => entry.api === api).map((entry) => entry.baseUrl));
	}
	const addressFromAuth = !baseUrl && provider.id === 'azure' && ['azure-openai-responses', 'openai-completions'].includes(api);
	if (!baseUrl && !addressFromAuth) return unresolved('missing-address');
	if (baseUrl) {
		const url = URL.parse(baseUrl);
		if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return unresolved('invalid-address');
		if (manualUrl && isOpenCodeProvider(provider.id) && url.hostname === 'opencode.ai') {
			const address = openCodeConfiguredAddress(provider.id, api, url);
			if (!address) return unresolved('incompatible-address');
			baseUrl = address;
		}
	}

	return {
		api, baseUrl,
		source: manualApi || manualUrl ? 'configured' : official ? 'catalog' : 'compatible',
		...(addressFromAuth && { addressFromAuth: true }),
	};
}
