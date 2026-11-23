import type { AuxiliaryUsage, Message, ReportedUsage, RunState } from '../types';
import { reportedCost } from '../communication/reportedUsage';

function nonNegative(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function completedMessages(messages: readonly Message[]) {
	return messages.filter((message) => message.role === 'assistant' && !message.incomplete && !message.local);
}

function normalizeUsage(reported: ReportedUsage | undefined, cost: number | undefined) {
	const { output, cacheRead, cacheWrite } = reported ?? {};
	let { input, prompt } = reported ?? {};
	if (cacheRead !== undefined && cacheWrite !== undefined) {
		if (prompt === undefined && input !== undefined) prompt = input + cacheRead + cacheWrite;
		else if (input === undefined && prompt !== undefined && prompt >= cacheRead + cacheWrite) input = prompt - cacheRead - cacheWrite;
	}
	return {
		input, prompt, cacheRead, cacheWrite, output, cost,
		total: reported?.total ?? (prompt === undefined || output === undefined ? undefined : prompt + output),
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
	return normalizeUsage(reported, reportedCost(usage));
}

export interface UsageTotals {
	count: number;
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
	total?: number;
	hit?: number;
	cost?: number;
}

export interface UsageBreakdown extends UsageTotals {
	byKind: Record<'main' | AuxiliaryUsage['kind'], UsageTotals | undefined>;
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

type RequestUsage = ReturnType<typeof normalizeUsage>;

function usageTotals(entries: RequestUsage[]): UsageTotals | undefined {
	if (!entries.length) return;
	const totalOf = (key: keyof RequestUsage) => {
		const values = entries.map((entry) => entry[key]);
		return values.every(nonNegative) ? values.reduce((total, value) => total + value, 0) : undefined;
	};
	const prompt = totalOf('prompt');
	const read = totalOf('cacheRead');
	return {
		count: entries.length,
		input: totalOf('input'), cacheRead: read, cacheWrite: totalOf('cacheWrite'),
		output: totalOf('output'), total: totalOf('total'), cost: totalOf('cost'),
		hit: prompt && read !== undefined ? read / prompt : undefined,
	};
}

function usageBreakdown(messages: readonly Message[], auxiliary: readonly AuxiliaryUsage[]): UsageBreakdown | undefined {
	const main = messages.map(messageUsage);
	const review: RequestUsage[] = [];
	const summary: RequestUsage[] = [];
	for (const { kind, reportedUsage, cost } of auxiliary) {
		(kind === 'review' ? review : summary).push(normalizeUsage(reportedUsage, cost));
	}
	const total = usageTotals([...main, ...review, ...summary]);
	return total && { ...total, byKind: { main: usageTotals(main), review: usageTotals(review), summary: usageTotals(summary) } };
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
		const { output } = messageUsage(message);
		if (!nonNegative(output)) continue;
		decodeMs += duration;
		outputTokens += output;
	}
	const latest = (subagentRuns.length ? completedMessages(runs.flatMap(({ messages }) => messages)) : messages).at(-1);
	const prompt = latest && messageUsage(latest).prompt;
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
