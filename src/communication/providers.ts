import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Api,
	AuthContext,
	Context,
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
import { clampThinkingLevel, createProvider, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
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
import { nodeRequire } from './nodeRequire';
import type {
	CredentialStore,
	Message,
	CustomProviderDef,
	ModelOverride,
	ModelProviderInfo,
	ModelRequest,
	ModelResponse,
	ModelService,
	ModelStream,
	ModelStreamEvent,
	Transport,
} from '../types';

function toPiMessage(message: Message): PiMessage {
	const timestamp = Date.now();
	if (message.role === 'system') return { role: 'system', content: message.content, timestamp };
	if (message.role === 'user') return { role: 'user', content: message.content, timestamp };
	if (message.role === 'tool') {
		if (!message.toolCallId) throw new Error('Tool messages require toolCallId');
		return {
			role: 'toolResult',
			toolCallId: message.toolCallId,
			toolName: message.toolName ?? message.toolCallId,
			content: [{ type: 'text', text: message.content }],
			isError: message.isError ?? false,
			timestamp,
		};
	}
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

function toContext(request: ModelRequest, toolsEnabled: boolean): Context {
	return {
		systemPrompt: request.system,
		messages: request.messages.map(toPiMessage),
		tools: toolsEnabled ? request.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		})) : [],
	};
}

function resolveReasoning(model: Model<Api>, override: ModelOverride | undefined, requested?: ThinkingLevel): ThinkingLevel | undefined {
	const required = model.thinkingLevelMap?.off === null;
	const enabled = override?.capabilities?.reasoning;
	if (!model.reasoning || (enabled === false && !required)) return undefined;
	const configured = override?.thinkingLevels ?? (override?.thinkingLevel ? [override.thinkingLevel] : undefined);
	if (configured) {
		const supported = getSupportedThinkingLevels(model);
		const allowed = configured.filter((level) => supported.includes(level));
		if (requested && allowed.includes(requested)) return requested;
		if (allowed.length || !required) return allowed[0];
	}
	if (requested || (!required && enabled !== true)) return requested;
	const level = clampThinkingLevel(model, 'low');
	return level === 'off' ? undefined : level;
}

function toResponse(message: AssistantMessage): ModelResponse {
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
		raw: message,
	};
}

class PiModelStream implements ModelStream {
	constructor(
		private source: AssistantMessageEventStream,
		private controller: AbortController,
		private cleanup: () => void,
	) {}

	[Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
		const iterate = async function* (this: PiModelStream) {
			try {
				for await (const event of this.source) yield event;
			} finally {
				this.cleanup();
			}
		};
		return iterate.call(this)[Symbol.asyncIterator]();
	}

	async result(): Promise<ModelResponse> {
		try {
			return toResponse(await this.source.result());
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

function authContext(): AuthContext {
	return {
		env: async (name) => typeof process === 'undefined' ? undefined : process.env[name],
		fileExists: async (path) => {
			const { existsSync } = nodeRequire('node:fs') as typeof import('node:fs');
			const { homedir } = nodeRequire('node:os') as typeof import('node:os');
			const resolved = path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
			return existsSync(resolved);
		},
	};
}

function isGoogleModel(model: Model<Api>): boolean {
	return model.api === 'google-generative-ai' || model.api === 'google-vertex';
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
}

/** pi-ai 负责全部内置 Provider 的协议与能力差异，本层只转换插件契约并注入连接条件。 */
export function createModelService(
	credentials: CredentialStore,
	transport: Transport,
	serviceOptions: ModelServiceOptions = {},
): ModelService {
	registerLazyOAuthFlows();
	const models: MutableModels = builtinModels({ credentials, authContext: authContext() });
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

	// 单协议服务商把适配器钉死在一个实现上，只能换掉整个 Provider 才能真正切协议；
	// 重建时挂上全部 api 实现，服务商级协议换掉所有模型，模型级协议只换那一个模型
	const originals = new Map<string, Provider>();
	const installed = new Map<string, string>();
	const applyProtocol = (providerId: string, protocol: string): void => {
		const key = protocol || '*';
		if ((installed.get(providerId) ?? '') === key) return;
		let base = originals.get(providerId);
		if (!base) {
			base = models.getProviders().find((entry) => entry.id === providerId);
			if (!base) return;
			originals.set(providerId, base);
		}
		models.setProvider(createProvider({
			id: base.id,
			name: base.name,
			baseUrl: base.baseUrl,
			headers: base.headers,
			auth: base.auth,
			models: base.getModels().map<Model<Api>>((model) => ({ ...model, api: protocol || model.api })),
			api: API_MODULES,
		}));
		installed.set(providerId, key);
	};
	const restoreProtocol = (providerId: string): void => {
		if (!installed.has(providerId)) return;
		const base = originals.get(providerId);
		if (base) models.setProvider(base);
		installed.delete(providerId);
	};

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

	const stream = (request: ModelRequest): ModelStream => {
		syncCustomProviders();
		const protocol = serviceOptions.protocols?.()[request.providerId]?.trim() ?? '';
		const override = serviceOptions.modelOverrides?.()[request.providerId]?.[request.model];
		const modelProtocol = override?.protocol?.trim() ?? '';
		for (const value of [protocol, modelProtocol]) {
			if (value && !API_MODULES[value as keyof typeof API_MODULES]) throw new Error(`Unknown API protocol: ${value}`);
		}
		if (protocol) applyProtocol(request.providerId, protocol);
		else if (modelProtocol) applyProtocol(request.providerId, '');
		else restoreProtocol(request.providerId);
		let model = models.getModel(request.providerId, request.model);
		if (!model) {
			// 手填的自定义模型 ID 不在目录里：借该服务商首个模型的元数据，只换 id
			const template = models.getProviders().find((entry) => entry.id === request.providerId)?.getModels()[0];
			if (!template) throw new Error(`Unknown model: ${request.providerId}/${request.model}`);
			model = { ...template, id: request.model, name: request.model };
		}
		// 端点覆盖：请求路径只读 model.baseUrl；模型级优先，其次服务商级，最后目录自带
		const baseUrl = override?.baseUrl?.trim() || serviceOptions.baseUrls?.()[request.providerId]?.trim() || '';
		if (baseUrl && baseUrl !== model.baseUrl) model = { ...model, baseUrl };
		// 协议覆盖：模型级只换当前模型的 api，服务商级见 applyProtocol
		if (modelProtocol && modelProtocol !== model.api) model = { ...model, api: modelProtocol };
		if (override?.contextWindow) model = { ...model, contextWindow: override.contextWindow };
		if (override?.maxTokens) model = { ...model, maxTokens: override.maxTokens };
		// 保留目录里的推理标记，支持的接口才能发送明确的关闭指令。
		if (override?.capabilities?.reasoning === true && !model.reasoning) model = { ...model, reasoning: true };
		const controller = new AbortController();
		const onAbort = () => controller.abort(request.signal?.reason);
		if (request.signal?.aborted) onAbort();
		request.signal?.addEventListener('abort', onAbort, { once: true });
		const cleanup = () => request.signal?.removeEventListener('abort', onAbort);
		const options: SimpleStreamOptions = {
			signal: controller.signal,
			maxTokens: override?.maxTokens && request.maxTokens !== undefined
				? Math.min(request.maxTokens, override.maxTokens)
				: request.maxTokens,
			temperature: request.temperature,
			reasoning: resolveReasoning(model, override, request.reasoning),
			sessionId: request.sessionId,
			maxRetries: request.maxRetries ?? 2,
			maxRetryDelayMs: 60_000,
			// shortcut: SDK total timeout is capped at 24.8 days; remove when SDK supports disabling it.
			timeoutMs: 2_147_483_647,
			transport: 'sse',
			...(isGoogleModel(model) ? {} : { fetch: transport.fetch }),
		};
		try {
			const context = toContext(request, override?.capabilities?.tools !== false);
			return new PiModelStream(models.streamSimple(model, context, options), controller, cleanup);
		} catch (error) {
			cleanup();
			throw error;
		}
	};

	return {
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
		refresh: async (providerId) => {
			syncCustomProviders();
			const result = await models.refresh({
				allowNetwork: true,
				force: true,
				...(providerId ? { providers: [providerId] } : {}),
			});
			if (result.errors.size) {
				throw new AggregateError([...result.errors.values()], 'Failed to refresh model catalogs');
			}
		},
		listCustomModels: async (providerId, baseUrl) => {
			const url = new URL(baseUrl.trim());
			let endpoint = url.href.replace(/\/+$/, '');
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
				throw new Error('Invalid base URL');
			}
			const credential = await credentials.read(providerId);
			const headers: Record<string, string> = { accept: 'application/json' };
			if (credential?.type === 'api_key' && credential.key) headers.authorization = `Bearer ${credential.key}`;
			let response = await transport.fetch(`${endpoint}/models`, { headers });
			// 备用地址确实能返回目录时，聊天也使用同一个前缀。
			if (response.status === 404 && !/\/v\d+[a-z0-9]*$/i.test(endpoint)) {
				await response.body?.cancel();
				endpoint += '/v1';
				response = await transport.fetch(`${endpoint}/models`, { headers });
			}
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			// OpenAI 兼容服务返回 {data:[...]}，Ollama 原生 /api/tags 返回 {models:[...]}
			const payload = await response.json() as {
				data?: Array<{ id?: unknown }>;
				models?: Array<{ id?: unknown; name?: unknown }>;
			};
			const entries = (Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []) as Array<{ id?: unknown; name?: unknown }>;
			const ids = [...new Set(entries
				.map((entry) => (typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : '').trim())
				.filter((id) => id.length > 0))];
			return { models: ids, baseUrl: endpoint };
		},
		stream,
		send: (request) => stream(request).result(),
	};
}
