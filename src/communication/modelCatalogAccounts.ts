import type { AuthResult, Credential } from '@earendil-works/pi-ai';
import type { ModelCatalogResult, Transport } from '../types';
import { fetchCatalogJson, fetchModelList, ModelCatalogHttpError } from './modelCatalog';

export const ACCOUNT_CATALOGS = new Set([
	'amazon-bedrock', 'azure', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'github-copilot', 'google-vertex', 'kimi-coding', 'openai-codex',
]);

interface BedrockProfile {
	inferenceProfileId?: unknown;
	inferenceProfileArn?: unknown;
	status?: unknown;
	type?: unknown;
	models?: { modelArn?: unknown }[];
}

async function readBedrockProfiles(fetch: Transport['fetch'], origin: URL, headers: Headers, signal: AbortSignal) {
	const url = new URL('/inference-profiles', origin);
	const profiles: BedrockProfile[] = [];
	const tokens = new Set<string>();
	for (let page = 0; page < 100; page += 1) {
		signal.throwIfAborted();
		const result = await fetchCatalogJson(fetch, url, headers, signal) as {
			inferenceProfileSummaries?: BedrockProfile[]; nextToken?: unknown;
		} | null;
		if (!Array.isArray(result?.inferenceProfileSummaries)) throw new Error('Invalid Bedrock inference profile catalog');
		profiles.push(...result.inferenceProfileSummaries);
		const token = result.nextToken;
		if (!token) return profiles;
		if (typeof token !== 'string' || tokens.has(token)) throw new Error('Invalid Bedrock inference profile pagination');
		tokens.add(token);
		url.searchParams.set('nextToken', token);
	}
	throw new Error('Bedrock inference profile catalog has too many pages');
}

async function fetchBedrockCatalog(fetch: Transport['fetch'], origin: URL, headers: Headers, signal: AbortSignal,
	nonChat?: ReadonlySet<string>, knownChat?: ReadonlySet<string>): Promise<ModelCatalogResult> {
	headers.set('user-agent', 'Scribe-Ai');
	const [foundations, profiles] = await Promise.allSettled([
		fetchModelList(fetch, new URL('/foundation-models?byOutputModality=TEXT', origin), headers, signal, 'amazon-bedrock', nonChat),
		readBedrockProfiles(fetch, origin, headers, signal),
	]);
	signal.throwIfAborted();
	const baseCatalog = foundations.status === 'fulfilled' ? foundations.value : undefined;
	const baseModels = new Set(baseCatalog?.models);
	const models = new Set(baseModels);
	const details = new Map(baseCatalog?.details);
	if (profiles.status === 'fulfilled') {
		for (const profile of profiles.value) {
			if (profile?.status !== 'ACTIVE' || !Array.isArray(profile.models) || !profile.models.length) continue;
			const id = profile.type === 'SYSTEM_DEFINED' && typeof profile.inferenceProfileId === 'string'
				&& /^[a-z0-9.:-]+$/iu.test(profile.inferenceProfileId) ? profile.inferenceProfileId
				: profile.type === 'APPLICATION' && typeof profile.inferenceProfileArn === 'string'
					&& /^arn:aws(?:-[a-z-]+)?:bedrock:[a-z0-9-]+:\d{12}:application-inference-profile\/[a-z0-9.:-]+$/iu.test(profile.inferenceProfileArn)
					? profile.inferenceProfileArn : undefined;
			if (!id) continue;
			const targets = profile.models.map((target) => typeof target?.modelArn === 'string'
				? /^arn:aws(?:-[a-z-]+)?:bedrock:[a-z0-9-]+::foundation-model\/([a-z0-9.:-]+)$/iu.exec(target.modelArn)?.[1] : undefined);
			const target = targets[0];
			// Application profiles can also point at embedding models.
			if (!target || targets.some((model) => model !== target) || nonChat?.has(target)
				|| !(baseModels.has(target) || knownChat?.has(target) || knownChat?.has(id))) continue;
			models.add(id);
			details.set(id, { ...details.get(target), type: 'text' });
		}
	}
	if (foundations.status === 'rejected' && !models.size) {
		throw foundations.reason instanceof Error ? foundations.reason : new Error('Bedrock foundation model catalog is unavailable');
	}
	return { models: [...models], details, source: 'provider',
		...((foundations.status === 'rejected' || profiles.status === 'rejected') && { partial: true }),
	};
}

export async function fetchAccountModelCatalog(
	providerId: string, baseUrl: string, credential: Credential | undefined, resolved: AuthResult | undefined,
	fetch: Transport['fetch'], signal: AbortSignal, nonChat?: ReadonlySet<string>, knownChat?: ReadonlySet<string>,
) {
	const key = resolved?.auth.apiKey ?? (credential?.type === 'api_key' ? credential.key : undefined);
	const address = URL.parse(baseUrl);
	const headers = new Headers({ accept: 'application/json' });
	let url: URL;

	switch (providerId) {
		case 'bailian-payg': {
			if (!key || address?.protocol !== 'https:' || address.username || address.password || address.port
				|| (address.hostname !== 'dashscope-us.aliyuncs.com' && !/^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/u.test(address.hostname))
				|| !/^\/compatible-mode\/v1\/?$/u.test(address.pathname)) return;
			url = new URL('/api/v1/models?capabilities=TG&page_no=1&page_size=100', address);
			headers.set('authorization', `Bearer ${key}`);
			try {
				return await fetchModelList(fetch, url, headers, signal, providerId, nonChat);
			} catch {
				signal.throwIfAborted();
				return; // 当前地址仍可提供兼容目录。
			}
		}
		case 'kimi-coding': {
			const origin = 'https://api.kimi.com';
			if (address?.origin !== origin || address.username || address.password
				|| !/^\/coding\/v1\/?$/u.test(address.pathname)) return;
			const oauthAuthorization = Object.entries(resolved?.auth.headers ?? {})
				.find(([name, value]) => name.toLowerCase() === 'authorization' && typeof value === 'string')?.[1];
			const authorization = credential?.type === 'oauth'
				? oauthAuthorization : key ? `Bearer ${key}` : null;
			if (!authorization || !/^Bearer \S+$/iu.test(authorization)) return;
			headers.set('authorization', authorization);
			return fetchModelList(fetch, new URL('/coding/v1/models', origin), headers, signal, providerId, nonChat);
		}
		case 'azure': {
			if (!key || address?.protocol !== 'https:' || !/\.(?:openai\.azure|cognitiveservices\.azure|services\.ai\.azure)\.com$/u.test(address.hostname)) return;
			headers.set('api-key', key);
			const current = new URL('/openai/v1/models', address);
			try {
				return await fetchModelList(fetch, current, headers, signal, providerId, nonChat);
			} catch (error) {
				if (!(error instanceof ModelCatalogHttpError) || ![404, 405].includes(error.status)) throw error;
			}
			url = new URL('/openai/models?api-version=2024-10-21', address);
			break;
		}
		case 'cloudflare-ai-gateway':
		case 'cloudflare-workers-ai': {
			if (baseUrl && (address?.protocol !== 'https:' || !['api.cloudflare.com', 'gateway.ai.cloudflare.com'].includes(address.hostname))) return;
			const fromAddress = address?.hostname === 'api.cloudflare.com'
				? /^\/client\/v4\/accounts\/([a-f0-9]+)\/ai(?:\/|$)/u.exec(address.pathname)?.[1]
				: address?.hostname === 'gateway.ai.cloudflare.com' ? /^\/v1\/([a-f0-9]+)\//u.exec(address.pathname)?.[1] : undefined;
			const account = fromAddress ?? resolved?.env?.CLOUDFLARE_ACCOUNT_ID
				?? (credential?.type === 'api_key' ? credential.env?.CLOUDFLARE_ACCOUNT_ID : undefined);
			if (!key || !account || !/^[a-f0-9]{32}$/iu.test(account)) return;
			const endpoint = providerId === 'cloudflare-ai-gateway' ? 'catalog/models' : 'models/search';
			url = new URL(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/${endpoint}?page=1&per_page=100`);
			break;
		}
		case 'amazon-bedrock': {
			const regionFromAddress = /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/u.exec(address?.hostname ?? '')?.[1];
			if (baseUrl && (!regionFromAddress || address?.protocol !== 'https:')) return;
			const region = regionFromAddress
				?? resolved?.env?.AWS_REGION ?? resolved?.env?.AWS_DEFAULT_REGION
				?? (credential?.type === 'api_key' ? credential.env?.AWS_REGION ?? credential.env?.AWS_DEFAULT_REGION : undefined) ?? 'us-east-1';
			if (!key || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/u.test(region)) return;
			headers.set('authorization', `Bearer ${key}`);
			return fetchBedrockCatalog(fetch, new URL(`https://bedrock.${region}.amazonaws.com`), headers, signal, nonChat, knownChat);
		}
		case 'openai-codex': {
			if (credential?.type !== 'oauth' || !key || typeof credential.accountId !== 'string' || !credential.accountId) return;
			// 与 CC Switch 的 ChatGPT 模型清单使用同一接口版本。
			const version = '0.169.0';
			url = new URL(`https://chatgpt.com/backend-api/codex/models?client_version=${version}`);
			headers.set('originator', 'codex_cli_rs');
			headers.set('version', version);
			headers.set('chatgpt-account-id', credential.accountId);
			break;
		}
		case 'github-copilot': {
			const connection = URL.parse(resolved?.auth.baseUrl ?? baseUrl);
			if (!key || connection?.protocol !== 'https:' || !/^(?:[^.]+\.)+(?:githubcopilot\.com|ghe\.com)$/iu.test(connection.hostname)
				|| connection.username || connection.password || connection.port) return;
			url = new URL('/models', connection);
			headers.set('user-agent', 'GitHubCopilotChat/0.35.0');
			headers.set('editor-version', 'vscode/1.107.0');
			headers.set('editor-plugin-version', 'copilot-chat/0.35.0');
			headers.set('copilot-integration-id', 'vscode-chat');
			headers.set('x-github-api-version', '2026-06-01');
			break;
		}
		case 'google-vertex': {
			// Vertex 目录只接受 Google Cloud OAuth，不能使用 Gemini 或 Vertex Express 的 API key。
			if (credential?.type !== 'oauth' || !key) return;
			url = new URL('https://aiplatform.googleapis.com/v1beta1/publishers/google/models');
			break;
		}
		default: return;
	}
	if (key && providerId !== 'azure') headers.set('authorization', `Bearer ${key}`);
	return fetchModelList(fetch, url, headers, signal, providerId, nonChat);
}
