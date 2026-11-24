import type { AuthResult, Credential } from '@earendil-works/pi-ai';
import type { Transport } from '../types';
import { fetchModelList, ModelCatalogHttpError } from './modelCatalog';

export const ACCOUNT_CATALOGS = new Set([
	'amazon-bedrock', 'azure', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'github-copilot', 'google-vertex', 'openai-codex',
]);

export async function fetchAccountModelCatalog(
	providerId: string, baseUrl: string, credential: Credential | undefined, resolved: AuthResult | undefined,
	fetch: Transport['fetch'], signal: AbortSignal, nonChat?: ReadonlySet<string>,
) {
	const key = resolved?.auth.apiKey ?? (credential?.type === 'api_key' ? credential.key : undefined);
	const address = URL.parse(baseUrl);
	const headers = new Headers({ accept: 'application/json' });
	let url: URL;

	switch (providerId) {
		case 'bailian-payg': {
			if (!key || address?.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/u.test(address.hostname)
				|| !/^\/compatible-mode\/v1\/?$/u.test(address.pathname)) return;
			url = new URL('/api/v1/models?capabilities=TG&page_no=1&page_size=100', address);
			break;
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
				?? (credential?.type === 'api_key' ? credential.env?.AWS_REGION : undefined) ?? 'us-east-1';
			if (!key || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/u.test(region)) return;
			url = new URL(`https://bedrock.${region}.amazonaws.com/foundation-models?byOutputModality=TEXT`);
			break;
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
