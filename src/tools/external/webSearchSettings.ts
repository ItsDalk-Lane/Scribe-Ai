export const WEB_SEARCH_PROVIDERS = {
	'zhipu-coding': {
		label: '智谱 Coding Plan', endpoint: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
		credentialProvider: 'zai-coding-cn',
	},
	deepseek: {
		label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/tools/search', credentialProvider: 'deepseek',
	},
	exa: { label: 'Exa', endpoint: 'https://mcp.exa.ai/mcp?tools=web_search_exa' },
	tavily: { label: 'Tavily', endpoint: 'https://api.tavily.com/search' },
} as const;

export type WebSearchProvider = keyof typeof WEB_SEARCH_PROVIDERS;

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WEB_SEARCH_PROVIDERS, value);
}

export interface WebSearchSettings {
	enabled: boolean;
	provider: WebSearchProvider;
	/** 缺省时允许复用模型凭据，null 表示用户已解除链接。 */
	credentialIds: Partial<Record<WebSearchProvider, string | null>>;
}

export function normalizeWebSearchSettings(raw?: Partial<WebSearchSettings>): WebSearchSettings {
	const provider = isWebSearchProvider(raw?.provider) ? raw.provider : undefined;
	const credentialIds: WebSearchSettings['credentialIds'] = {};
	for (const id of ['zhipu-coding', 'deepseek', 'tavily'] as const) {
		const value = raw?.credentialIds?.[id];
		if (value === null || (typeof value === 'string' && /^[a-z0-9-]+$/.test(value))) credentialIds[id] = value;
	}
	return { enabled: provider !== undefined && raw?.enabled === true, provider: provider ?? 'zhipu-coding', credentialIds };
}
