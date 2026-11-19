import type { Message, ReportedUsage, RunState } from '../types';

function nonNegative(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function completedMessages(messages: readonly Message[]) {
	return messages.filter((message) => message.role === 'assistant' && !message.incomplete);
}

export function messageUsage(message: Message) {
	const usage = message.usage ?? message.rawAssistant?.usage;
	const billed = usage?.cost;
	const cost = billed?.totalFromProvider === true && nonNegative(billed.total) ? billed.total : undefined;
	let reported = message.reportedUsage;
	if (!reported && usage) {
		// 旧记录没有字段来源，无法将适配器补入的零与服务商报告的零区分开。
		const positive = (n: number) => Number.isSafeInteger(n) && n > 0 ? n : undefined;
		const input = positive(usage.input);
		const cacheRead = positive(usage.cacheRead);
		const cacheWrite = positive(usage.cacheWrite);
		reported = { input, cacheRead, cacheWrite, output: positive(usage.output),
			prompt: input === undefined ? undefined : input + (cacheRead ?? 0) + (cacheWrite ?? 0) };
	}
	if (cost === undefined && !Object.values(reported ?? {}).some(nonNegative)) return;
	return { ...reported, cost };
}

function sum(values: (number | undefined)[]): number | undefined {
	const measured = values.filter(nonNegative);
	return measured.length ? measured.reduce((total, value) => total + value, 0) : undefined;
}

export function usageTotals(messages: readonly Message[]) {
	const entries = messages.map(messageUsage);
	if (!entries.some(Boolean)) return;
	const fields = (key: keyof ReportedUsage) => entries.map((entry) => entry?.[key]);
	const prompts = fields('prompt');
	const cacheReads = fields('cacheRead');
	const total = entries.map((entry) => entry?.prompt === undefined || entry.output === undefined ? undefined : entry.prompt + entry.output);
	const prompt = prompts.every(nonNegative) ? sum(prompts) : undefined;
	const read = cacheReads.every(nonNegative) ? sum(cacheReads) : undefined;
	const partialTotal = !total.every(nonNegative);
	return { input: sum(fields('input')), cacheRead: sum(cacheReads), cacheWrite: sum(fields('cacheWrite')),
		output: sum(fields('output')), total: sum(total), hit: prompt && read !== undefined ? read / prompt : undefined,
		cost: sum(entries.map((entry) => entry?.cost)),
		missing: partialTotal || entries.some((entry) => entry?.input === undefined || entry.cacheRead === undefined || entry.cacheWrite === undefined),
		...(partialTotal ? { partialTotal: true } : {}),
	};
}

export function messageTime(message: Message | undefined) {
	if (message?.metrics?.endedAt) return message.metrics.endedAt;
	const { timestamp, durationMs } = message?.rawAssistant ?? {};
	return timestamp && nonNegative(durationMs) ? timestamp + durationMs : undefined;
}

export function conversationMetrics(runs: readonly RunState[]) {
	const all = runs.flatMap(({ messages }) => messages);
	const messages = completedMessages(all);
	const usage = usageTotals(messages);
	const lags = messages.flatMap(({ metrics }) => nonNegative(metrics?.firstDeltaMs) ? [metrics.firstDeltaMs] : []);
	const decode = messages.map(({ metrics }) => metrics?.decodeMs);
	const decodeMs = decode.every(nonNegative) ? sum(decode) : undefined;
	const output = messages.map((message) => messageUsage(message)?.output);
	const outputTokens = output.every(nonNegative) ? sum(output) : undefined;
	const latest = messages.at(-1);
	const prompt = latest && messageUsage(latest)?.prompt;
	const capacity = latest?.metrics?.contextWindow;
	return {
		rounds: runs.length,
		count: messages.length,
		modelMs: sum(messages.map(({ metrics, rawAssistant }) => metrics?.modelMs ?? rawAssistant?.durationMs)),
		toolMs: sum(all.map(({ toolDurationMs }) => toolDurationMs)),
		lagMs: lags.length ? lags.reduce((total, value) => total + value, 0) / lags.length : undefined,
		speed: outputTokens !== undefined && decodeMs && decodeMs > 0 ? outputTokens * 1000 / decodeMs : undefined,
		usage,
		context: prompt !== undefined && capacity && capacity > 0
			? { prompt, capacity, remaining: Math.max(0, capacity - prompt), percent: Math.ceil(prompt * 100 / capacity) } : undefined,
	};
}

export function abbreviatedNumber(value: number): string {
	if (value < 1_000) return value.toLocaleString();
	const million = value >= 999_950;
	return (value / (million ? 1_000_000 : 1_000)).toLocaleString(undefined, { maximumFractionDigits: 1 }) + (million ? 'M' : 'k');
}
