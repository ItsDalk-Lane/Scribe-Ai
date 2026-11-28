import type { AuxiliaryUsage, Message, ReportedUsage, RunState } from '../types';
import { reportedCost } from '../communication/reportedUsage';

function nonNegative(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function completedMessages(messages: readonly Message[]) {
	return messages.filter((message) => message.role === 'assistant' && !message.incomplete && !message.local);
}

function normalizeUsage(reported: ReportedUsage | undefined, cost: number | undefined, estimated?: Message['estimatedUsage']) {
	const { cacheRead, cacheWrite } = reported ?? {};
	const output = estimated?.output ?? reported?.output;
	let { input, prompt } = reported ?? {};
	if (cacheRead !== undefined && cacheWrite !== undefined) {
		if (prompt === undefined && input !== undefined) prompt = input + cacheRead + cacheWrite;
		else if (input === undefined && prompt !== undefined && prompt >= cacheRead + cacheWrite) input = prompt - cacheRead - cacheWrite;
	}
	const currentPrompt = prompt ?? estimated?.prompt;
	return {
		input, prompt: currentPrompt, reportedPrompt: prompt, cacheRead, cacheWrite, output, cost,
		total: estimated?.total ?? reported?.total ?? (currentPrompt === undefined || output === undefined ? undefined : currentPrompt + output),
	};
}

function messageUsage(message: Message) {
	const usage = message.usage ?? message.rawAssistant?.usage;
	let reported = message.reportedUsage;
	if (!reported && usage) {
		// 旧记录没有字段来源，无法将适配器补入的零与服务商报告的零区分开。
		const positive = (n: number) => Number.isSafeInteger(n) && n > 0 ? n : undefined;
		const input = positive(usage.input);
		const cacheRead = positive(usage.cacheRead);
		const cacheWrite = positive(usage.cacheWrite);
		reported = { input, cacheRead, cacheWrite, output: positive(usage.output) };
	}
	return { ...normalizeUsage(reported, reportedCost(usage), message.estimatedUsage), provisional: message.usageStatus === 'provisional' };
}

type RequestUsage = ReturnType<typeof messageUsage>;
export type UsageMetric = Exclude<keyof ReturnType<typeof normalizeUsage>, 'reportedPrompt'> | 'hit';

export interface UsageTotals extends Partial<Record<UsageMetric, number>> {
	count: number;
	/** 有请求缺少该字段或仅报告阶段值时，保留已报告的小计及覆盖次数。 */
	partial?: Partial<Record<UsageMetric, { value: number; reported: number; provisional?: number }>>;
}

export interface UsageBreakdown extends UsageTotals {
	byKind: Record<'main' | 'review' | 'summary', UsageTotals | undefined> & { video?: UsageTotals; pdf?: UsageTotals };
}

export interface ContextUsage {
	prompt: number;
	capacity: number;
	remaining: number;
	percent: number;
}

export interface ConversationMetrics {
	rounds: number;
	count: number;
	modelMs: number | undefined;
	toolMs: number | undefined;
	lagMs: number | undefined;
	speed: number | undefined;
	usage: UsageBreakdown | undefined;
	context: ContextUsage | undefined;
	contextCompaction: RunState['contextCompaction'];
}

function sum(values: (number | undefined)[]): number | undefined {
	const measured = values.filter(nonNegative);
	return measured.length ? measured.reduce((total, value) => total + value, 0) : undefined;
}

function usageTotals(entries: RequestUsage[]): UsageTotals | undefined {
	if (!entries.length) return;
	const totals: UsageTotals = { count: entries.length };
	const record = (key: UsageMetric, value: number, reported: number, provisional: number) => {
		if (reported === entries.length && !provisional) totals[key] = value;
		else if (reported) (totals.partial ??= {})[key] = { value, reported, ...(provisional ? { provisional } : {}) };
	};
	for (const key of ['input', 'prompt', 'cacheRead', 'cacheWrite', 'output', 'total', 'cost'] as const) {
		let value = 0, reported = 0, provisional = 0;
		for (const entry of entries) {
			const sample = entry[key];
			if (!nonNegative(sample)) continue;
			value += sample;
			reported++;
			if (entry.provisional) provisional++;
		}
		record(key, value, reported, provisional);
	}
	// 命中率的分子与分母必须来自同一组请求。
	let promptTokens = 0, cachedTokens = 0, paired = 0, provisionalPairs = 0;
	for (const { reportedPrompt: prompt, cacheRead, provisional } of entries) {
		if (!nonNegative(prompt) || !nonNegative(cacheRead) || cacheRead > prompt) continue;
		promptTokens += prompt;
		cachedTokens += cacheRead;
		paired++;
		if (provisional) provisionalPairs++;
	}
	if (promptTokens > 0) record('hit', cachedTokens / promptTokens, paired, provisionalPairs);
	return totals;
}

function usageBreakdown(messages: readonly Message[], auxiliary: readonly AuxiliaryUsage[]): UsageBreakdown | undefined {
	const main = messages.map(messageUsage);
	const review: RequestUsage[] = [];
	const summary: RequestUsage[] = [];
	const video: RequestUsage[] = [];
	const pdf: RequestUsage[] = [];
	const requests = { review, 'goal-review': review, summary, video, pdf, 'main-attempt': main };
	for (const { kind, reportedUsage, estimatedUsage, cost, usageStatus } of auxiliary) {
		const provisional = usageStatus === 'provisional' || (kind === 'main-attempt' && usageStatus === undefined);
		requests[kind].push({ ...normalizeUsage(reportedUsage, cost, estimatedUsage), provisional });
	}
	const total = usageTotals([...main, ...review, ...summary, ...video, ...pdf]);
	const videoUsage = usageTotals(video);
	const pdfUsage = usageTotals(pdf);
	return total && { ...total, byKind: { main: usageTotals(main), review: usageTotals(review), summary: usageTotals(summary),
		...(videoUsage && { video: videoUsage }), ...(pdfUsage && { pdf: pdfUsage }) } };
}

export function runUsage(state: RunState): UsageBreakdown | undefined {
	return usageBreakdown(completedMessages(state.messages), state.auxiliaryUsage ?? []);
}

export function messageTime(message: Message | undefined) {
	if (message?.local) return;
	if (message?.metrics?.endedAt) return message.metrics.endedAt;
	const { timestamp, durationMs } = message?.rawAssistant ?? {};
	return timestamp && nonNegative(durationMs) ? timestamp + durationMs : undefined;
}

export function conversationMetrics(runs: readonly RunState[], subagentRuns: readonly RunState[] = []): ConversationMetrics {
	const allRuns = [...new Map([...subagentRuns, ...runs].map((run) => [run.taskId, run])).values()];
	const all = allRuns.flatMap(({ messages }) => messages);
	const messages = completedMessages(all);
	const usage = usageBreakdown(messages, allRuns.flatMap(({ auxiliaryUsage }) => auxiliaryUsage ?? []));
	const lags = messages.flatMap(({ metrics }) => nonNegative(metrics?.firstDeltaMs) ? [metrics.firstDeltaMs] : []);
	let decodeMs = 0;
	let outputTokens = 0;
	for (const message of messages) {
		const duration = message.metrics?.decodeMs;
		if (!nonNegative(duration) || duration === 0) continue;
		const { output, provisional } = messageUsage(message);
		if (provisional || message.estimatedUsage?.output !== undefined || !nonNegative(output)) continue;
		decodeMs += duration;
		outputTokens += output;
	}
	const latest = (subagentRuns.length ? completedMessages(runs.flatMap(({ messages }) => messages)) : messages).at(-1);
	const latestUsage = latest && messageUsage(latest);
	const prompt = latestUsage?.provisional ? undefined : latestUsage?.reportedPrompt;
	const capacity = latest?.metrics?.contextWindow;
	return {
		rounds: allRuns.length,
		count: messages.length,
		modelMs: sum(messages.map(({ metrics, rawAssistant }) => metrics?.modelMs ?? rawAssistant?.durationMs)),
		toolMs: sum(all.map(({ toolDurationMs }) => toolDurationMs)),
		lagMs: lags.length ? lags.reduce((total, value) => total + value, 0) / lags.length : undefined,
		speed: decodeMs > 0 ? outputTokens * 1000 / decodeMs : undefined,
		usage,
		context: prompt !== undefined && capacity && capacity > 0
			? { prompt, capacity, remaining: Math.max(0, capacity - prompt), percent: Math.ceil(prompt * 10_000 / capacity) / 100 } : undefined,
		contextCompaction: runs.reduce<RunState['contextCompaction']>((latest, run) => run.contextCompaction ?? latest, undefined),
	};
}

export function abbreviatedNumber(value: number): string {
	if (value < 1_000) return value.toLocaleString();
	const million = value >= 999_950;
	return (value / (million ? 1_000_000 : 1_000)).toLocaleString(undefined, { maximumFractionDigits: 1 }) + (million ? 'M' : 'k');
}
