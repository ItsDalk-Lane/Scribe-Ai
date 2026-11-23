import { PI_AI_VERSION, type CredentialStore } from '@earendil-works/pi-ai';
import type { ModelCatalogDetails, ModelCatalogResult, Transport } from '../types';

const DEFAULT_LIST_PROVIDERS = new Set([
	'ant-ling', 'bailian-payg', 'bailian-token-plan', 'bailian-coding-plan', 'baseten',
	'cerebras', 'deepseek', 'groq', 'huggingface', 'kimi-coding', 'moonshotai', 'moonshotai-cn',
	'nvidia', 'openai', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual',
	'qwen-token-plan-individual-cn', 'together', 'volcengine-agent-plan', 'volcengine-coding-plan',
	'volcengine-doubao', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn',
	'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn',
]);

const OFFICIAL_LIST_URLS = new Map([
	['opencode', 'https://opencode.ai/inference/v1/models'],
	['opencode-go', 'https://opencode.ai/inference/go/v1/models'],
]);

// 只为实际使用同一服务地址的目录补充别名。
const MODELS_DEV_PROVIDERS: ReadonlyMap<string, string> = new Map([
	['bailian-payg', 'alibaba-cn'],
	['bailian-token-plan', 'alibaba-token-plan-cn'],
	['bailian-coding-plan', 'alibaba-coding-plan-cn'],
	['qwen-token-plan', 'alibaba-token-plan'],
	['qwen-token-plan-cn', 'alibaba-token-plan-cn'],
	['volcengine-doubao', 'volcengine'],
]);

interface CatalogRow {
	id?: unknown;
	name?: unknown;
	type?: unknown;
	supportedGenerationMethods?: unknown;
	architecture?: { input_modalities?: unknown; output_modalities?: unknown };
	modalities?: { input?: unknown; output?: unknown };
	capabilities?: Record<string, unknown>;
	supported_parameters?: unknown;
	thinking?: unknown;
	reasoning?: unknown;
	input?: unknown;
	tool_call?: unknown;
	structured_output?: unknown;
	context_length?: unknown;
	inputTokenLimit?: unknown;
	outputTokenLimit?: unknown;
	max_input_tokens?: unknown;
	max_tokens?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
	limit?: { context?: unknown; output?: unknown };
	reasoning_options?: unknown;
}

interface CatalogPage {
	data?: CatalogRow[];
	models?: CatalogRow[];
	has_more?: boolean;
	last_id?: string;
	nextPageToken?: string;
}

function catalogId(row: CatalogRow | null | undefined): string {
	const id = typeof row?.id === 'string' ? row.id : row?.name;
	return typeof id === 'string' ? id.trim() : '';
}

function positiveInteger(...values: unknown[]): number | undefined {
	return values.find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function catalogFlag(value: unknown): boolean | undefined {
	const flag = typeof value === 'object' && value !== null ? (value as { supported?: unknown }).supported : value;
	return typeof flag === 'boolean' ? flag : undefined;
}

function catalogStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[a-z][a-z0-9_-]*$/i.test(item)))];
}

function readCatalogDetails(row: CatalogRow): ModelCatalogDetails {
	const parameters = catalogStrings(row.supported_parameters);
	const caps = row.capabilities;
	const reportedLevels = Array.isArray(row.reasoning_options)
		? row.reasoning_options.flatMap((option: { type?: unknown; values?: unknown } | null) =>
			option?.type === 'effort' ? catalogStrings(option.values) ?? [] : [])
		: undefined;
	const anthropicEffort = caps?.effort;
	const effortLevels = anthropicEffort && typeof anthropicEffort === 'object'
		? Object.entries(anthropicEffort).filter(([key, value]) => key !== 'supported' && catalogFlag(value) === true).map(([key]) => key)
		: undefined;
	const inputModalities = catalogStrings(row.architecture?.input_modalities) ?? catalogStrings(row.modalities?.input) ?? catalogStrings(row.input);
	const outputModalities = catalogStrings(row.architecture?.output_modalities) ?? catalogStrings(row.modalities?.output);
	const supportsImage = catalogFlag(caps?.image_input);
	const supportsPdf = catalogFlag(caps?.pdf_input);
	const fields: ModelCatalogDetails = {
		contextWindow: positiveInteger(row.top_provider?.context_length, row.context_length, row.inputTokenLimit, row.max_input_tokens, row.contextWindow, row.limit?.context),
		maxTokens: positiveInteger(row.top_provider?.max_completion_tokens, row.outputTokenLimit, row.max_tokens, row.maxTokens, row.limit?.output),
		reasoning: catalogFlag(row.reasoning) ?? catalogFlag(row.thinking) ?? catalogFlag(caps?.thinking)
			?? (parameters && ['reasoning', 'reasoning_effort', 'include_reasoning'].some((key) => parameters.includes(key))),
		tools: catalogFlag(row.tool_call) ?? catalogFlag(caps?.tool_calling) ?? parameters?.includes('tools'),
		structuredOutput: catalogFlag(row.structured_output) ?? catalogFlag(caps?.structured_outputs) ?? parameters?.includes('structured_outputs'),
		inputModalities: inputModalities ?? (supportsImage !== undefined && supportsPdf !== undefined
			? ['text', ...(supportsImage ? ['image'] : []), ...(supportsPdf ? ['pdf'] : [])] : undefined),
		outputModalities,
		reportedThinkingLevels: reportedLevels?.length ? reportedLevels : effortLevels,
	};
	// 缺失字段保留给其他来源补齐，明确的 false 则保留。
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function addCatalogRow(details: Map<string, ModelCatalogDetails>, id: string, row: CatalogRow): void {
	const fields = readCatalogDetails(row);
	details.set(id, { ...details.get(id), ...fields });
}

export function mergeModelCatalogDetails(...sources: (ReadonlyMap<string, ModelCatalogDetails> | undefined)[]): Map<string, ModelCatalogDetails> {
	const merged = new Map<string, ModelCatalogDetails>();
	for (const source of sources) {
		for (const [id, details] of source ?? []) merged.set(id, { ...merged.get(id), ...details });
	}
	return merged;
}

async function fetchCatalogJson(fetch: Transport['fetch'], url: URL, headers: HeadersInit, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}`);
	}
	return response.json();
}

export function readProviderCatalog(json: unknown): ModelCatalogResult {
	const page = json as CatalogPage | null;
	const rows = Array.isArray(page?.data) ? page.data : page?.models;
	if (!Array.isArray(rows)) throw new Error('Invalid model catalog');
	const details = new Map<string, ModelCatalogDetails>();
	for (const row of rows) {
		const id = catalogId(row);
		if (id) addCatalogRow(details, id, row);
	}
	return { models: [...details.keys()], source: 'provider', details };
}

export async function fetchOfficialModelCatalog(
	providerId: string,
	baseUrl: string,
	credentials: CredentialStore,
	fetch: Transport['fetch'],
	signal: AbortSignal,
): Promise<ModelCatalogResult | undefined> {
	const explicitUrl = OFFICIAL_LIST_URLS.get(providerId);
	if (!baseUrl && !explicitUrl) return undefined;
	const keyHeader = ['anthropic', 'minimax', 'minimax-cn'].includes(providerId);
	const gemini = providerId === 'google';
	const openRouter = providerId === 'openrouter';
	const vercel = providerId === 'vercel-ai-gateway';
	const huggingFace = providerId === 'huggingface';
	const xai = providerId === 'xai';
	const versionedPath = keyHeader || vercel || ['fireworks', 'mistral'].includes(providerId);
	if (!explicitUrl && !versionedPath && !gemini && !openRouter && !xai && !DEFAULT_LIST_PROVIDERS.has(providerId)) return undefined;

	const credential = explicitUrl || vercel || huggingFace ? undefined : await credentials.read(providerId, { signal });
	signal.throwIfAborted();
	const key = credential?.type === 'api_key' ? credential.key
		: openRouter && credential?.type === 'oauth' && credential.expires > Date.now() ? credential.access : undefined;
	const headers: Record<string, string> = { accept: 'application/json' };
	if (key) headers[keyHeader ? 'x-api-key' : gemini ? 'x-goog-api-key' : 'authorization'] = keyHeader || gemini ? key : `Bearer ${key}`;
	if (keyHeader) headers['anthropic-version'] = '2023-06-01';
	const path = versionedPath ? '/v1/models' : openRouter && key ? '/models/user' : xai ? '/language-models' : '/models';
	const url = new URL(explicitUrl ?? baseUrl.replace(/\/+$/, '') + path);
	const details = new Map<string, ModelCatalogDetails>();

	for (let count = 0; count < 20; count += 1) {
		const page = await fetchCatalogJson(fetch, url, headers, signal) as CatalogPage | null;
		const rows = gemini || xai ? page?.models : page?.data;
		if (!Array.isArray(rows) || (rows.length && !rows.some(catalogId))) throw new Error('Invalid model catalog');
		for (const row of rows) {
			const id = catalogId(row);
			if (!id) continue;
			if (gemini && (!Array.isArray(row?.supportedGenerationMethods) || !row.supportedGenerationMethods.includes('generateContent'))) continue;
			if (explicitUrl && row.type && row.type !== 'chat') continue;
			if (vercel && row.type && row.type !== 'language') continue;
			if (huggingFace && row.architecture) {
				const { input_modalities, output_modalities } = row.architecture;
				if (!Array.isArray(input_modalities) || !input_modalities.includes('text')) continue;
				if (!Array.isArray(output_modalities) || !output_modalities.includes('text')) continue;
			}
			addCatalogRow(details, gemini ? id.replace(/^models\//, '') : id, row);
		}
		const cursor = gemini ? page?.nextPageToken : keyHeader && page?.has_more ? page.last_id : undefined;
		if (!cursor) return { models: [...details.keys()], source: 'provider', details };
		url.searchParams.set(gemini ? 'pageToken' : 'after_id', cursor);
	}
	throw new Error('Model catalog has too many pages');
}

export async function fetchModelsDevDetails(
	providerId: string, fetch: Transport['fetch'], signal: AbortSignal,
): Promise<ReadonlyMap<string, ModelCatalogDetails>> {
	const data = await fetchCatalogJson(fetch, new URL('https://models.dev/api.json'), { accept: 'application/json' }, signal);
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Models.dev catalog');
	const provider = (data as Record<string, { models?: Record<string, CatalogRow | null> }>)[MODELS_DEV_PROVIDERS.get(providerId) ?? providerId];
	const details = new Map<string, ModelCatalogDetails>();
	for (const [id, row] of Object.entries(provider?.models ?? {})) {
		if (row && typeof row === 'object') addCatalogRow(details, id, row);
	}
	return details;
}

export async function fetchPiModelCatalog(providerId: string, fetch: Transport['fetch'], signal: AbortSignal): Promise<ModelCatalogResult> {
	const url = new URL(`https://pi.dev/api/models/providers/${encodeURIComponent(providerId)}`);
	url.searchParams.set('pi-version', PI_AI_VERSION);
	const catalog = await fetchCatalogJson(fetch, url, { accept: 'application/json' }, signal);
	if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('Invalid Pi model catalog');
	const entries = Object.values(catalog) as Array<CatalogRow | null>;
	const details = new Map<string, ModelCatalogDetails>();
	for (const row of entries) {
		if (row?.type !== 'chat') continue;
		const id = catalogId(row);
		if (id) addCatalogRow(details, id, row);
	}
	if (entries.length && !details.size) throw new Error('Invalid Pi model catalog');
	return { models: [...details.keys()], source: 'pi', details };
}
