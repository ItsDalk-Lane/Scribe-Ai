import type { Api } from '@earendil-works/pi-ai';
import type { ReportedUsage } from '../types';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function counters(api: Api, event: Record<string, unknown>): ReportedUsage {
	switch (api) {
		case 'openai-completions':
		case 'mistral-conversations': {
			const firstChoice = Array.isArray(event.choices) ? record(event.choices[0]) : {};
			const usage = record(event.usage ?? firstChoice.usage);
			const detail = record(usage.prompt_tokens_details ?? usage.prompt_token_details
				?? usage.promptTokensDetails ?? usage.promptTokenDetails);
			return {
				prompt: count(usage.prompt_tokens), input: count(usage.prompt_cache_miss_tokens),
				cacheRead: count(detail.cached_tokens ?? detail.cachedTokens ?? usage.prompt_cache_hit_tokens
					?? usage.cached_tokens ?? usage.num_cached_tokens ?? usage.numCachedTokens),
				cacheWrite: count(detail.cache_write_tokens), output: count(usage.completion_tokens),
			};
		}
		case 'openai-responses':
		case 'openai-codex-responses':
		case 'azure-openai-responses': {
			const usage = record(record(event.response).usage);
			const detail = record(usage.input_tokens_details);
			return { prompt: count(usage.input_tokens), cacheRead: count(detail.cached_tokens),
				cacheWrite: count(detail.cache_write_tokens), output: count(usage.output_tokens) };
		}
		case 'anthropic-messages': {
			const usage = record(event.usage ?? record(event.message).usage);
			return { input: count(usage.input_tokens), cacheRead: count(usage.cache_read_input_tokens),
				cacheWrite: count(usage.cache_creation_input_tokens), output: count(usage.output_tokens) };
		}
		case 'bedrock-converse-stream': {
			const usage = record(record(event.metadata).usage);
			return { input: count(usage.inputTokens), cacheRead: count(usage.cacheReadInputTokens),
				cacheWrite: count(usage.cacheWriteInputTokens), output: count(usage.outputTokens) };
		}
		case 'google-generative-ai':
		case 'google-vertex': {
			const usage = record(event.usageMetadata);
			const candidates = count(usage.candidatesTokenCount);
			const thoughts = count(usage.thoughtsTokenCount);
			return { prompt: count(usage.promptTokenCount), cacheRead: count(usage.cachedContentTokenCount),
				output: candidates === undefined ? undefined : candidates + (thoughts ?? 0) };
		}
		case 'pi-messages': {
			const usage = record(event.usage);
			return { input: count(usage.input), cacheRead: count(usage.cacheRead),
				cacheWrite: count(usage.cacheWrite), output: count(usage.output) };
		}
		default: return {};
	}
}

export function captureReportedUsage(api: Api) {
	const values: ReportedUsage = {};
	return {
		observe(this: void, event: unknown) {
			const update = counters(api, record(event));
			for (const key of ['prompt', 'input', 'cacheRead', 'cacheWrite', 'output'] as const) {
				if (update[key] !== undefined) values[key] = update[key];
			}
		},
		read(this: void): ReportedUsage {
			const { input, prompt, cacheRead, cacheWrite } = values;
			// 总量和拆分没有同时返回时，只推导可以由已知字段完整计算的部分。
			if (cacheRead === undefined || cacheWrite === undefined) return { ...values };
			if (prompt === undefined && input !== undefined) return { ...values, prompt: input + cacheRead + cacheWrite };
			if (input === undefined && prompt !== undefined && prompt >= cacheRead + cacheWrite) {
				return { ...values, input: prompt - cacheRead - cacheWrite };
			}
			return { ...values };
		},
	};
}
