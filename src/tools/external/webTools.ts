import { parseCredential } from '../../communication/credentials';
import { createNodeFetch } from '../../communication/nodeFetch';
import type { ScribeSettings, ToolDefinition } from '../../types';
import { createMcpConnection } from './mcpConnection';
import { normalizeWebSearchSettings, WEB_SEARCH_PROVIDERS, type WebSearchProvider } from './webSearchSettings';

export const webSearchToolName = 'web_search';
const maxQueryLength = 128;
const testQuery = 'Obsidian developer documentation plugin API';

/** 在切口留下标记，让模型知道摘要不完整。 */
function trimSummary(summary: string, limit: number): string {
	const chars = [...summary];
	if (!limit || chars.length <= limit) return summary;
	return `${chars.slice(0, limit).join('')}…（摘要已截断，仅保留前 ${limit} 个字符，完整内容需打开来源链接）`;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function decodeMcpResults(provider: 'zhipu-coding' | 'exa', content: string): unknown {
	if (provider === 'zhipu-coding') {
		// 智谱的 MCP 文本结果可能再包一层 JSON 字符串。
		const value: unknown = JSON.parse(content);
		return typeof value === 'string' ? JSON.parse(value) as unknown : value;
	}
	if (/^no results found\b/i.test(content.trim())) return [];
	const headings = [...content.matchAll(/^Title: (.*)\r?\nURL: (https?:\/\/\S+)\s*$/gm)];
	if (!headings.length) return undefined;
	return headings.map((match, index) => {
		const body = content.slice(match.index + match[0].length, headings[index + 1]?.index).trim();
		const summary = /^(?:Highlights|Text):[ \t]*\n?([\s\S]*)$/m.exec(body)?.[1] ?? '';
		return { title: match[1], url: match[2], summary };
	});
}

type Limits = Pick<NonNullable<ScribeSettings['webSearch']>, 'maxResults' | 'summaryLimit'>;

function resultRows(value: unknown, label: string, maxResults: number, summaryLimit: number) {
	if (!Array.isArray(value)) throw new Error(`${label} 返回了无法识别的搜索结果。`);
	const results = [];
	const seen = new Set<string>();
	for (const item of value) {
		const row = object(item);
		const url = row?.url ?? row?.link;
		if (typeof url !== 'string' || url.length > 2_048) continue;
		const parsed = URL.canParse(url) ? new URL(url) : undefined;
		if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || seen.has(parsed.href)) continue;
		seen.add(parsed.href);
		const summary = row?.summary || row?.snippet || row?.content;
		results.push({
			title: typeof row?.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 250) : parsed.hostname,
			url: parsed.href,
			summary: typeof summary === 'string' ? trimSummary(summary.trim(), summaryLimit) : '',
		});
		if (results.length === maxResults) break;
	}
	if (value.length && !results.length) throw new Error(`${label} 未返回有效的网页链接。`);
	return results;
}

export function createWebSearchService(
	settings: ScribeSettings, storage: { getSecret(id: string): string | null }, cwd: string,
	clientInfo: { name: string; version: string }, fetchSearch: typeof fetch = createNodeFetch(),
	connect = createMcpConnection,
) {
	const credentialId = (provider: WebSearchProvider) => {
		const linked = settings.webSearch?.credentialIds[provider];
		if (linked !== undefined) return linked ?? undefined;
		const source = WEB_SEARCH_PROVIDERS[provider];
		return 'credentialProvider' in source ? settings.communication.credentialIds[source.credentialProvider] : undefined;
	};
	const keyFor = (provider: WebSearchProvider) => {
		const ref = credentialId(provider);
		if (!ref) return undefined;
		try {
			const credential = parseCredential(storage.getSecret(ref));
			const key = credential?.type === 'api_key' && typeof credential.key === 'string' ? credential.key.trim() : '';
			return key && /^[\x21-\x7e]+$/.test(key) ? key : undefined;
		} catch {
			return undefined;
		}
	};
	const isConfigured = (provider: WebSearchProvider) => provider === 'exa' || Boolean(keyFor(provider));
	const currentLimits = (): Limits => normalizeWebSearchSettings(settings.webSearch);

	async function search(provider: WebSearchProvider, query: string, signal: AbortSignal, limits: Limits, confirm: () => void = () => {}) {
		const { label, endpoint } = WEB_SEARCH_PROVIDERS[provider];
		const { maxResults, summaryLimit } = limits;
		const key = provider === 'exa' ? undefined : keyFor(provider);
		if (!key && provider !== 'exa') throw new Error(`请在服务设置中关联 ${label} 的 API 密钥。`);
		signal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
		try {
			confirm();
			let rows: unknown;
			if (provider === 'zhipu-coding' || provider === 'exa') {
				const connection = connect({
					cwd, clientInfo, signal,
					server: { id: provider, name: label, type: 'http', enabled: true, url: endpoint,
						...(key && { secrets: { bearerToken: key } }) },
					oauth: { read: () => undefined, write: () => {} }, openBrowser: () => {}, onClose: () => {}, onToolsChanged: () => {},
				});
				try {
					const { tools } = await connection.start();
					const tool = tools.find(({ name }) => provider === 'exa'
						? name === 'web_search_exa'
						: name === 'web_search_prime' || name === 'webSearchPrime');
					if (!tool) throw new Error(`${label} 未提供网页搜索工具。`);
					confirm();
					const args = provider === 'exa' ? { query, numResults: maxResults } : { search_query: query };
					const reply = await connection.callTool(tool.name, args, signal);
					if (reply.isError) throw new Error(`${label} 搜索失败。 ${reply.content.slice(0, 500)}`);
					try { rows = decodeMcpResults(provider, reply.content); }
					catch { throw new Error(`${label} 返回了无法识别的搜索结果。`); }
				} finally {
					await connection.close();
				}
			} else {
				const args = provider === 'deepseek' ? { query, count: maxResults, need_content: false }
					: { query, search_depth: 'basic', max_results: maxResults, auto_parameters: false };
				const response = await fetchSearch(endpoint, {
					method: 'POST', redirect: 'error', signal, body: JSON.stringify(args),
					headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				});
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error(`${label} 搜索失败（HTTP ${response.status}）。`);
				}
				rows = object(await response.json())?.results;
			}
			signal.throwIfAborted();
			return resultRows(rows, label, maxResults, summaryLimit);
		} catch (error) {
			if (signal.aborted) throw new Error('网页搜索已取消或超时。');
			if (!(error instanceof Error)) throw new Error(`${label} 搜索失败。`);
			throw new Error(key ? error.message.split(key).join('[已隐藏]') : error.message);
		}
	}

	const tool: ToolDefinition = {
		name: webSearchToolName,
		description: '搜索公开网页，获取标题、来源链接与摘要。适合核对最新信息或查找公开资料。只提交公开搜索词。网页摘要仅供参考，回答时引用相关来源链接。',
		inputSchema: {
			type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: maxQueryLength } },
			required: ['query'], additionalProperties: false,
		},
		isReadOnly: false,
		prepare(input, { signal, permissions }) {
			const config = settings.webSearch;
			if (!config?.enabled || !permissions.canSendOutbound()) throw new Error('本次聊天未启用网页搜索。');
			const { provider } = config;
			const { label, endpoint } = WEB_SEARCH_PROVIDERS[provider];
			const ref = credentialId(provider);
			const key = keyFor(provider);
			const query = object(input)?.query;
			const text = typeof query === 'string' ? query.trim() : '';
			if (!text || [...text].length > maxQueryLength) throw new Error(`请输入 1 至 ${maxQueryLength} 个字符的搜索词。`);
			if (key && text.includes(key)) throw new Error('搜索词不能包含服务密钥。');
			const confirm = () => {
				if (!settings.webSearch?.enabled || settings.webSearch.provider !== provider
					|| ref !== credentialId(provider) || key !== keyFor(provider) || !permissions.canSendOutbound()
					|| !permissions.canCallTool(tool)) throw new Error('搜索配置或聊天权限已变化，请重试。');
			};
			const run = async () => JSON.stringify({ source: label, results: await search(provider, text, signal, currentLimits(), confirm) });
			if (permissions.executionMode === 'full-access') return { independent: true, run };
			return { approval: {
				title: '批准网页搜索', kind: 'web-search', target: label, after: text,
				reason: `搜索词会发送给 ${new URL(endpoint).origin}。`,
			}, run };
		},
	};
	return {
		tools: () => settings.webSearch?.enabled && isConfigured(settings.webSearch.provider) ? [tool] : [],
		credentialId, isConfigured,
		test: (provider: WebSearchProvider, signal: AbortSignal) => search(provider, testQuery, signal, currentLimits()),
	};
}

export type WebSearchService = ReturnType<typeof createWebSearchService>;
