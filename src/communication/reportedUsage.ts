import type { Api, Usage } from '@earendil-works/pi-ai';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { ModelUsageReceipt, ReportedUsage } from '../types';
import { receivedOutput } from './streamOutput';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function reportedCost(usage?: Usage): number | undefined {
	const cost = usage?.cost;
	return cost?.totalFromProvider === true && Number.isFinite(cost.total) && cost.total >= 0 ? cost.total : undefined;
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
				prompt: count(usage.prompt_tokens), input: count(usage.prompt_cache_miss_tokens), videoInput: count(detail.video_tokens),
				cacheRead: count(detail.cached_tokens ?? detail.cachedTokens ?? usage.prompt_cache_hit_tokens
					?? usage.cached_tokens ?? usage.num_cached_tokens ?? usage.numCachedTokens),
				cacheWrite: count(detail.cache_write_tokens), output: count(usage.completion_tokens), total: count(usage.total_tokens),
			};
		}
		case 'openai-responses':
		case 'openai-codex-responses':
		case 'azure-openai-responses': {
			const usage = record(record(event.response).usage);
			const detail = record(usage.input_tokens_details);
			return { prompt: count(usage.input_tokens), cacheRead: count(detail.cached_tokens), videoInput: count(detail.video_tokens),
				cacheWrite: count(detail.cache_write_tokens), output: count(usage.output_tokens), total: count(usage.total_tokens) };
		}
		case 'anthropic-messages': {
			const usage = record(event.usage ?? record(event.message).usage);
			return { input: count(usage.input_tokens), cacheRead: count(usage.cache_read_input_tokens),
				cacheWrite: count(usage.cache_creation_input_tokens), output: count(usage.output_tokens) };
		}
		case 'bedrock-converse-stream': {
			const usage = record(record(event.metadata).usage);
			return { input: count(usage.inputTokens), cacheRead: count(usage.cacheReadInputTokens),
				cacheWrite: count(usage.cacheWriteInputTokens), output: count(usage.outputTokens), total: count(usage.totalTokens) };
		}
		case 'google-generative-ai':
		case 'google-vertex': {
			const usage = record(event.usageMetadata);
			const candidates = count(usage.candidatesTokenCount);
			const thoughts = count(usage.thoughtsTokenCount);
			const videoInput = Array.isArray(usage.promptTokensDetails) ? usage.promptTokensDetails.map(record)
				.find((entry) => entry.modality === 'VIDEO' && (count(entry.tokenCount) ?? 0) > 0) : undefined;
			return { prompt: count(usage.promptTokenCount), cacheRead: count(usage.cachedContentTokenCount),
				videoInput: count(videoInput?.tokenCount),
				output: candidates === undefined ? undefined : candidates + (thoughts ?? 0), total: count(usage.totalTokenCount) };
		}
		case 'pi-messages': {
			const usage = record(event.usage);
			return { input: count(usage.input), cacheRead: count(usage.cacheRead),
				cacheWrite: count(usage.cacheWrite), output: count(usage.output), total: count(usage.totalTokens) };
		}
		default: return {};
	}
}

function endsGeneration(api: Api, event: Record<string, unknown>): boolean {
	switch (api) {
		case 'openai-completions':
		case 'mistral-conversations':
			return Array.isArray(event.choices) && Boolean(record(event.choices[0]).finish_reason);
		case 'openai-responses':
		case 'openai-codex-responses':
		case 'azure-openai-responses':
			return event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.done';
		case 'anthropic-messages':
			return event.type === 'message_stop' || (event.type === 'message_delta' && Boolean(record(event.delta).stop_reason));
		case 'bedrock-converse-stream':
			return Boolean(event.messageStop || event.metadata);
		case 'google-generative-ai':
		case 'google-vertex':
			return Array.isArray(event.candidates) && Boolean(record(event.candidates[0]).finishReason);
		case 'pi-messages':
			return event.type === 'done';
		default: return false;
	}
}

export function captureReportedUsage(api: Api) {
	let values: ReportedUsage = {};
	let promptEstimate: number | undefined;
	let ended = false;
	let closingReceipt = false;
	const tails = { output: '', total: '' };
	const confirmed = new Set<'output' | 'total'>();
	const status = () => closingReceipt && !tails.output && (['output', 'total'] as const).every((key) =>
		values[key] === undefined || confirmed.has(key)) ? 'final' as const : 'provisional' as const;

	function read(this: void): ReportedUsage {
		const { input, prompt, cacheRead, cacheWrite } = values;
		if (cacheRead === undefined || cacheWrite === undefined) return { ...values };
		if (prompt === undefined && input !== undefined) return { ...values, prompt: input + cacheRead + cacheWrite };
		if (input === undefined && prompt !== undefined && prompt >= cacheRead + cacheWrite) {
			return { ...values, input: prompt - cacheRead - cacheWrite };
		}
		return { ...values };
	}

	function estimate(this: void): ModelUsageReceipt['estimatedUsage'] {
		const { prompt, input, output: reportedOutput, total: reportedTotal } = read();
		const estimatedPrompt = prompt === undefined && input === undefined ? promptEstimate : undefined;
		const output = !confirmed.has('output') && tails.output
			? count((reportedOutput ?? 0) + estimateTextTokens(tails.output)) : undefined;
		let total: number | undefined;
		if (reportedTotal !== undefined && !confirmed.has('total')) {
			const currentOutput = output ?? reportedOutput;
			if (prompt !== undefined && currentOutput !== undefined) {
				const combined = prompt + currentOutput;
				if (combined !== reportedTotal) total = count(combined);
			} else if (tails.total) total = count(reportedTotal + estimateTextTokens(tails.total));
		} else if (reportedTotal === undefined && promptEstimate !== undefined && reportedOutput === undefined && output === undefined) {
			total = prompt ?? estimatedPrompt;
		}
		return estimatedPrompt !== undefined || output !== undefined || total !== undefined ? {
			...(estimatedPrompt !== undefined && { prompt: estimatedPrompt }),
			...(output !== undefined && { output }), ...(total !== undefined && { total }),
		} : undefined;
	}

	return {
		status, read, estimate,
		reset(this: void, prompt?: number) {
			values = {};
			promptEstimate = prompt;
			ended = closingReceipt = false;
			tails.output = tails.total = '';
			confirmed.clear();
		},
		observe(this: void, event: unknown) {
			const frame = record(event);
			const before = status();
			const beforeEstimate = estimate();
			const text = receivedOutput(api, frame);
			if (!confirmed.has('output')) tails.output += text;
			if (values.total !== undefined && !confirmed.has('total')) tails.total += text;
			ended ||= endsGeneration(api, frame);
			const update = counters(api, frame);
			let changed = false;
			for (const key of ['prompt', 'input', 'cacheRead', 'cacheWrite', 'output', 'total', 'videoInput'] as const) {
				if (update[key] === undefined) continue;
				if (ended) closingReceipt = true;
				if (key === 'output' || key === 'total') {
					if (ended) confirmed.add(key);
					// 同一帧的累计数字已覆盖该帧内容。重复的阶段值不能覆盖后来收到的文字。
					if (ended || update[key] > (values[key] ?? 0)) tails[key] = '';
				}
				if (update[key] !== values[key]) {
					values[key] = update[key];
					changed = true;
				}
			}
			const afterEstimate = estimate();
			return changed || before !== status() || beforeEstimate?.output !== afterEstimate?.output || beforeEstimate?.total !== afterEstimate?.total;
		},
	};
}
