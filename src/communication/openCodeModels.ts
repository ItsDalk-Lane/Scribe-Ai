const OPEN_CODE_APIS = [
	{ type: 'chat-completions', api: 'openai-completions', path: 'openai/v1' },
	{ type: 'responses', api: 'openai-responses', path: 'openai/v1' },
	{ type: 'messages', api: 'anthropic-messages', path: 'anthropic' },
	{ type: 'generate-content', api: 'google-generative-ai', path: 'google/v1beta' },
] as const;

export const OPEN_CODE_MODEL_PROVIDERS = ['opencode', 'opencode-go'] as const;

export function isOpenCodeProvider(id: string): boolean {
	return id === 'opencode' || id === 'opencode-go';
}

export function openCodeConnection(providerId: string, protocol: unknown) {
	const provider = OPEN_CODE_MODEL_PROVIDERS.find((id) => id === providerId);
	const entry = OPEN_CODE_APIS.find(({ api }) => api === protocol);
	if (!provider || !entry) return undefined;
	const baseUrl = `https://opencode.ai/inference/${provider === 'opencode-go' ? 'go/' : ''}${entry.path}`;
	return { api: entry.api, baseUrl };
}

export function openCodeCatalogProtocol(providerId: string, api: unknown, recommended: unknown, baseUrl: unknown) {
	if (!isOpenCodeProvider(providerId)) return undefined;
	if (typeof api === 'string') {
		const connection = openCodeConnection(providerId, api);
		return connection && connection.baseUrl === baseUrl ? connection.api : undefined;
	}
	if (!api || typeof api !== 'object') return undefined;
	const entries = Object.entries(api as Record<string, unknown>);
	const ordered = entries.sort(([key], [other]) => Number(other === recommended) - Number(key === recommended));
	for (const [key, value] of ordered) {
		const protocol = OPEN_CODE_APIS.find(({ type }) => type === key)?.api;
		const connection = openCodeConnection(providerId, protocol);
		if (!connection || !value || typeof value !== 'object' || !('base_url' in value)) continue;
		// Anthropic SDK 会自行拼接 /v1，其他适配器使用目录标注的版本前缀。
		const expected = connection.api === 'anthropic-messages' ? connection.baseUrl + '/v1' : connection.baseUrl;
		if (value.base_url === expected) return connection.api;
	}
	return undefined;
}

export function openCodeConfiguredAddress(providerId: string, api: string, url: URL): string | undefined {
	const connection = openCodeConnection(providerId, api);
	const address = url.href.replace(/\/+$/u, '');
	if (connection && (address === connection.baseUrl
		|| (api === 'anthropic-messages' && address === connection.baseUrl + '/v1'))) return connection.baseUrl;
	return undefined;
}
