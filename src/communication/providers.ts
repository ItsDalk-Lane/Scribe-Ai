import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Api,
	Context,
	ImageContent,
	JsonObject,
	Message as PiMessage,
	Model,
	MutableModels,
	Provider,
	SimpleStreamOptions,
	ThinkingLevel,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { registerLazyOAuthFlows } from '@earendil-works/pi-ai/lazy-oauth';
import { clampThinkingLevel, createProvider, getSupportedThinkingLevels, isContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai';
import * as anthropicMessages from '@earendil-works/pi-ai/api/anthropic-messages';
import * as azureOpenaiResponses from '@earendil-works/pi-ai/api/azure-openai-responses';
import * as bedrockConverseStream from '@earendil-works/pi-ai/api/bedrock-converse-stream';
import * as googleGenerativeAi from '@earendil-works/pi-ai/api/google-generative-ai';
import * as googleVertex from '@earendil-works/pi-ai/api/google-vertex';
import * as mistralConversations from '@earendil-works/pi-ai/api/mistral-conversations';
import * as openaiCodexResponses from '@earendil-works/pi-ai/api/openai-codex-responses';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions';
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses';
import * as piMessages from '@earendil-works/pi-ai/api/pi-messages';
import { EXTRA_IMAGE_LIMITS, EXTRA_PROVIDERS } from './extraProviders';
import { documentedModelDetails, documentedRouteDetails, fetchModelList, fetchModelsDevCatalog, fetchPiModelCatalog,
	mergeModelCatalogDetails, ModelCatalogHttpError, modelsDevDetails, readPiModelCatalog, sourceModelCatalogDetails } from './modelCatalog';
import { ACCOUNT_CATALOGS, fetchAccountModelCatalog } from './modelCatalogAccounts';
import { fetchOfficialModelCatalog } from './modelCatalogProviders';
import { openCodeConnection } from './openCodeModels';
import { resolveModelConnection } from './modelConnection';
import { applyResponseSchema, supportsResponseSchema } from './modelFeatures';
import { bufferedGroqSchemaFetch, needsBufferedGroqSchema } from './groqSchema';
import { applyModelVideo, catalogVideoInput, nativeVideoFormat, videoTakesOnlyUrls } from './modelVideo';
import { confirmModelRequest, modelRequestConfirmation } from './modelRequestConfirmation';
import type { ModelRequestConfirmation } from './modelRequestConfirmation';
import { modelNodeFetch, nodeFetch } from './nodeFetch';
import { isSecureServiceUrl } from './serviceAddress';
import { captureReportedUsage, reportedCost } from './reportedUsage';
import { ContextOverflowError, RetryableModelError } from '../types';
import { isBuiltInThinkingLevel, isThinkingLevel } from '../orchestration/settings/thinking';
import type {
	CredentialStore,
	Message,
	CustomProviderDef,
	ModelCatalogDetails,
	ModelCatalogResult,
	ModelConnectionIssue,
	ModelOverride,
	ModelProviderInfo,
	ModelRequest,
	ModelResponse,
	ModelService,
	ModelStream,
	ModelStreamEvent,
	ReportedUsage,
	Transport,
} from '../types';

function toPiMessage(message: Message, images?: ImageContent[]): PiMessage {
	const timestamp = Date.now();
	if (message.role === 'system') return { role: 'system', content: message.content, timestamp };
	if (message.role === 'user') return { role: 'user', content: images?.length
		? [...(message.content ? [{ type: 'text' as const, text: message.content }] : []), ...images] : message.content, timestamp };
	if (message.role === 'tool') {
		if (!message.toolCallId) throw new Error('Tool messages require toolCallId');
		return {
			role: 'toolResult',
			toolCallId: message.toolCallId,
			toolName: message.toolName ?? message.toolCallId,
			content: [{ type: 'text', text: message.imageRefs?.length && !images?.length
				? message.content + '\n（此模型请求未携带这项工具返回的图片。）' : message.content }, ...(images ?? [])],
			isError: message.isError ?? false,
			timestamp,
		};
	}
	const raw = message.rawAssistant;
	if (raw) return { ...raw, content: raw.content.map((block) => {
		if (block.type !== 'thinking' || block.durationMs === undefined) return block;
		const content = { ...block };
		delete content.durationMs;
		return content;
	}) };
	return {
		role: 'assistant',
		content: [
			...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
			...(message.toolCalls ?? []).map((call) => ({
				type: 'toolCall' as const,
				id: call.id,
				name: call.name,
				arguments: call.input as JsonObject,
			})),
		],
		api: 'openai-completions',
		provider: 'scribe-history',
		model: 'unknown',
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: message.toolCalls?.length ? 'toolUse' : 'stop',
		timestamp,
	};
}

function toContext(request: ModelRequest, toolsEnabled: boolean, images?: Map<number, ImageContent[]>): Context {
	return {
		systemPrompt: request.system,
		messages: request.messages.map((message, index) => toPiMessage(message, images?.get(index))),
		tools: toolsEnabled ? request.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		})) : [],
	};
}

function configuredThinking(override: ModelOverride | undefined): string[] | undefined {
	return Array.isArray(override?.thinkingLevels) ? override.thinkingLevels : override?.thinkingLevel ? [override.thinkingLevel] : undefined;
}

function reasoningLevels(model: Model<Api>, override: ModelOverride | undefined): string[] {
	const required = model.thinkingLevelMap?.off === null;
	const enabled = override?.capabilities?.reasoning;
	if ((!model.reasoning && enabled !== true) || (enabled === false && !required)) return [];
	const supported = getSupportedThinkingLevels({ ...model, reasoning: true });
	const configured = configuredThinking(override);
	if (!configured) return supported;
	const allowed = [...new Set(configured.filter((level) => isThinkingLevel(level) && (
		(isBuiltInThinkingLevel(level) && supported.includes(level))
		|| (override?.literalThinkingLevels && level !== 'off' && level !== 'minimal')
	)))];
	return required && !allowed.length ? supported : allowed;
}

function defaultReasoning(model: Model<Api>, override: ModelOverride | undefined, levels: string[]): string | undefined {
	const configured = configuredThinking(override)?.find((level) => levels.includes(level));
	if (configured) return configured;
	if (model.thinkingLevelMap?.off !== null && override?.capabilities?.reasoning !== true) return undefined;
	const low = clampThinkingLevel({ ...model, reasoning: true }, 'low');
	return low !== 'off' && levels.includes(low) ? low : levels.find((level) => level !== 'off');
}

function selectedReasoning(model: Model<Api>, override: ModelOverride | undefined, levels: string[], preferred?: string | null): string | undefined {
	if (preferred && levels.includes(preferred)) return preferred;
	return defaultReasoning(model, override, levels) ?? (preferred ? levels[0] : undefined);
}

function resolveReasoning(model: Model<Api>, override: ModelOverride | undefined, requested?: string | null): string | undefined {
	if (requested === null && model.thinkingLevelMap?.off !== null) return undefined;
	const levels = reasoningLevels(model, override);
	const level = selectedReasoning(model, override, levels, requested);
	return level === 'off' ? undefined : level;
}

function payloadIncludesEffort(payload: unknown, effort: string): boolean {
	const fields = payload as {
		reasoning_effort?: unknown;
		reasoningEffort?: unknown;
		reasoning?: { effort?: unknown };
		thinking?: unknown;
		output_config?: { effort?: unknown };
		additionalModelRequestFields?: unknown;
	} | undefined;
	return !!fields && (fields.reasoning_effort === effort || fields.reasoningEffort === effort
		|| fields.reasoning?.effort === effort || fields.thinking === effort || fields.output_config?.effort === effort
		|| payloadIncludesEffort(fields.additionalModelRequestFields, effort));
}

function toResponse(message: AssistantMessage, reportedUsage: ReportedUsage): ModelResponse {
	if (isContextOverflow(message)) throw new ContextOverflowError(message.errorMessage);
	if (isRetryableAssistantError(message)) throw new RetryableModelError(message.errorMessage);
	if (message.stopReason === 'error' || message.stopReason === 'aborted') {
		throw new Error(message.errorMessage || `Model request ${message.stopReason}`);
	}
	const stopReason = message.stopReason === 'toolUse'
		? 'tool-calls'
		: message.stopReason === 'length'
			? 'limit'
			: 'end';
	const thinking = message.content
		.filter((block) => block.type === 'thinking')
		.map((block) => block.thinking)
		.join('');
	return {
		content: message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
		...(thinking ? { thinking } : {}),
		toolCalls: message.content.filter((block) => block.type === 'toolCall').map((call) => ({
			id: call.id,
			name: call.name,
			input: call.arguments,
		})),
		stopReason,
		usage: message.usage,
		reportedUsage,
		raw: message,
	};
}

class PiModelStream implements ModelStream {
	constructor(
		private source: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
		private controller: AbortController,
		private cleanup: () => void,
		private readUsage: () => ReportedUsage,
		private confirmation: ModelRequestConfirmation | undefined,
		private structuredOutput: boolean,
		private onUsage?: Parameters<ModelService['send']>[1],
	) {}

	[Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
		const iterate = async function* (this: PiModelStream) {
			try {
				for await (const event of await this.source) yield event;
			} finally {
				this.cleanup();
			}
		};
		return iterate.call(this)[Symbol.asyncIterator]();
	}

	async result(): Promise<ModelResponse> {
		try {
			const response = await (await this.source).result();
			if (this.confirmation?.failure) throw this.confirmation.failure;
			const reportedUsage = this.readUsage();
			this.onUsage?.({ reportedUsage, cost: reportedCost(response.usage) });
			const result = toResponse(response, reportedUsage);
			if (!this.structuredOutput) return result;
			if (result.stopReason === 'end' && !result.toolCalls.length) {
				try { JSON.parse(result.content); } catch { throw new Error('模型未返回有效的结构化 JSON。'); }
			}
			return { ...result, structuredOutput: true };
		} finally {
			this.cleanup();
		}
	}

	cancel(reason?: unknown): void {
		const error = reason instanceof Error
			? reason
			: new Error(reason === undefined ? 'Cancelled' : JSON.stringify(reason));
		this.controller.abort(error);
	}
}

/** 服务商自带地址：provider 级字段优先，其次取模型里唯一的那个地址（各模型不一致时返回空） */
function providerBaseUrl(provider: Provider): string {
	const urls = new Set(
		provider.getModels()
			.map((model) => model.baseUrl)
			.filter((url): url is string => Boolean(url)),
	);
	return provider.baseUrl ?? (urls.size === 1 ? [...urls][0] ?? '' : '');
}

function catalogSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(15_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function piCatalogDetails(models: readonly Model<Api>[]): Map<string, ModelCatalogDetails> {
	return new Map(models.map((model) => [model.id, {
		...(model.contextWindow > 0 && { contextWindow: model.contextWindow }),
		...(model.maxTokens > 0 && { maxTokens: model.maxTokens }),
		inputModalities: model.input,
		outputModalities: ['text'],
		reasoning: model.reasoning,
		thinkingLevels: getSupportedThinkingLevels(model).filter((level) => level !== 'off'),
	}]));
}

const API_MODULES = {
	'anthropic-messages': anthropicMessages,
	'azure-openai-responses': azureOpenaiResponses,
	'bedrock-converse-stream': bedrockConverseStream,
	'google-generative-ai': googleGenerativeAi,
	'google-vertex': googleVertex,
	'mistral-conversations': mistralConversations,
	'openai-codex-responses': openaiCodexResponses,
	'openai-completions': openaiCompletions,
	'openai-responses': openaiResponses,
	'pi-messages': piMessages,
};

/** 服务商自带协议：各模型协议一致时返回该协议，不一致时返回空 */
function providerProtocol(provider: Provider): string {
	const protocols = new Set(provider.getModels().map((model) => model.api));
	return protocols.size === 1 ? [...protocols][0] ?? '' : '';
}

/** 可切换的协议：pi-ai 内置的全部对话协议实现 */
export const API_PROTOCOLS = Object.keys(API_MODULES);

const CONNECTION_ERRORS: Record<ModelConnectionIssue, string> = {
	'unknown-provider': '未找到模型服务商。',
	'missing-protocol': '无法确认此模型的 API 协议，请在模型配置中选择。',
	'unsupported-protocol': '插件未接通此 API 协议，请重新选择。',
	'missing-address': '无法确认此协议的 Base URL，请填写对应的请求地址。',
	'invalid-address': '远程模型服务需要 HTTPS 地址；本机回环地址可以使用 HTTP。',
	'incompatible-address': 'Base URL 与所选 API 协议或 OpenCode 套餐不匹配，请更正地址或清空以自动选择。',
};

interface ModelServiceOptions {
	additionalProviders?: Provider[];
	/** 运行时读取，保存设置后无需重建服务；空值表示用服务商自带地址 */
	baseUrls?: () => Record<string, string>;
	/** 运行时读取；空值表示用模型自带协议 */
	protocols?: () => Record<string, string>;
	/** 每模型覆盖配置，优先级高于服务商级 baseUrls/protocols */
	modelOverrides?: () => Record<string, Record<string, ModelOverride>>;
	/** 自建服务商（自定义端点/本地模型）：按设置现算，模型 ID 由用户手填 */
	customProviders?: () => CustomProviderDef[];
	catalogProtocol?: (providerId: string, model: string) => string | undefined;
	catalogDetails?: (providerId: string, model: string, baseUrl?: string) => ModelCatalogDetails | undefined;
}

/** pi-ai 负责全部内置 Provider 的协议与能力差异，本层只转换插件契约并注入连接条件。 */
export function createModelService(
	credentials: CredentialStore,
	transport: Transport,
	serviceOptions: ModelServiceOptions = {},
): ModelService {
	registerLazyOAuthFlows();
	const models: MutableModels = builtinModels({ credentials, authContext: {
		env: async () => undefined,
		async fileExists(path) {
			const credential = await credentials.read('google-vertex');
			if (credential?.type !== 'api_key' || !path || path !== credential.env?.GOOGLE_APPLICATION_CREDENTIALS) return false;
			return access(path).then(() => true, () => false);
		},
	} });
	for (const provider of serviceOptions.additionalProviders ?? []) models.setProvider(provider);
	// 目录外第一方服务商：带完整元数据注册成普通 Provider，与内置服务商共用请求/覆盖/聚合逻辑
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const def of EXTRA_PROVIDERS) {
		const cloned = def.cloneFrom
			? (models.getProvider(def.cloneFrom)?.getModels() ?? [])
				.filter((model) => !def.cloneModelIds || def.cloneModelIds.includes(model.id))
				.map<Model<Api>>((model) => ({ ...model, api: def.api, provider: def.id, baseUrl: def.baseUrl }))
			: [];
		const extra = def.models.map<Model<Api>>((model) => ({
			...model,
			api: def.api,
			provider: def.id,
			baseUrl: def.baseUrl,
			cost: zeroCost,
			inputLimits: EXTRA_IMAGE_LIMITS,
		}));
		const byId = new Map([...cloned, ...extra].map((model) => [model.id, model]));
		models.setProvider(createProvider({
			id: def.id,
			name: def.name,
			baseUrl: def.baseUrl,
			auth: {
				apiKey: {
					name: def.name,
					resolve: async ({ credential }) => (credential?.type === 'api_key' && credential.key
						? { auth: { apiKey: credential.key } }
						: undefined),
				},
			},
			models: [...byId.values()],
			api: API_MODULES,
		}));
	}

	// 自建服务商没有目录元数据：使用中性聊天模型，避免继承任意内置模型的推理/模态行为
	const registered = new Set<string>();
	const syncCustomProviders = (): void => {
		const defs = serviceOptions.customProviders?.() ?? [];
		const live = new Set<string>();
		for (const def of defs) {
			live.add(def.id);
			models.setProvider(createProvider({
				id: def.id,
				name: def.label || def.id,
				baseUrl: def.baseUrl,
				auth: {
					apiKey: {
						name: def.label || def.id,
						// 只认本插件密钥库里的 API key；本地服务可无 key，给占位值避免 SDK 拒绝空 key
						resolve: async ({ credential }) => ({
							auth: { apiKey: credential?.type === 'api_key' && credential.key ? credential.key : 'local' },
						}),
					},
				},
				models: def.models.map<Model<Api>>((id) => ({
					id,
					name: id,
					provider: def.id,
					baseUrl: def.baseUrl,
					api: def.protocol || 'openai-completions',
					reasoning: false,
					input: ['text'],
					cost: zeroCost,
					// 无官方元数据时只给可预测的文本聊天兜底，覆盖项再逐字段修改
					contextWindow: 128000,
					maxTokens: 8000,
				})),
				api: API_MODULES,
			}));
		}
		for (const id of registered) if (!live.has(id)) models.deleteProvider(id);
		registered.clear();
		for (const id of live) registered.add(id);
	};

	const contextLimits = ({ providerId, model: modelId }: Pick<ModelRequest, 'providerId' | 'model'>) => {
		const route = resolve(providerId, modelId);
		const { override, exact } = route;
		const details = connectionCatalogDetails(providerId, modelId, route);
		// 自建服务商目录中的窗口只是占位，只有明确填写的覆盖值可用于预算。
		const model = registered.has(providerId) ? undefined : exact;
		return {
			contextWindow: override?.contextWindow || details?.contextWindow || model?.contextWindow || 0,
			maxTokens: override?.maxTokens || details?.maxTokens || model?.maxTokens || 0,
		};
	};
	const extended = new Map<string, Provider>();
	const ensureAdapter = (provider: Provider, api: string) => {
		const native = (selected: string) => Boolean(openCodeConnection(provider.id, selected))
			|| provider.getModels().some((entry) => entry.api === selected);
		if (registered.has(provider.id) || extended.get(provider.id) === provider || native(api)) return;
		// 按每个请求的协议选适配器，保留服务商的目录和原生请求处理。
		const generic = createProvider({ id: provider.id, auth: provider.auth, models: [], api: API_MODULES });
		const adapter = (model: Model<Api>) => native(model.api) ? provider : generic;
		const updated: Provider = {
			...provider,
			stream: (model, context, options) => adapter(model).stream(model, context, options),
			streamSimple: (model, context, options) => adapter(model).streamSimple(model, context, options),
		};
		models.setProvider(updated);
		extended.set(provider.id, updated);
	};
	const resolve = (providerId: string, id: string, useModelOverride = true) => {
		syncCustomProviders();
		const provider = models.getProvider(providerId);
		const exact = models.getModel(providerId, id);
		const override = serviceOptions.modelOverrides?.()[providerId]?.[id];
		const connection = resolveModelConnection({
			provider, model: exact, modelOverride: useModelOverride ? override : undefined, protocols: API_PROTOCOLS,
			catalogProtocol: serviceOptions.catalogProtocol?.(providerId, id),
			providerOverride: { protocol: serviceOptions.protocols?.()[providerId], baseUrl: serviceOptions.baseUrls?.()[providerId] },
		});
		return { provider, exact, override, connection };
	};
	const thinkingOptions: ModelService['thinkingOptions'] = ({ providerId, model: modelId }, preferred) => {
		const { model, override } = requestModel(providerId, modelId);
		if (!model) return { levels: [] };
		const levels = reasoningLevels(model, override);
		const level = selectedReasoning(model, override, levels, preferred);
		return { levels, level };
	};

	function requestModel(providerId: string, id: string) {
		const route = resolve(providerId, id);
		const { provider, exact, override, connection } = route;
		const { api, baseUrl, issue } = connection;
		if (issue || !provider) return { provider, connection, override, model: undefined };
		const details = connectionCatalogDetails(providerId, id, route);
		const model: Model<Api> = exact
			? { ...exact, api, baseUrl, ...(exact.api !== api && { compat: undefined }) }
			: { id, name: id, provider: providerId, api, baseUrl, reasoning: false,
				input: ['text'], cost: zeroCost, contextWindow: 128000, maxTokens: 8000 };
		const inputs = override?.input ?? (details?.evidence?.inputModalities?.conflict ? undefined : details?.inputModalities);
		if (inputs) model.input = inputs.includes('image') ? ['text', 'image'] : ['text'];
		const reported = details?.reportedThinkingLevels?.filter(isThinkingLevel);
		const capabilities = { reasoning: details?.reasoning, ...override?.capabilities };
		if (capabilities.reasoning === true) model.reasoning = true;
		const literal = reported?.some((level) => level !== 'off' && level !== 'minimal' && !getSupportedThinkingLevels(model).includes(level as ThinkingLevel));
		const effective: ModelOverride = {
			contextWindow: details?.contextWindow, maxTokens: details?.maxTokens,
			...(!override?.thinkingLevel && !override?.thinkingLevels && reported?.length && {
				thinkingLevels: [...reported],
				...(literal && { literalThinkingLevels: true as const }),
			}),
			...override, capabilities,
		};
		return { provider, connection, override: effective, model };
	}

	function connectionCatalogDetails(providerId: string, id: string, { provider, connection, override }: Pick<ReturnType<typeof resolve>, 'provider' | 'connection' | 'override'>) {
		if (connection.issue) return undefined;
		const normalize = (address?: string) => (URL.parse(address ?? '')?.href ?? address ?? '').replace(/\/+$/u, '');
		const hasConnectionOverride = Boolean(override?.protocol || override?.baseUrl);
		const catalogConnection = hasConnectionOverride ? resolve(providerId, id, false).connection : connection;
		let details: ModelCatalogDetails | undefined;
		if (provider && catalogConnection.api === connection.api && normalize(catalogConnection.baseUrl) === normalize(connection.baseUrl)) {
			const configuredAddress = serviceOptions.baseUrls?.()[providerId] || (registered.has(providerId) ? provider.baseUrl : undefined);
			const configuredProtocol = serviceOptions.protocols?.()[providerId];
			const catalogAddress = (registered.has(providerId) || (configuredAddress && normalize(configuredAddress) !== normalize(providerBaseUrl(provider))))
				? configuredAddress : undefined;
			details = serviceOptions.catalogDetails?.(providerId, id, catalogAddress)
				?? (!catalogAddress && (!configuredProtocol || configuredProtocol === providerProtocol(provider))
					? documentedModelDetails(providerId).get(id) : undefined);
			const bundled = provider.getModels().find((model) => model.id === id);
			const catalogApi = details?.connectionProtocol || (!catalogAddress ? bundled?.api : undefined);
			if (catalogApi && catalogApi !== connection.api) details = undefined;
		}
		const routeDetails = documentedRouteDetails(providerId, id, connection.api, connection.baseUrl);
		return routeDetails ? mergeModelCatalogDetails(new Map([[id, routeDetails]]), details && new Map([[id, details]])).get(id) : details;
	}

	function modelFeatures(providerId: string, id: string, route: Pick<ReturnType<typeof resolve>, 'provider' | 'connection' | 'override'>) {
		const { connection, override } = route;
		const details = connectionCatalogDetails(providerId, id, route);
		const structuredOutput = (override?.capabilities?.structuredOutput
			?? (details?.evidence?.structuredOutput?.conflict ? undefined : details?.structuredOutput)) === true
			&& supportsResponseSchema(connection.api, connection.baseUrl, id);
		const videoInput = override?.input?.includes('video') ?? catalogVideoInput(details);
		const tools = override?.capabilities?.tools ?? details?.tools ?? true;
		return { structuredOutput, videoInput, tools };
	}

	const stream = (request: ModelRequest, onUsage?: Parameters<ModelService['send']>[1]): ModelStream => {
		const { provider, connection, override, model: selectedModel } = requestModel(request.providerId, request.model);
		if (!provider || !selectedModel) throw new Error(CONNECTION_ERRORS[connection.issue ?? 'unknown-provider']);
		const features = modelFeatures(request.providerId, request.model, { provider, connection, override });
		const vision = selectedModel.input.includes('image');
		if (request.images?.required && !vision) throw new Error('当前模型连接未启用图片输入，请选择支持图片的模型。');
		const schema = request.responseSchema;
		if (schema && !features.structuredOutput) throw new Error('当前模型连接未启用结构化输出。');
		const video = request.video;
		const videoFormat = video && features.videoInput ? nativeVideoFormat(connection, selectedModel.id) : undefined;
		const videoMarker = video ? `[scribe-video-${randomUUID()}]\n` : undefined;
		if (video && !videoFormat) throw new Error('当前模型连接无法发送视频，请选择已接通视频输入的模型。');
		if (video?.hasFiles && videoTakesOnlyUrls(videoFormat)) throw new Error('当前模型接口接受 HTTPS 视频链接，请以 Markdown 视频嵌入链接提交。');
		ensureAdapter(provider, selectedModel.api);
		let model = selectedModel;
		if (override?.contextWindow) model = { ...model, contextWindow: override.contextWindow };
		if (override?.maxTokens) model = { ...model, maxTokens: override.maxTokens };
		const level = resolveReasoning(model, override, request.reasoning);
		let reasoning: ThinkingLevel | undefined;
		let onPayload: SimpleStreamOptions['onPayload'];
		if (level) {
			const native = isBuiltInThinkingLevel(level) && level !== 'off' && getSupportedThinkingLevels(model).includes(level);
			if (override?.literalThinkingLevels && level !== 'minimal' && configuredThinking(override)?.includes(level)) {
				// 让 SDK 按服务商自己的参数格式发送原值，任意英文档位共用一个内部档位。
				reasoning = native ? level : 'low';
				model = { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, [reasoning]: level } };
				if (!native) onPayload = (payload) => {
					if (!payloadIncludesEffort(payload, level)) throw new Error(`The model does not accept a text reasoning effort (${level}).`);
				};
			} else if (native) reasoning = level;
		}
		if (schema || video) {
			const validateThinking = onPayload;
			onPayload = async (payload, activeModel) => {
				await validateThinking?.(payload, activeModel);
				const fields = schema ? applyResponseSchema(payload, model.api, schema, model.baseUrl) : payload;
				return video && videoFormat && videoMarker
					? applyModelVideo(fields, videoFormat, videoMarker, await video.load(controller.signal))
					: fields;
			};
		}
		const controller = new AbortController();
		const onAbort = () => controller.abort(request.signal?.reason);
		if (request.signal?.aborted) onAbort();
		request.signal?.addEventListener('abort', onAbort, { once: true });
		const cleanup = () => request.signal?.removeEventListener('abort', onAbort);
		const configuredAddress = override?.baseUrl?.trim() || serviceOptions.baseUrls?.()[request.providerId]?.trim() || registered.has(request.providerId);
		const expectedBase = configuredAddress && connection.baseUrl ? new URL(connection.baseUrl) : undefined;
		const confirmation = request.beforeSend || expectedBase
			? { beforeSend: request.beforeSend, expectedBase, controller } : undefined;
		const confirmedFetch: typeof fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input);
			// Anthropic 的凭据交换也用同一个 fetch，聊天请求固定走 messages。
			if (model.api === 'anthropic-messages' && url.pathname.endsWith('/v1/oauth/token') && isSecureServiceUrl(url)) {
				return transport.fetch(input, init);
			}
			if (transport.fetch === nodeFetch) return modelNodeFetch(input, init);
			await confirmModelRequest(url);
			controller.signal.throwIfAborted();
			return transport.fetch(input, init);
		};
		const reportedUsage = captureReportedUsage(model.api);
		const fetchModel = confirmedFetch;
		const options: SimpleStreamOptions = {
			signal: controller.signal,
			maxTokens: override?.maxTokens && request.maxTokens !== undefined
				? Math.min(request.maxTokens, override.maxTokens)
				: request.maxTokens,
			temperature: request.temperature,
			reasoning,
			onPayload,
			sessionId: request.sessionId,
			maxRetries: request.maxRetries ?? 2,
			maxRetryDelayMs: 60_000,
			// shortcut: SDK total timeout is capped at 24.8 days; remove when SDK supports disabling it.
			timeoutMs: 2_147_483_647,
			transport: 'sse',
			onProviderStreamEvent: (event) => reportedUsage.observe(event),
			fetch: schema && needsBufferedGroqSchema(connection) ? bufferedGroqSchemaFetch(fetchModel) : fetchModel,
		};
		try {
			const input = video && videoMarker ? {
				...request,
				messages: request.messages.map((message, index) => index === video.messageIndex
					? { ...message, content: videoMarker + message.content } : message),
			} : request;
			const start = (images?: Map<number, ImageContent[]>) => {
				controller.signal.throwIfAborted();
				const context = toContext(input, features.tools, images);
				return confirmation
					? modelRequestConfirmation.run(confirmation, () => models.streamSimple(model, context, options))
					: models.streamSimple(model, context, options);
			};
			const source = vision && request.images ? request.images.load(controller.signal).then(start) : start();
			return new PiModelStream(source, controller, cleanup, reportedUsage.read, confirmation, Boolean(schema), onUsage);
		} catch (error) {
			cleanup();
			throw error;
		}
	};

	async function discoverProviderModels(provider: Provider, signal?: AbortSignal, sharedPiCatalog?: () => Promise<unknown>): Promise<ModelCatalogResult> {
		const providerId = provider.id;
		const bundled = provider.getModels();
		const nonChat = new Set(provider.getAllModels?.().filter((model) => model.type && model.type !== 'chat').map((model) => model.id));
		for (const model of bundled) nonChat.delete(model.id);
		try {
			const requestSignal = catalogSignal(signal);
			const baseUrl = providerBaseUrl(provider);
			if (ACCOUNT_CATALOGS.has(providerId)) {
				const credential = await credentials.read(providerId, { signal: requestSignal });
				const resolved = credential ? await models.getAuth(providerId, { signal: requestSignal }) : undefined;
				const catalog = await fetchAccountModelCatalog(providerId, baseUrl, credential, resolved, transport.fetch, requestSignal, nonChat);
				signal?.throwIfAborted();
				if (catalog) return catalog;
			} else {
				const catalog = await fetchOfficialModelCatalog(providerId, baseUrl, credentials, transport.fetch, requestSignal, nonChat);
				signal?.throwIfAborted();
				if (catalog) return catalog;
			}
		} catch {
			signal?.throwIfAborted();
		}
		try {
			if (provider.refreshModels) {
				const result = await models.refresh({ allowNetwork: true, force: true, providers: [providerId], signal: catalogSignal(signal) });
				signal?.throwIfAborted();
				const refreshed = provider.getModels();
				if (!result.aborted && !result.errors.size && refreshed !== bundled) {
					return { models: refreshed.map((model) => model.id), source: 'provider',
						details: sourceModelCatalogDetails(piCatalogDetails(refreshed), 'pi', new Date().toISOString()) };
				}
			}
		} catch {
			signal?.throwIfAborted();
		}

		// 额外预置没有同套餐的 Pi 目录，避免把另一个套餐的模型当成可选。
		const piId = EXTRA_PROVIDERS.some((entry) => entry.id === providerId) ? undefined : providerId;
		if (piId) {
			try {
				const catalog = sharedPiCatalog
					? readPiModelCatalog(((await sharedPiCatalog()) as Record<string, unknown> | undefined)?.[piId], piId)
					: await fetchPiModelCatalog(piId, transport.fetch, catalogSignal(signal));
				signal?.throwIfAborted();
				return catalog;
			} catch {
				signal?.throwIfAborted();
			}
		}
		return { models: provider.getModels().map((model) => model.id), source: 'bundled' };
	}

	async function readCustomModelCatalog(providerId: string, baseUrl: string, signal?: AbortSignal): ReturnType<ModelService['listCustomModels']> {
		const requestSignal = catalogSignal(signal);
		const url = new URL(baseUrl.trim());
		let endpoint = url.href.replace(/\/+$/, '');
		if (!isSecureServiceUrl(url) || url.search || url.hash) {
			throw new Error(CONNECTION_ERRORS['invalid-address']);
		}
		const credential = await credentials.read(providerId, { signal: requestSignal });
		const headers: Record<string, string> = { accept: 'application/json' };
		const configuredProtocol = serviceOptions.protocols?.()[providerId];
		const finish = (catalog: ModelCatalogResult) => {
			const protocol = configuredProtocol || (providerId === 'azure' ? 'azure-openai-responses' : '');
			const confirmed = new Map<string, ModelCatalogDetails>();
			for (const model of catalog.models) {
				const details = documentedRouteDetails(providerId, model, protocol, endpoint);
				if (details) confirmed.set(model, details);
			}
			return { models: catalog.models, details: mergeModelCatalogDetails(catalog.details, confirmed), baseUrl: endpoint };
		};
		if (['azure', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'amazon-bedrock', 'bailian-payg'].includes(providerId)) {
			const catalog = await fetchAccountModelCatalog(providerId, endpoint, credential, undefined, transport.fetch, requestSignal);
			if (catalog) return finish(catalog);
		}
		const protocol = configuredProtocol
			|| serviceOptions.customProviders?.().find(({ id }) => id === providerId)?.protocol
			|| (providerId === 'anthropic' || /^minimax(?:-cn)?$/u.test(providerId) ? 'anthropic-messages' : '')
			|| (providerId === 'google' ? 'google-generative-ai' : '');
		if (credential?.type === 'api_key' && credential.key) {
			if (protocol === 'anthropic-messages') headers['x-api-key'] = credential.key;
			else if (protocol === 'google-generative-ai') headers['x-goog-api-key'] = credential.key;
			else headers.authorization = `Bearer ${credential.key}`;
		}
		if (protocol === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
		const read = (address: string) => fetchModelList(transport.fetch, new URL(address + '/models'), headers, requestSignal, providerId);
		let catalog: ModelCatalogResult;
		try {
			catalog = await read(endpoint);
		} catch (error) {
			if (!(error instanceof ModelCatalogHttpError) || ![404, 405].includes(error.status) || /\/v1$/iu.test(endpoint)) throw error;
			// 与原连接保持在同一服务及路径下，验证版本前缀后才用作聊天地址。
			endpoint += '/v1';
			catalog = await read(endpoint);
		}
		requestSignal.throwIfAborted();
		return finish(catalog);
	}

	return {
		contextLimits,
		modelConnection: (providerId, id) => resolve(providerId, id).connection,
		modelOrigin: ({ providerId, model: id }) => {
			const { connection } = resolve(providerId, id);
			return connection.issue ? undefined : URL.parse(connection.baseUrl)?.origin;
		},
		thinkingOptions,
		providers: (): ModelProviderInfo[] => {
			syncCustomProviders();
			return models.getProviders().map((provider) => ({
				id: provider.id,
				label: provider.name,
				models: provider.getModels().map((model) => ({
					id: model.id,
					contextWindow: model.contextWindow ?? 0,
					maxTokens: model.maxTokens ?? 0,
					input: [...model.input],
					reasoning: model.reasoning,
					requiresReasoning: model.reasoning && model.thinkingLevelMap?.off === null,
					baseUrl: model.baseUrl,
					api: model.api,
					thinkingLevels: getSupportedThinkingLevels(model).filter((level) => level !== 'off'),
				})),
				baseUrl: providerBaseUrl(provider),
				protocol: providerProtocol(provider),
				protocols: API_PROTOCOLS,
				...(provider.auth.oauth ? { oauth: { subscription: provider.auth.oauth.isSubscription ?? false } } : {}),
			}));
		},
		login: (providerId, interaction, options) => models.login(providerId, 'oauth', interaction, options),
		listProviderModels: async (providerId, signal, sharedPublicCatalog, sharedPiCatalog) => {
			signal?.throwIfAborted();
			syncCustomProviders();
			const provider = models.getProvider(providerId);
			if (!provider) throw new Error('Unknown model provider');
			if (registered.has(providerId)) {
				const { models, details } = await readCustomModelCatalog(providerId, providerBaseUrl(provider), signal);
				return { models, details, source: 'provider' };
			}
			const bundled = piCatalogDetails(provider.getModels());
			const [catalog, publicCatalog] = await Promise.all([
				discoverProviderModels(provider, signal, sharedPiCatalog),
				(sharedPublicCatalog ?? fetchModelsDevCatalog(transport.fetch, catalogSignal(signal))).catch(() => undefined),
			]);
			signal?.throwIfAborted();
			const checkedAt = new Date().toISOString();
			const baseUrl = providerBaseUrl(provider);
			const protocol = providerProtocol(provider);
			const configured = serviceOptions.protocols?.()[providerId];
			if (configured && configured !== protocol) return { ...catalog, details: undefined };
			const publicDetails = modelsDevDetails(providerId, publicCatalog, { baseUrl, protocol, models: provider.getModels() }, checkedAt);
			const details = mergeModelCatalogDetails(sourceModelCatalogDetails(bundled, 'bundled'),
				sourceModelCatalogDetails(catalog.details, catalog.source, checkedAt),
				publicDetails, documentedModelDetails(providerId));
			return { ...catalog, details };
		},
		listCustomModels: readCustomModelCatalog,
		modelCapabilities: (providerId, id) => {
			const route = requestModel(providerId, id);
			if (!route.model) return { structuredOutput: false, imageInput: false };
			const { structuredOutput, tools, videoInput } = modelFeatures(providerId, id, route);
			const format = videoInput ? nativeVideoFormat(route.connection, id) : undefined;
			return { structuredOutput, tools, imageInput: route.model.input.includes('image'),
				...(format && { videoAnalysis: videoTakesOnlyUrls(format) ? 'link' as const : 'file' as const }) };
		},
		stream,
		send: (request, onUsage) => stream(request, onUsage).result(),
	};

}
