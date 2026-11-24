import { PI_AI_VERSION } from '@earendil-works/pi-ai';
import type { ModelCatalogDetails, ModelCatalogEvidence, ModelCatalogField, ModelCatalogResult, ProviderModelInfo, Transport } from '../types';
import { openCodeCatalogProtocol } from './openCodeModels';
import { addProviderCapabilityEvidence } from './providerCapabilityEvidence';

// 只为实际使用同一服务地址的目录补充别名。
const MODELS_DEV_PROVIDERS: ReadonlyMap<string, string> = new Map([
	['bailian-payg', 'alibaba-cn'],
	['bailian-token-plan', 'alibaba-token-plan-cn'],
	['bailian-coding-plan', 'alibaba-coding-plan-cn'],
	['qwen-token-plan', 'alibaba-token-plan'],
	['qwen-token-plan-cn', 'alibaba-token-plan-cn'],
	['qwen-token-plan-individual', 'alibaba-token-plan'],
	['qwen-token-plan-individual-cn', 'alibaba-token-plan-cn'],
	['kimi-coding', 'kimi-code-plan-cn'],
	['ant-ling', 'bailing'],
	['fireworks', 'fireworks-ai'],
	['together', 'togetherai'],
	['vercel-ai-gateway', 'vercel'],
	['volcengine-doubao', 'volcengine'],
	['zai', 'zai-coding-plan'],
	['zai-coding-cn', 'zhipuai-coding-plan'],
]);

interface CatalogRow {
	api?: unknown;
	baseUrl?: unknown;
	recommended_api?: unknown;
	id?: unknown;
	name?: unknown;
	slug?: unknown;
	model?: unknown;
	modelId?: unknown;
	model_id?: unknown;
	type?: unknown;
	model_type?: unknown;
	domain?: unknown;
	task?: string | { name?: unknown };
	request_formats?: unknown;
	enabled?: unknown;
	supportsServerless?: unknown;
	conversationConfig?: unknown;
	model_picker_enabled?: unknown;
	policy?: { state?: unknown };
	archived?: unknown;
	supports_image_in?: unknown;
	supports_video_in?: unknown;
	supports_reasoning?: unknown;
	responseStreamingSupported?: unknown;
	inputModalities?: unknown;
	outputModalities?: unknown;
	max_context_length?: unknown;
	effort?: { supported_levels?: unknown };
	features?: { tools?: { function_calling?: unknown }; structured_outputs?: { json_schema?: unknown } };
	token_limits?: { context_window?: unknown; max_output_token_length?: unknown };
	supportedGenerationMethods?: unknown;
	architecture?: { input_modalities?: unknown; output_modalities?: unknown };
	modalities?: { input?: unknown; output?: unknown; input_modalities?: unknown; output_modalities?: unknown };
	capabilities?: Record<string, unknown>;
	supported_parameters?: unknown;
	input_modalities?: unknown;
	output_modalities?: unknown;
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
	context_window?: unknown;
	max_output_tokens?: unknown;
	maxTokens?: unknown;
	top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
	limit?: { context?: unknown; output?: unknown };
	reasoning_options?: unknown;
}

interface CatalogPage {
	data?: CatalogRow[];
	models?: CatalogRow[] | Record<string, CatalogRow>;
	has_more?: boolean;
	last_id?: string;
	hasMore?: boolean;
	lastId?: string;
	nextPageToken?: string;
	next_page_token?: string;
	links?: { next?: string | null };
	total_count?: number;
	result?: CatalogRow[];
	result_info?: { page?: number; per_page?: number; total_pages?: number; total_count?: number };
	modelSummaries?: CatalogRow[];
	publisherModels?: CatalogRow[];
	items?: CatalogRow[];
	output?: { models?: CatalogRow[]; page_no?: number; page_size?: number; total?: number };
}

function catalogId(row: CatalogRow | null | undefined): string {
	for (const field of [row?.id, row?.slug, row?.model, row?.modelId, row?.model_id, row?.name]) {
		if (typeof field === 'string' && field.trim()) return field.trim();
	}
	return '';
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

function catalogModalities(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return catalogStrings(value.map((item: unknown) => {
		if (typeof item !== 'string') return item;
		const modality = item.toLowerCase();
		if (modality === 'application/pdf') return 'pdf';
		return /^(?:image|audio|video|text)\//u.test(modality) ? modality.split('/')[0] : modality;
	}));
}

function modelModalities(row: CatalogRow) {
	return {
		input: catalogModalities(row.architecture?.input_modalities) ?? catalogModalities(row.modalities?.input)
			?? catalogModalities(row.modalities?.input_modalities) ?? catalogModalities(row.input_modalities)
			?? catalogModalities(row.inputModalities) ?? catalogModalities(row.input),
		output: catalogModalities(row.architecture?.output_modalities) ?? catalogModalities(row.modalities?.output)
			?? catalogModalities(row.modalities?.output_modalities) ?? catalogModalities(row.output_modalities) ?? catalogModalities(row.outputModalities),
	};
}

const NON_CHAT_TYPES = new Set([
	'audio', 'asr', 'classification', 'classifier', 'decision', 'embedding', 'evaluation', 'extraction', 'image', 'imagegeneration',
	'moderation', 'realtime', 'rerank', 'reranking', 'speech', 'transcribe', 'transcription', 'tts', 'video', 'videogeneration', '3dgeneration',
]);

function isChatModel(row: CatalogRow, id: string, providerId: string, nonChat?: ReadonlySet<string>): boolean {
	const type = [row.type, row.model_type, row.domain].find((value): value is string => typeof value === 'string')?.toLowerCase();
	if (type && NON_CHAT_TYPES.has(type)) return false;
	if (row.enabled === false) return false;
	if (row.archived === true || row.responseStreamingSupported === false) return false;
	if (catalogFlag(row.capabilities?.completion_chat ?? row.capabilities?.chat_completion) === false) return false;
	if (providerId === 'github-copilot' && (row.policy?.state === 'disabled' || (row.model_picker_enabled === false && row.policy?.state !== 'enabled'))) return false;
	if (providerId.startsWith('cloudflare-')) {
		const task = typeof row.task === 'string' ? row.task : row.task?.name;
		if (typeof task === 'string' && !['text generation', 'image-to-text'].includes(task.toLowerCase())) return false;
		const formats = catalogStrings(row.request_formats);
		if (formats?.length && !formats.some((format) => ['chat-completions', 'responses', 'messages', 'generate-content'].includes(format))) return false;
	}
	if (providerId === 'fireworks' && row.supportsServerless !== undefined && (row.supportsServerless !== true || !row.conversationConfig)) return false;
	if (providerId === 'google' && Array.isArray(row.supportedGenerationMethods)
		&& !catalogStrings(row.supportedGenerationMethods)?.includes('generateContent')) return false;
	if ((providerId === 'google' || providerId === 'google-vertex')
		&& /^(?:imagen|veo|lyria|embedding)(?:-|$)|(?:-image|-tts|-native-audio|-embedding)(?:-|$)/i.test(id)) return false;
	if (providerId === 'openai' && /^(?:text-embedding-|tts-|whisper-|dall-e-|sora(?:-|$)|gpt-image-|omni-moderation-|text-moderation-)|(?:-realtime|-transcribe|-tts)(?:-|$)/i.test(id)) return false;
	if (providerId.startsWith('xiaomi') && /-(?:tts|asr)(?:-|$)/i.test(id)) return false;
	if (providerId === 'meta' && /^(?:muse-image-|muse-voice-transcribe-|sam-)/i.test(id)) return false;
	if (providerId === 'groq' && /^(?:whisper-|canopylabs\/orpheus-|playai-tts)/i.test(id)) return false;
	if (providerId === 'nvidia' && (/(?:^|[-/])embed(?:ding|qa)?(?:[-/]|$)/i.test(id)
		|| ['nvidia/nvclip', 'fastino/gliner2-pii', 'nvidia/ai-synthetic-video-detector'].includes(id))) return false;
	if (type && ['chat', 'language', 'llm', 'vlm', 'code', 'text-generation'].includes(type)) return true;
	if (nonChat?.has(id)) return false;
	const { input, output } = modelModalities(row);
	return (!input?.length || input.includes('text')) && (!output?.length || output.includes('text'));
}

function readCatalogDetails(row: CatalogRow, providerId: string): ModelCatalogDetails {
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
	const { input: inputModalities, output: outputModalities } = modelModalities(row);
	const supportsImage = catalogFlag(caps?.image_input) ?? catalogFlag(caps?.vision) ?? catalogFlag(row.supports_image_in);
	const supportsVideo = catalogFlag(caps?.video_input) ?? catalogFlag(row.supports_video_in);
	const supportsPdf = catalogFlag(caps?.pdf_input);
	const structured = caps?.structured_outputs as { json_schema?: unknown } | undefined;
	const genericJson = catalogFlag(row.structured_output) ?? catalogFlag(caps?.structured_outputs) ?? catalogFlag(caps?.structured_output)
		?? (parameters?.includes('response_format') ? true : undefined);
	const reasoning = caps?.reasoning as { effort?: unknown } | undefined;
	const fields: ModelCatalogDetails = {
		contextWindow: positiveInteger(row.top_provider?.context_length, row.context_length, row.inputTokenLimit, row.max_input_tokens,
			row.contextWindow, row.context_window, row.max_context_length, row.token_limits?.context_window, row.limit?.context),
		maxTokens: positiveInteger(row.top_provider?.max_completion_tokens, row.outputTokenLimit, row.max_tokens,
			row.max_output_tokens, row.maxTokens, row.token_limits?.max_output_token_length, row.limit?.output),
		reasoning: catalogFlag(row.reasoning) ?? catalogFlag(row.thinking) ?? catalogFlag(caps?.thinking) ?? catalogFlag(reasoning) ?? catalogFlag(row.supports_reasoning)
			?? (['reasoning', 'reasoning_effort', 'include_reasoning'].some((key) => parameters?.includes(key)) ? true : undefined),
		tools: catalogFlag(row.tool_call) ?? catalogFlag(caps?.tool_calling) ?? catalogFlag(caps?.tools)
			?? catalogFlag(caps?.function_calling) ?? catalogFlag(row.features?.tools?.function_calling) ?? (parameters?.includes('tools') ? true : undefined),
		structuredOutput: catalogFlag(structured?.json_schema) ?? catalogFlag(row.features?.structured_outputs?.json_schema)
			?? (providerId === 'cerebras' ? catalogFlag(caps?.structured_outputs) : undefined)
			?? (parameters?.includes('structured_outputs') ? true : genericJson === false ? false : undefined),
		jsonOutput: genericJson,
		inputModalities: inputModalities ?? (supportsImage !== undefined || supportsPdf !== undefined
			? ['text', ...(supportsImage ? ['image'] : []), ...(supportsPdf ? ['pdf'] : [])] : undefined),
		videoInput: supportsVideo,
		outputModalities,
		reportedThinkingLevels: reportedLevels?.length ? reportedLevels
			: effortLevels ?? catalogStrings(reasoning?.effort) ?? catalogStrings(row.effort?.supported_levels),
	};
	// 缺失字段保留给其他来源补齐，明确的 false 则保留。
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function addCatalogRow(details: Map<string, ModelCatalogDetails>, id: string, row: CatalogRow, providerId = ''): void {
	const fields = readCatalogDetails(row, providerId);
	const protocol = providerId && openCodeCatalogProtocol(providerId, row.api, row.recommended_api, row.baseUrl);
	if (protocol) fields.connectionProtocol = protocol;
	details.set(id, { ...details.get(id), ...fields });
}

const evidenceRanks: Record<ModelCatalogEvidence['source'], number> = {
	bundled: 1, pi: 2, 'models.dev': 3, docs: 4, provider: 4,
};

function catalogFields(details: ModelCatalogDetails): ModelCatalogField[] {
	return (Object.keys(details) as (keyof ModelCatalogDetails)[])
		.filter((field): field is ModelCatalogField => field !== 'evidence' && details[field] !== undefined);
}

export function sourceModelCatalogDetails(details: ReadonlyMap<string, ModelCatalogDetails> | undefined,
	source: ModelCatalogEvidence['source'], checkedAt?: string): Map<string, ModelCatalogDetails> {
	const evidence = { source, ...(checkedAt && { checkedAt }) };
	return new Map([...details ?? []].map(([id, row]) => [id, {
		...row, ...(catalogFields(row).length && {
			evidence: Object.fromEntries(catalogFields(row).map((field) => [field, row.evidence?.[field] ?? evidence])),
		}),
	}]));
}

function hasDifferentValue(a: unknown, b: unknown): boolean {
	return Array.isArray(a) && Array.isArray(b) ? a.length !== b.length || a.some((value) => !b.includes(value)) : a !== b;
}

export function mergeModelCatalogDetails(...sources: (ReadonlyMap<string, ModelCatalogDetails> | undefined)[]): Map<string, ModelCatalogDetails> {
	const merged = new Map<string, ModelCatalogDetails>();
	for (const source of sources) {
		for (const [id, details] of source ?? []) {
			const saved = merged.get(id);
			const previous = saved?.connectionProtocol && details.connectionProtocol && saved.connectionProtocol !== details.connectionProtocol
				? undefined : saved;
			const row = { ...previous };
			const evidence = { ...previous?.evidence };
			for (const field of catalogFields(details)) {
				const existing = evidence[field];
				const incoming = details.evidence?.[field];
				const previousRank = existing ? evidenceRanks[existing.source] : 0;
				const incomingRank = incoming ? evidenceRanks[incoming.source] : 0;
				const modalities = field === 'inputModalities' || field === 'outputModalities' ? details[field] : undefined;
				if (row[field] !== undefined && previousRank > incomingRank) {
					if ((field === 'inputModalities' || field === 'outputModalities') && modalities?.includes('pdf')
						&& row[field]?.includes('file') && !row[field]?.includes('pdf')) row[field] = [...row[field], 'pdf'];
					continue;
				}
				const disagreement = row[field] !== undefined && existing && incoming && previousRank === incomingRank
					&& existing.source !== incoming.source && hasDifferentValue(row[field], details[field]);
				if (disagreement && existing.source === 'provider') {
					evidence[field] = { ...existing, conflict: true };
					continue;
				}
				if (incoming) evidence[field] = disagreement ? { ...incoming, conflict: true }
					: existing?.conflict && incoming.source === existing.source && !hasDifferentValue(row[field], details[field]) ? existing : incoming;
				// A generic file category doesn't discard a known subtype from the same connection.
				if ((field === 'inputModalities' || field === 'outputModalities') && modalities?.includes('file')
					&& row[field]?.includes('pdf')) row[field] = [...new Set([...modalities, 'pdf'])];
				else Object.assign(row, { [field]: details[field] });
			}
			if (Object.keys(evidence).length) row.evidence = evidence;
			merged.set(id, row);
		}
	}
	return merged;
}

const documentedStructuredOutput = new Map<string, readonly string[]>([
	// https://developers.openai.com/api/docs/guides/structured-outputs
	['openai', ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-5.4', 'gpt-4o', 'gpt-4o-mini',
		'gpt-4o-mini-2024-07-18', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
		'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4-mini', 'gpt-5.4-nano', 'o3']],
	// https://platform.claude.com/docs/en/build-with-claude/structured-outputs
	['anthropic', ['claude-opus-5-5', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5']],
	// https://aistudio.google.com/docs/structured-output
	['google', ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-4-neon', 'gemini-3.8-flash',
		'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
		'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']],
	// https://docs.x.ai/developers/model-capabilities/text/structured-outputs
	['xai', ['grok-4.7']],
	// https://console.volcengine.com/ark/region:cn-beijing/docs/structured-output-beta
	['volcengine-doubao', ['doubao-seed-2-1-pro-260915']],
	// https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-structured-output
	['bailian-payg', ['qwen4-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.7-max', 'qwen3.8-max', 'qwen3.8-flash',
		'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017', 'deepseek-v4-pro']],
	// https://docs.together.ai/docs/serverless/models
	['together', ['deepseek-ai/DeepSeek-V4-Pro-0813', 'deepseek-ai/DeepSeek-V4.1-Flash', 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
		'deepseek-ai/DeepSeek-V4.1-Flash-1017-fast', 'elorian-labs/glimpse-1.0', 'meta-models/Muse-Glimmer-30B',
		'meta-models/Muse-Spark-Open-816B-A42B', 'MiniMaxAI/MiniMax-M3.1-Flash', 'moonshotai/Kimi-K3', 'moonshotai/Kimi-K3.1-Pro',
		'nvidia/NVIDIA-Nemotron-3.5-Super-VL', 'Qwen/Qwen3.5-9B', 'Qwen/Qwen3.6-Plus', 'Qwen/Qwen3.7-Max', 'Qwen/Qwen3.7-Plus']],
]);

export function documentedModelDetails(providerId: string): ReadonlyMap<string, ModelCatalogDetails> {
	const details = new Map<string, ModelCatalogDetails>();
	for (const id of documentedStructuredOutput.get(providerId) ?? []) details.set(id, { ...details.get(id), structuredOutput: true });
	addProviderCapabilityEvidence(providerId, details);
	if (providerId === 'zai-coding-cn') {
		// Live Coding Plan Chat Completions probes on 2026-11-24, including streaming schema output.
		details.set('glm-5.3-flash', { structuredOutput: true, videoInput: true });
	}
	if (providerId === 'kimi-coding') {
		// https://www.kimi.com/code/docs/en/kimi-code/models.html
		for (const id of ['k3.1-pro', 'k3.1-pro-highspeed', 'k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed']) {
			details.set(id, { ...details.get(id), inputModalities: id === 'k3-256k' ? ['text', 'image'] : ['text', 'image', 'video'] });
		}
	}
	if (providerId === 'bailian-payg') {
		// https://www.alibabacloud.com/help/en/model-studio/vision
		for (const id of ['qwen4-max', 'qwen3.6-flash']) {
			details.set(id, { ...details.get(id), inputModalities: ['text', 'image', 'video'] });
		}
	}
	return sourceModelCatalogDetails(details, 'docs', '2026-11-24');
}

export function documentedRouteDetails(providerId: string, model: string, api: string, baseUrl: string): ModelCatalogDetails | undefined {
	const url = URL.parse(baseUrl);
	if (url?.protocol !== 'https:') return undefined;
	const path = url.pathname.replace(/\/$/u, '');
	if (providerId === 'azure' && /\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/u.test(url.hostname)
		&& /^\/(?:openai(?:\/v1)?\/?)?$/u.test(url.pathname)
		&& (api === 'azure-openai-responses' || api === 'openai-completions')) {
		const details = documentedModelDetails(providerId).get(model);
		if (api === 'azure-openai-responses') return details;
		if (details?.structuredOutput && path === '/openai/v1') return { structuredOutput: true, evidence: { structuredOutput: details.evidence?.structuredOutput } };
	}
	if (providerId === 'meta' && model === 'muse-spark-1.3' && api === 'openai-completions' && url.origin === 'https://api.meta.ai' && path === '/v1') {
		// https://dev.meta.ai/docs/structured-output (Chat Completions).
		return { structuredOutput: true, evidence: { structuredOutput: { source: 'docs', checkedAt: '2026-11-24' } } };
	}
	const schema = { structuredOutput: true, evidence: { structuredOutput: { source: 'docs' as const, checkedAt: '2026-11-24' } } };
	// https://huggingface.co/docs/inference-providers/guides/structured-output
	if (providerId === 'huggingface' && url.origin === 'https://router.huggingface.co' && api === 'openai-completions'
		&& path === '/cerebras/v1' && model === 'Qwen/Qwen3-32B') return schema;
	if (api !== 'openai-responses') return undefined;
	if (providerId === 'volcengine-doubao' && url.origin === 'https://ark.cn-beijing.volces.com' && path === '/api/v3') return documentedModelDetails(providerId).get(model);
	// https://huggingface.co/docs/inference-providers/main/guides/responses-api
	if (providerId === 'huggingface' && url.origin === 'https://router.huggingface.co' && path === '/v1'
		&& model === 'deepseek-ai/DeepSeek-V4.1-Flash') return schema;
	const moonshot = providerId === 'moonshotai' ? 'api.moonshot.ai' : providerId === 'moonshotai-cn' ? 'api.moonshot.cn' : '';
	// https://platform.kimi.com/docs/api/responses
	if (url.hostname === moonshot && path === '/v1' && ['kimi-k3.1-pro', 'kimi-k3'].includes(model)) return schema;
	return undefined;
}

async function fetchCatalogJson(fetch: Transport['fetch'], url: URL, headers: HeadersInit, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		await response.body?.cancel();
		throw new ModelCatalogHttpError(response.status);
	}
	return response.json();
}

export class ModelCatalogHttpError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

export function readProviderCatalog(json: unknown): ModelCatalogResult {
	const page = json as CatalogPage | null;
	const rows = catalogRows(page);
	const details = new Map<string, ModelCatalogDetails>();
	for (const row of rows) {
		const id = catalogId(row);
		if (id && isChatModel(row, id, '')) addCatalogRow(details, id, row);
	}
	return { models: [...details.keys()], source: 'provider', details };
}

function catalogRows(page: CatalogPage | null, providerId = ''): CatalogRow[] {
	const keyedModels = page?.models && !Array.isArray(page.models) && typeof page.models === 'object'
		&& (providerId === 'openai-codex' || providerId === 'radius') ? Object.entries(page.models).map(([id, model]) => ({ ...model, id: catalogId(model) || id })) : undefined;
	const rows: unknown = Array.isArray(page) ? page : Array.isArray(page?.data) ? page.data
		: page?.output?.models ?? page?.result ?? page?.modelSummaries ?? page?.publisherModels ?? keyedModels ?? page?.models ?? page?.items;
	if (!Array.isArray(rows) || (rows.length && !rows.some(catalogId))) throw new Error('Invalid model catalog');
	return (rows as unknown[]).filter((row): row is CatalogRow => Boolean(row && typeof row === 'object'));
}

export async function fetchModelList(
	fetch: Transport['fetch'], url: URL, headers: HeadersInit, signal: AbortSignal, providerId = '', nonChat: ReadonlySet<string> = new Set(),
): Promise<ModelCatalogResult> {
	const requestHeaders = new Headers(headers);
	// 百炼等目录会拒绝缺少客户端标识的请求。
	if (!requestHeaders.has('user-agent')) requestHeaders.set('user-agent', 'Scribe-Ai');
	const details = new Map<string, ModelCatalogDetails>();
	const visited = new Set<string>();
	let current = new URL(url);
	let returned = 0;

	for (let count = 0; count < 100; count += 1) {
		signal.throwIfAborted();
		if (visited.has(current.href)) throw new Error('Model catalog pagination repeated a page');
		visited.add(current.href);
		const page = await fetchCatalogJson(fetch, current, requestHeaders, signal) as CatalogPage | null;
		const rows = catalogRows(page, providerId);
		returned += rows.length;
		for (const row of rows) {
			const id = catalogId(row).replace(/^(?:publishers\/google\/)?models\//u, '');
			if (id && isChatModel(row, id, providerId, nonChat)) addCatalogRow(details, id, row, providerId);
		}
		const nextLink = page?.links?.next;
		if (typeof nextLink === 'string' && nextLink) {
			const next = new URL(nextLink, current);
			if (next.origin !== url.origin || next.pathname !== url.pathname || next.username || next.password || next.hash) {
				throw new Error('Model catalog pagination changed the endpoint');
			}
			current = next;
			continue;
		}
		const token = page?.nextPageToken ?? page?.next_page_token;
		if (typeof token === 'string' && token) {
			current.searchParams.set(page?.nextPageToken ? 'pageToken' : 'page_token', token);
			continue;
		}
		const pageNumber = page?.result_info?.page;
		const perPage = page?.result_info?.per_page;
		const total = page?.result_info?.total_count;
		const pages = page?.result_info?.total_pages ?? (perPage && typeof total === 'number' ? Math.ceil(total / perPage) : undefined);
		if (typeof pageNumber === 'number' && typeof pages === 'number' && pageNumber < pages) {
			current.searchParams.set('page', String(pageNumber + 1));
			continue;
		}
		const workspace = page?.output;
		if (workspace && typeof workspace.page_no === 'number' && typeof workspace.page_size === 'number'
			&& typeof workspace.total === 'number' && workspace.page_no * workspace.page_size < workspace.total) {
			current.searchParams.set('page_no', String(workspace.page_no + 1));
			continue;
		}
		if (page?.has_more === true || page?.hasMore === true) {
			const cursor = page.last_id ?? page.lastId ?? catalogId(rows.at(-1));
			if (typeof cursor !== 'string' || !cursor) throw new Error('Model catalog pagination has no cursor');
			current.searchParams.set('after_id', cursor);
			continue;
		}
		if (typeof page?.total_count === 'number' && returned < page.total_count) throw new Error('Model catalog returned an incomplete list');
		return { models: [...details.keys()], source: 'provider', details };
	}
	throw new Error('Model catalog has too many pages');
}

export async function fetchModelsDevCatalog(fetch: Transport['fetch'], signal: AbortSignal): Promise<unknown> {
	const data = await fetchCatalogJson(fetch, new URL('https://models.dev/api.json'), { accept: 'application/json' }, signal);
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Models.dev catalog');
	return data;
}

export function modelsDevDetails(providerId: string, data: unknown, connection: {
	baseUrl: string; protocol: string; models: readonly Pick<ProviderModelInfo, 'id' | 'api' | 'baseUrl'>[];
}, checkedAt?: string): ReadonlyMap<string, ModelCatalogDetails> {
	const providers = data as Record<string, { api?: string; models?: Record<string, CatalogRow | null> }> | undefined;
	const provider = providers?.[MODELS_DEV_PROVIDERS.get(providerId) ?? providerId];
	const details = new Map<string, ModelCatalogDetails>();
	const routes = new Map(connection.models.map((model) => [model.id, model]));
	const normalize = (address: string) => address.replace(/\/$/u, '').replace(/\$\{/gu, '{');
	for (const [id, row] of Object.entries(provider?.models ?? {})) {
		const route = routes.get(id);
		const baseUrl = route?.baseUrl || connection.baseUrl;
		if (!baseUrl) continue;
		const sharedRouterCatalog = providerId === 'openrouter' && provider?.api === 'https://openrouter.ai/api/v1'
			&& route?.api === 'anthropic-messages' && normalize(baseUrl) === 'https://openrouter.ai/api';
		const messagesVersion = (route?.api ?? connection.protocol) === 'anthropic-messages'
			&& typeof provider?.api === 'string' && normalize(provider.api) === normalize(baseUrl) + '/v1';
		if (!sharedRouterCatalog && !messagesVersion && typeof provider?.api === 'string' && normalize(provider.api) !== normalize(baseUrl)) continue;
		// Parallel protocols of a gateway can expose different features on the same host.
		if (!sharedRouterCatalog && typeof provider?.api === 'string' && !connection.protocol && route?.api !== 'openai-completions'
			&& !(providerId === 'openrouter' && !route)) continue;
		if (!row || typeof row !== 'object') continue;
		addCatalogRow(details, id, row);
		if (providerId === 'fireworks' && route?.api === 'openai-completions' && row.structured_output === true) {
			// The documented Fireworks Chat capability uses a JSON Schema, on this route only.
			// https://docs.fireworks.ai/structured-responses/structured-response-formatting
			details.set(id, { ...details.get(id), structuredOutput: true });
		}
		if (sharedRouterCatalog || providerId === 'vercel-ai-gateway') {
			const input = details.get(id)?.inputModalities;
			// Chat and Messages share the model registry. The published video codec is Chat-only.
			details.set(id, { ...details.get(id), ...input && { inputModalities: input.filter((value) => value !== 'video') },
				structuredOutput: undefined });
		}
	}
	return sourceModelCatalogDetails(details, 'models.dev', checkedAt);
}

export function readStoredModelDetails(value: unknown): ModelCatalogDetails {
	if (!value || typeof value !== 'object') return {};
	const row = value as ModelCatalogDetails;
	const fields: ModelCatalogDetails = {
		connectionProtocol: typeof row.connectionProtocol === 'string' ? row.connectionProtocol : undefined,
		contextWindow: positiveInteger(row.contextWindow),
		maxTokens: positiveInteger(row.maxTokens),
		reasoning: catalogFlag(row.reasoning),
		tools: catalogFlag(row.tools),
		structuredOutput: catalogFlag(row.structuredOutput),
		jsonOutput: catalogFlag(row.jsonOutput),
		thinkingLevels: catalogStrings(row.thinkingLevels),
		reportedThinkingLevels: catalogStrings(row.reportedThinkingLevels),
		inputModalities: catalogStrings(row.inputModalities),
		videoInput: catalogFlag(row.videoInput),
		outputModalities: catalogStrings(row.outputModalities),
	};
	const evidence: ModelCatalogDetails['evidence'] = {};
	for (const field of catalogFields(fields)) {
		const entry = row.evidence?.[field];
		if (entry && Object.prototype.hasOwnProperty.call(evidenceRanks, entry.source)) {
			evidence[field] = { source: entry.source,
				...(typeof entry.checkedAt === 'string' && { checkedAt: entry.checkedAt }),
				...(entry.conflict === true && { conflict: true }),
			};
		}
	}
	const clean: ModelCatalogDetails = Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
	if (Object.keys(evidence).length) clean.evidence = evidence;
	return clean;
}

export async function fetchPiModelCatalog(providerId: string, fetch: Transport['fetch'], signal: AbortSignal): Promise<ModelCatalogResult> {
	const url = new URL(`https://pi.dev/api/models/providers/${encodeURIComponent(providerId)}`);
	url.searchParams.set('pi-version', PI_AI_VERSION);
	return readPiModelCatalog(await fetchCatalogJson(fetch, url, { accept: 'application/json' }, signal), providerId);
}

export function fetchPiCatalog(fetch: Transport['fetch'], signal: AbortSignal): Promise<unknown> {
	const url = new URL('https://pi.dev/api/models');
	url.searchParams.set('pi-version', PI_AI_VERSION);
	return fetchCatalogJson(fetch, url, { accept: 'application/json' }, signal);
}

export function readPiModelCatalog(catalog: unknown, providerId = ''): ModelCatalogResult {
	if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('Invalid Pi model catalog');
	const entries = Object.values(catalog) as Array<CatalogRow | null>;
	const details = new Map<string, ModelCatalogDetails>();
	for (const row of entries) {
		if (row?.type !== 'chat') continue;
		const id = catalogId(row);
		if (id) addCatalogRow(details, id, row, providerId);
	}
	if (entries.length && !details.size) throw new Error('Invalid Pi model catalog');
	return { models: [...details.keys()], source: 'pi', details };
}
