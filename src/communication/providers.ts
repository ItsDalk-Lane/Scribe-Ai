import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type {
	AnyModel,
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
import { fetchArkPublicModelCatalog } from './arkModelCatalog';
import { checkMiniMaxPlanKey, EXTRA_IMAGE_LIMITS, EXTRA_PROVIDERS, MINIMAX_M_PLAN_ORIGINS, miniMaxPlanBaseUrl } from './extraProviders';
import { documentedModelDetails, documentedRouteDetails, fetchModelList, fetchModelsDevCatalog, fetchPiModelCatalog,
	mergeModelCatalogDetails, ModelCatalogHttpError, readModelsDevCatalog, sourceModelCatalogDetails } from './modelCatalog';
import { ACCOUNT_CATALOGS, fetchAccountModelCatalog } from './modelCatalogAccounts';
import { fetchOfficialModelCatalog } from './modelCatalogProviders';
import { openCodeConnection } from './openCodeModels';
import { resolveModelConnection } from './modelConnection';
import { applyResponseSchema, supportsResponseSchema } from './modelFeatures';
import { bufferedGroqSchemaFetch, needsBufferedGroqSchema } from './groqSchema';
import { applyModelPdf, redactPdfError, supportsPdfInput } from './modelPdf';
import { applyModelVideo, catalogVideoInput, nativeVideoFormat, videoTakesOnlyUrls } from './modelVideo';
import { bindBedrockConfirmation, confirmModelRequest } from './modelRequestConfirmation';
import type { ModelRequestConfirmation } from './modelRequestConfirmation';
import { modelNodeFetch, nodeFetch } from './nodeFetch';
import { isSecureServiceUrl } from './serviceAddress';
import { captureReportedUsage, reportedCost } from './reportedUsage';
import { estimatePromptTokens } from './inputUsage';
import { ContextOverflowError, RetryableModelError } from '../types';
import { knownMediaModelType, confirmedCatalogModelType } from '../orchestration/settings/mediaSettings';
import { isTextModel } from '../orchestration/settings/modelAvailability';
import { isBuiltInThinkingLevel, isThinkingLevel } from '../orchestration/settings/thinking';
import type {
	ConfiguredModelType,
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

import { promptText } from '../orchestration/context/promptXml';

function toPiMessage(message: Message, images?: ImageContent[]): PiMessage {
	const timestamp = Date.now();
	const text = promptText(message);
	if (message.role === 'system') return { role: 'system', content: text, timestamp };
	if (message.role === 'user') return { role: 'user', content: images?.length
		? [...(text ? [{ type: 'text' as const, text: text }] : []), ...images] : text, timestamp };
	if (message.role === 'tool') {
		if (!message.toolCallId) throw new Error('Tool messages require toolCallId');
		return {
			role: 'toolResult',
			toolCallId: message.toolCallId,
			toolName: message.toolName ?? message.toolCallId,
			content: [{ type: 'text', text: message.imageRefs?.length && !images?.length
				? text + '\n（此模型请求未携带这项工具返回的图片。）' : text }, ...(images ?? [])],
			isError: message.isError ?? false,
			timestamp,
		};
	}
	const raw = message.rawAssistant;
	if (raw) return { ...raw, content: raw.content.map((block) => {
		if (block.type === 'text' && !block.textSignature) return { ...block, text: promptText({ role: 'assistant', content: block.text }) };
		if (block.type !== 'thinking' || block.durationMs === undefined) return block;
		const content = { ...block };
		delete content.durationMs;
		return content;
	}) };
	return {
		role: 'assistant',
		content: [
			...(text ? [{ type: 'text' as const, text: text }] : []),
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

function toResponse(message: AssistantMessage, reportedUsage: ReportedUsage, pdfInput: boolean): ModelResponse {
	const error = pdfInput ? redactPdfError(message.errorMessage) : message.errorMessage;
	if (isContextOverflow(message)) throw new ContextOverflowError(error);
	if (isRetryableAssistantError(message)) throw new RetryableModelError(error);
	if (message.stopReason === 'error' || message.stopReason === 'aborted') {
		throw new Error(error || `Model request ${message.stopReason}`);
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
		private usage: ReturnType<typeof captureReportedUsage>,
		private confirmation: ModelRequestConfirmation | undefined,
		private structuredOutput: boolean,
		private pdfInput: boolean,
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
			const reportedUsage = this.usage.read();
			const estimatedUsage = this.usage.estimate();
			const usageStatus = Object.keys(reportedUsage).length || estimatedUsage ? this.usage.status()
				: response.stopReason === 'error' || response.stopReason === 'aborted' ? 'provisional' : 'final';
			this.onUsage?.({ reportedUsage, ...(estimatedUsage && { estimatedUsage }), cost: reportedCost(response.usage), usageStatus });
			const result = toResponse(response, reportedUsage, this.pdfInput);
			if (estimatedUsage) result.estimatedUsage = estimatedUsage;
			if (usageStatus === 'provisional') result.usageStatus = usageStatus;
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

function specializedCatalogModels(catalog: ModelCatalogResult): string[] {
	return [...catalog.details ?? []].flatMap(([id, { type }]) => type && type !== 'text' ? [id] : []);
}

function catalogSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(15_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeModelAddress(address?: string): string {
	return (URL.parse(address ?? '')?.href ?? address ?? '').replace(/\/+$/u, '');
}

function piNonChatType(model: AnyModel): 'image' | 'other' | undefined {
	return model.type === 'image' ? 'image' : model.type === 'classifier' ? 'other' : undefined;
}

function piNonChatTypes(provider: Provider): Map<string, ConfiguredModelType> {
	const types = new Map<string, ConfiguredModelType>();
	const chat = new Set(provider.getModels().map(({ id }) => id));
	for (const model of provider.getAllModels?.() ?? []) {
		const type = piNonChatType(model);
		if (type && !chat.has(model.id)) types.set(model.id, type);
	}
	return types;
}

function piCatalogDetails(provider: Provider): Map<string, ModelCatalogDetails> {
	const details = new Map<string, ModelCatalogDetails>(provider.getModels().map((model) => [model.id, {
		type: 'text',
		...(model.contextWindow > 0 && { contextWindow: model.contextWindow }),
		...(model.maxTokens > 0 && { maxTokens: model.maxTokens }),
		inputModalities: model.input,
		outputModalities: ['text'],
		reasoning: model.reasoning,
		thinkingLevels: getSupportedThinkingLevels(model).filter((level) => level !== 'off'),
	}]));
	for (const [id, type] of piNonChatTypes(provider)) details.set(id, { type });
	return details;
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
): ModelService & { refreshRadiusMediaLogin: (signal: AbortSignal) => Promise<void> } {
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
					resolve: async ({ credential }) => {
						if (credential?.type !== 'api_key' || !credential.key) return;
						checkMiniMaxPlanKey(def.id, credential.key);
						return { auth: { apiKey: credential.key } };
					},
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
		const hasConnectionOverride = Boolean(override?.protocol || override?.baseUrl);
		const catalogConnection = hasConnectionOverride ? resolve(providerId, id, false).connection : connection;
		let details: ModelCatalogDetails | undefined;
		if (provider && catalogConnection.api === connection.api && normalizeModelAddress(catalogConnection.baseUrl) === normalizeModelAddress(connection.baseUrl)) {
			const configuredAddress = serviceOptions.baseUrls?.()[providerId] || (registered.has(providerId) ? provider.baseUrl : undefined);
			const configuredProtocol = serviceOptions.protocols?.()[providerId];
			const catalogAddress = (registered.has(providerId) || (configuredAddress && normalizeModelAddress(configuredAddress) !== normalizeModelAddress(providerBaseUrl(provider))))
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

	const modelType: NonNullable<ModelService['modelType']> = (providerId, id) => {
		const mediaType = knownMediaModelType(providerId, id);
		if (mediaType) return mediaType;
		if (providerId === 'typesafe' && !registered.has(providerId)) {
			const address = normalizeModelAddress(serviceOptions.modelOverrides?.()[providerId]?.[id]?.baseUrl
				|| serviceOptions.baseUrls?.()[providerId]);
			if (!address || address === 'https://api.typesafe.ai/v1') return 'other';
		}
		const route = resolve(providerId, id);
		const { provider, exact, connection, override } = route;
		const details = connectionCatalogDetails(providerId, id, route);
		const catalogType = confirmedCatalogModelType(details);
		if (catalogType || details?.evidence?.type?.conflict) return catalogType;
		if (!provider || registered.has(providerId)) return undefined;
		if (exact) return !connection.issue && exact.api === connection.api
			&& normalizeModelAddress(exact.baseUrl) === normalizeModelAddress(connection.baseUrl) ? 'text' : undefined;
		const known = provider.getAllModels?.().find((entry) => entry.id === id && piNonChatType(entry));
		if (!known) return undefined;
		const endpoint = normalizeModelAddress(known.baseUrl);
		const address = normalizeModelAddress(override?.baseUrl?.trim() || serviceOptions.baseUrls?.()[providerId]);
		const protocol = override?.protocol?.trim() || serviceOptions.protocols?.()[providerId];
		const matchingProtocol = !protocol || protocol === known.api
			|| provider.getModels().some((entry) => entry.api === protocol && normalizeModelAddress(entry.baseUrl) === endpoint);
		if ((!address || address === endpoint) && matchingProtocol) return piNonChatType(known);
		return undefined;
	};

	function modelFeatures(providerId: string, id: string, route: ReturnType<typeof requestModel>) {
		const { connection, override } = route;
		const details = connectionCatalogDetails(providerId, id, route);
		const structuredOutput = (override?.capabilities?.structuredOutput
			?? (details?.evidence?.structuredOutput?.conflict ? undefined : details?.structuredOutput)) === true
			&& supportsResponseSchema(connection.api, connection.baseUrl, id);
		const videoInput = override?.input?.includes('video') ?? catalogVideoInput(details);
		const pdfFormat = supportsPdfInput(connection, id, route.model?.input.includes('image') ?? false, details, override?.input);
		const tools = override?.capabilities?.tools ?? details?.tools ?? true;
		return { structuredOutput, videoInput, pdfFormat, tools };
	}

	const stream = (request: ModelRequest, onUsage?: Parameters<ModelService['send']>[1]): ModelStream => {
		const checkModelType = () => {
			if (!isTextModel({ modelOverrides: serviceOptions.modelOverrides?.() ?? {} }, request, modelType)) {
				throw new Error('所选模型无法处理文字对话，请重新选择。');
			}
		};
		checkModelType();
		const { provider, connection, override, model: selectedModel } = requestModel(request.providerId, request.model);
		if (!provider || !selectedModel) throw new Error(CONNECTION_ERRORS[connection.issue ?? 'unknown-provider']);
		const features = modelFeatures(request.providerId, request.model, { provider, connection, override, model: selectedModel });
		const vision = selectedModel.input.includes('image');
		if (request.images?.required && !vision) throw new Error('当前模型连接未启用图片输入，请选择支持图片的模型。');
		const schema = request.responseSchema;
		if (schema && !features.structuredOutput) throw new Error('当前模型连接未启用结构化输出。');
		const video = request.video;
		const videoFormat = video && features.videoInput ? nativeVideoFormat(connection, selectedModel.id) : undefined;
		const videoMarker = video ? `[scribe-video-${randomUUID()}]\n` : undefined;
		if (video && !videoFormat) throw new Error('当前模型连接无法发送视频，请选择已接通视频输入的模型。');
		if (video?.hasFiles && videoTakesOnlyUrls(videoFormat)) throw new Error('当前模型接口接受 HTTPS 视频链接，请以 Markdown 视频嵌入链接提交。');
		const pdf = request.pdf;
		const pdfMarker = pdf ? `[scribe-pdf-${randomUUID()}]\n` : undefined;
		if (pdf && !features.pdfFormat) throw new Error('当前模型连接无法发送 PDF，请选择已接通 PDF 输入的模型。');
		if (pdf && (video || request.images || request.tools.length)) throw new Error('PDF 只能由独立解析请求发送。');
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
		if (schema || video || pdf) {
			const validateThinking = onPayload;
			onPayload = async (payload, activeModel) => {
				await validateThinking?.(payload, activeModel);
				const fields = schema ? applyResponseSchema(payload, model.api, schema, model.baseUrl) : payload;
				if (pdf && features.pdfFormat && pdfMarker) {
					return applyModelPdf(fields, features.pdfFormat, pdfMarker, await pdf.load(controller.signal));
				}
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
		const expectedBase = (pdf || configuredAddress) && connection.baseUrl ? new URL(connection.baseUrl) : undefined;
		const reportedUsage = captureReportedUsage(model.api);
		let promptEstimate: number | undefined;
		const publishUsage = () => {
			const estimatedUsage = reportedUsage.estimate();
			onUsage?.({ reportedUsage: reportedUsage.read(), ...(estimatedUsage && { estimatedUsage }), usageStatus: reportedUsage.status() });
		};
		const confirmation = { beforeSend: request.beforeSend, expectedBase, controller, onSend: async (address: string) => {
			checkModelType();
			await request.onTransmission?.(address);
			controller.signal.throwIfAborted();
			checkModelType();
			reportedUsage.reset(promptEstimate);
			if (promptEstimate !== undefined) publishUsage();
		} };
		const confirmedFetch: typeof fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input);
			// Anthropic 的凭据交换也用同一个 fetch，聊天请求固定走 messages。
			if (model.api === 'anthropic-messages' && url.pathname.endsWith('/v1/oauth/token') && isSecureServiceUrl(url)) {
				return transport.fetch(input, init);
			}
			if (transport.fetch === nodeFetch) return modelNodeFetch(input, init, confirmation);
			await confirmModelRequest(url, confirmation);
			controller.signal.throwIfAborted();
			return transport.fetch(input, init);
		};
		const fetchModel = confirmedFetch;
		const options: SimpleStreamOptions = {
			signal: controller.signal,
			maxTokens: override?.maxTokens && request.maxTokens !== undefined
				? Math.min(request.maxTokens, override.maxTokens)
				: request.maxTokens,
			temperature: request.temperature,
			reasoning,
			onPayload: onUsage ? async (payload, activeModel) => {
				const outgoing = await onPayload?.(payload, activeModel);
				promptEstimate = estimatePromptTokens(activeModel.api, outgoing ?? payload);
				return outgoing;
			} : onPayload,
			sessionId: request.sessionId,
			maxRetries: request.maxRetries ?? 2,
			maxRetryDelayMs: 60_000,
			// shortcut: SDK total timeout is capped at 24.8 days; remove when SDK supports disabling it.
			timeoutMs: 2_147_483_647,
			transport: 'sse',
			onProviderStreamEvent: (event) => {
				if (reportedUsage.observe(event)) publishUsage();
			},
			fetch: schema && needsBufferedGroqSchema(connection) ? bufferedGroqSchemaFetch(fetchModel) : fetchModel,
		};
		try {
			const marker = pdfMarker ?? videoMarker;
			const messageIndex = pdf?.messageIndex ?? video?.messageIndex;
			const input = marker ? {
				...request,
				messages: request.messages.map((message, index) => index === messageIndex
					? { ...message, content: marker + message.content } : message),
			} : request;
			const start = (images?: Map<number, ImageContent[]>) => {
				controller.signal.throwIfAborted();
				const context = toContext(input, features.tools, images);
				if (model.api === 'bedrock-converse-stream') bindBedrockConfirmation(confirmation);
				return models.streamSimple(model, context, options);
			};
			const source = vision && request.images ? request.images.load(controller.signal).then(start) : start();
			return new PiModelStream(source, controller, cleanup, reportedUsage, confirmation, Boolean(schema), Boolean(pdf), onUsage);
		} catch (error) {
			cleanup();
			throw error;
		}
	};

	async function discoverOfficialModels(provider: Provider, baseUrl: string, signal?: AbortSignal): Promise<ModelCatalogResult | undefined> {
		const providerId = provider.id;
		const bundled = provider.getModels();
		const nonChat = new Set(provider.getAllModels?.().filter((model) => model.type && model.type !== 'chat').map((model) => model.id));
		for (const model of bundled) nonChat.delete(model.id);
		try {
			const requestSignal = catalogSignal(signal);
			if (ACCOUNT_CATALOGS.has(providerId)) {
				const credential = await credentials.read(providerId, { signal: requestSignal });
				const resolved = credential ? await models.getAuth(providerId, { signal: requestSignal }) : undefined;
				const catalog = await fetchAccountModelCatalog(providerId, baseUrl, credential, resolved, transport.fetch, requestSignal, nonChat,
					providerId === 'amazon-bedrock' ? new Set(bundled.map(({ id }) => id)) : undefined);
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
			const catalog = await fetchArkPublicModelCatalog(providerId, transport.fetch, catalogSignal(signal));
			signal?.throwIfAborted();
			if (catalog) return catalog;
		} catch {
			signal?.throwIfAborted();
		}
		return undefined;
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
			return { models: catalog.models, specializedModels: specializedCatalogModels(catalog), partial: catalog.partial,
				details: mergeModelCatalogDetails(catalog.details, confirmed), baseUrl: endpoint };
		};
		if (['azure', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'amazon-bedrock', 'bailian-payg'].includes(providerId)) {
			const catalog = await fetchAccountModelCatalog(providerId, endpoint, credential, undefined, transport.fetch, requestSignal);
			if (catalog) return finish(catalog);
		}
		const protocol = configuredProtocol
			|| serviceOptions.customProviders?.().find(({ id }) => id === providerId)?.protocol
			|| (providerId === 'anthropic' || /^minimax(?:-cn)?$/u.test(providerId) || MINIMAX_M_PLAN_ORIGINS.has(providerId) ? 'anthropic-messages' : '')
			|| (providerId === 'google' ? 'google-generative-ai' : '');
		if (credential?.type === 'api_key' && credential.key) {
			checkMiniMaxPlanKey(providerId, credential.key);
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
		modelType,
		modelOrigin: ({ providerId, model: id }) => {
			const { connection } = resolve(providerId, id);
			return connection.issue ? undefined : URL.parse(connection.baseUrl)?.origin;
		},
		thinkingOptions,
		providers: (): ModelProviderInfo[] => {
			syncCustomProviders();
			return models.getProviders().map((provider) => {
				const nonChatModelTypes = registered.has(provider.id) ? undefined : piNonChatTypes(provider);
				return {
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
					...(nonChatModelTypes?.size && { nonChatModelTypes }),
					...(provider.auth.oauth ? { oauth: { subscription: provider.auth.oauth.isSubscription ?? false } } : {}),
				};
			});
		},
		login: (providerId, interaction, options) => models.login(providerId, 'oauth', interaction, options),
		refreshRadiusMediaLogin: async (signal) => {
			if ((await credentials.read('radius', { signal }))?.type === 'oauth') {
				await models.getAuth('radius', { signal, minOAuthValidityMs: 0 });
			}
		},
		listProviderModels: async (providerId, signal) => {
			signal?.throwIfAborted();
			syncCustomProviders();
			const provider = models.getProvider(providerId);
			if (!provider) throw new Error('Unknown model provider');
			if (registered.has(providerId)) {
				const catalog = await readCustomModelCatalog(providerId, providerBaseUrl(provider), signal);
				return { ...catalog, source: 'provider' };
			}
			const bundled = piCatalogDetails(provider);
			const configured = serviceOptions.protocols?.()[providerId];
			const planAddress = configured && miniMaxPlanBaseUrl(providerId, configured);
			const baseUrl = planAddress || providerBaseUrl(provider);
			const protocol = planAddress ? configured : providerProtocol(provider);
			const known = provider.getAllModels?.() ?? provider.getModels();
			const connection = { baseUrl, protocol, models: planAddress ? known.map((model) => ({ ...model, api: protocol, baseUrl })) : known };
			const [official, pi, publicCatalog] = await Promise.all([
				discoverOfficialModels(provider, baseUrl, signal),
				fetchPiModelCatalog(providerId, transport.fetch, catalogSignal(signal), connection).catch(() => undefined),
				fetchModelsDevCatalog(transport.fetch, catalogSignal(signal)).catch(() => undefined),
			]);
			signal?.throwIfAborted();
			const checkedAt = new Date().toISOString();
			if (configured && configured !== protocol) return { models: official?.models ?? [], source: official?.source ?? 'bundled' };
			const publicModels = readModelsDevCatalog(providerId, publicCatalog, connection, checkedAt);
			const officialDetails = planAddress && official?.details
				? new Map([...official.details].map(([id, details]) => [id, { ...details, connectionProtocol: protocol }])) : official?.details;
			const details = mergeModelCatalogDetails(
				sourceModelCatalogDetails(bundled, 'bundled'),
				sourceModelCatalogDetails(pi?.details, 'pi', checkedAt),
				publicModels.details,
				official && sourceModelCatalogDetails(officialDetails, official.source, checkedAt),
				documentedModelDetails(providerId),
			);
			const publicCandidates = [pi, publicModels].filter((catalog): catalog is ModelCatalogResult =>
				Boolean(catalog && (catalog.models.length || (catalog.specializedModels ?? specializedCatalogModels(catalog)).length)));
			const catalogs = official ? [official] : publicCandidates;
			const source = catalogs[0]?.source ?? 'bundled';
			const candidates = source === 'bundled' ? provider.getModels().map(({ id }) => id) : catalogs.flatMap(({ models }) => models);
			const specialized = new Set(catalogs.flatMap((catalog) => catalog.specializedModels ?? specializedCatalogModels(catalog)));
			const modelIds = [...new Set(candidates)].filter((id) => {
				const type = confirmedCatalogModelType(details.get(id));
				if (!type || type === 'text') return true;
				specialized.add(id);
				return false;
			});
			return { models: modelIds, source, specializedModels: source === 'bundled' ? undefined : [...specialized], details, partial: official?.partial };
		},
		listCustomModels: readCustomModelCatalog,
		modelCapabilities: (providerId, id) => {
			const route = requestModel(providerId, id);
			if (!route.model) return { structuredOutput: false, imageInput: false };
			const { structuredOutput, tools, videoInput, pdfFormat } = modelFeatures(providerId, id, route);
			const format = videoInput ? nativeVideoFormat(route.connection, id) : undefined;
			return { structuredOutput, tools, imageInput: route.model.input.includes('image'),
				...(format && { videoAnalysis: videoTakesOnlyUrls(format) ? 'link' as const : 'file' as const }),
				...(pdfFormat && { pdfAnalysis: true }) };
		},
		stream,
		send: (request, onUsage) => stream(request, onUsage).result(),
	};

}
