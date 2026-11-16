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
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { nodeRequire } from './nodeRequire';
import type {
	CredentialStore,
	Message,
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

function toContext(request: ModelRequest): Context {
	return {
		systemPrompt: request.system,
		messages: request.messages.map(toPiMessage),
		tools: request.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		})),
	};
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

/** pi-ai 负责全部内置 Provider 的协议与能力差异，本层只转换插件契约并注入连接条件。 */
export function createModelService(
	credentials: CredentialStore,
	transport: Transport,
	additionalProviders: Provider[] = [],
): ModelService {
	const models: MutableModels = builtinModels({ credentials, authContext: authContext() });
	for (const provider of additionalProviders) models.setProvider(provider);

	const stream = (request: ModelRequest): ModelStream => {
		const model = models.getModel(request.providerId, request.model);
		if (!model) throw new Error(`Unknown model: ${request.providerId}/${request.model}`);
		const controller = new AbortController();
		const onAbort = () => controller.abort(request.signal?.reason);
		if (request.signal?.aborted) onAbort();
		request.signal?.addEventListener('abort', onAbort, { once: true });
		const cleanup = () => request.signal?.removeEventListener('abort', onAbort);
		const options: SimpleStreamOptions = {
			signal: controller.signal,
			maxTokens: request.maxTokens,
			temperature: request.temperature,
			reasoning: request.reasoning,
			sessionId: request.sessionId,
			maxRetries: request.maxRetries ?? 2,
			maxRetryDelayMs: 60_000,
			// shortcut: SDK total timeout is capped at 24.8 days; remove when SDK supports disabling it.
			timeoutMs: 2_147_483_647,
			transport: 'sse',
			...(isGoogleModel(model) ? {} : { fetch: transport.fetch }),
		};
		try {
			return new PiModelStream(models.streamSimple(model, toContext(request), options), controller, cleanup);
		} catch (error) {
			cleanup();
			throw error;
		}
	};

	return {
		providers: (): ModelProviderInfo[] => models.getProviders().map((provider) => ({
			id: provider.id,
			label: provider.name,
			models: provider.getModels().map((model) => model.id),
		})),
		refresh: async (providerId) => {
			const result = await models.refresh({
				allowNetwork: true,
				force: true,
				...(providerId ? { providers: [providerId] } : {}),
			});
			if (result.errors.size) {
				throw new AggregateError([...result.errors.values()], 'Failed to refresh model catalogs');
			}
		},
		stream,
		send: (request) => stream(request).result(),
	};
}
