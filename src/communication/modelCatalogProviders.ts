import type { CredentialStore } from '@earendil-works/pi-ai';
import type { ModelCatalogResult, Transport } from '../types';
import { fetchModelList, ModelCatalogHttpError } from './modelCatalog';

const DEFAULT_LIST_PROVIDERS = new Set([
	'ant-ling', 'bailian-payg', 'bailian-token-plan', 'bailian-coding-plan', 'baseten',
	'cerebras', 'deepseek', 'groq', 'huggingface', 'kimi-coding', 'moonshotai', 'moonshotai-cn',
	'meta', 'nvidia', 'openai', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual',
	'qwen-token-plan-individual-cn', 'together', 'volcengine-agent-plan', 'volcengine-coding-plan',
	'volcengine-doubao', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn',
	'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn',
]);

const OFFICIAL_LIST_URLS = new Map([
	['opencode', 'https://opencode.ai/inference/v1/models'],
	['opencode-go', 'https://opencode.ai/inference/go/v1/models'],
]);

const PUBLIC_MODEL_CATALOGS = new Set([
	...OFFICIAL_LIST_URLS.keys(), 'bailian-coding-plan', 'cerebras', 'huggingface',
	'nvidia', 'openrouter', 'radius', 'vercel-ai-gateway',
]);

export function hasPublicModelCatalog(providerId: string): boolean {
	return PUBLIC_MODEL_CATALOGS.has(providerId);
}

export async function fetchOfficialModelCatalog(
	providerId: string,
	baseUrl: string,
	credentials: CredentialStore,
	fetch: Transport['fetch'],
	signal: AbortSignal,
	nonChat: ReadonlySet<string> = new Set(),
): Promise<ModelCatalogResult | undefined> {
	const explicitUrl = OFFICIAL_LIST_URLS.get(providerId);
	if (!baseUrl && !explicitUrl) return undefined;
	const keyHeader = ['anthropic', 'minimax', 'minimax-cn'].includes(providerId);
	const gemini = providerId === 'google';
	const openRouter = providerId === 'openrouter';
	const vercel = providerId === 'vercel-ai-gateway';
	const huggingFace = providerId === 'huggingface';
	const xai = providerId === 'xai';
	const radius = providerId === 'radius';
	const versionedPath = keyHeader || vercel || ['fireworks', 'mistral'].includes(providerId);
	if (!explicitUrl && !versionedPath && !gemini && !openRouter && !xai && !radius && !DEFAULT_LIST_PROVIDERS.has(providerId)) return undefined;

	const credential = vercel || huggingFace ? undefined : await credentials.read(providerId, { signal });
	signal.throwIfAborted();
	const key = credential?.type === 'api_key' ? credential.key
		: (openRouter || radius) && credential?.type === 'oauth' && credential.expires > Date.now() ? credential.access : undefined;
	if (!key && !hasPublicModelCatalog(providerId)) return undefined;
	const headers: Record<string, string> = { accept: 'application/json' };
	if (key) headers[keyHeader ? 'x-api-key' : gemini ? 'x-goog-api-key' : 'authorization'] = keyHeader || gemini ? key : `Bearer ${key}`;
	if (keyHeader) headers['anthropic-version'] = '2023-06-01';
	const path = versionedPath ? '/v1/models' : openRouter && key ? '/models/user' : xai ? '/language-models' : radius ? '/config' : '/models';
	const url = new URL(explicitUrl ?? (providerId === 'cerebras' && !key
		? 'https://api.cerebras.ai/public/v1/models' : baseUrl.replace(/\/+$/, '') + path));
	if (vercel) url.searchParams.set('type', 'language');
	try {
		return await fetchModelList(fetch, url, headers, signal, providerId, nonChat);
	} catch (error) {
		if (!(error instanceof ModelCatalogHttpError) || ![404, 405].includes(error.status)) throw error;
		// 兼容接口缺失时，只重试官方确认属于同一连接的备用目录。
		if (providerId === 'fireworks') {
			const fallback = new URL('/v1/accounts/fireworks/models?pageSize=200', url);
			return fetchModelList(fetch, fallback, headers, signal, providerId, nonChat);
		}
		if (providerId === 'deepseek') return fetchModelList(fetch, new URL('/v1/models', url), headers, signal, providerId, nonChat);
		throw error;
	}
}

