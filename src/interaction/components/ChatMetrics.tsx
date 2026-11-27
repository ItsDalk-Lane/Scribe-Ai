import { useMemo } from 'react';
import type { RunState, SavedRun } from '../../types';
import type { ConversationMetrics, ContextUsage, UsageMetric, UsageTotals } from '../chatMetrics';
import { abbreviatedNumber, conversationMetrics } from '../chatMetrics';
import { uiText } from '../uiText';
import MetricPopover, { ContextRing, MetricRows } from './MetricPopover';

export function chatDuration(ms: number | undefined, precision = 0) {
	if (ms === undefined || ms < 0 || !Number.isFinite(ms)) return;
	const text = uiText();
	const seconds = Math.round(ms / 1000);
	return ms >= 60_000
		? text.chatMetricMinutes.replace('{m}', Math.floor(seconds / 60).toLocaleString()).replace('{s}', String(seconds % 60))
		: text.chatMetricSeconds.replace('{s}', (precision ? ms / 1000 : seconds)
			.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision }));
}

function tokens(value: number, compact = false) {
	return uiText().chatTimelineUsage.replace('{n}', compact ? abbreviatedNumber(value) : value.toLocaleString());
}

function cachePercent(hit: number, turn: boolean) {
	return hit.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: turn ? 1 : 0 });
}

export function UsagePopover({ usage, model, turn = false, title }: {
	usage: UsageTotals; model?: SavedRun['model']; turn?: boolean; title?: string;
}) {
	const text = uiText();
	const heading = title ?? (turn ? text.chatRunUsage : text.chatSessionUsage);
	const figure = (field: Exclude<UsageMetric, 'cost'>, compact = false) => {
		const value = usage[field] ?? usage.partial?.[field]?.value;
		if (value === undefined) return;
		return field === 'hit' ? cachePercent(value, turn) : tokens(value, compact);
	};
	const rows = [
		[text.chatCacheHit, figure('hit')], [text.chatPromptTokens, figure('prompt')],
		[text.chatUncachedInput, figure('input')], [text.chatCacheRead, figure('cacheRead')],
		[text.chatCacheWrite, figure('cacheWrite')], [text.chatOutputTokens, figure('output')],
	] as const;
	const hit = figure('hit', true);
	const label = [figure('total', true) ?? heading,
		!turn && hit ? `${text.chatCacheHit} ${hit}` : undefined].filter(Boolean).join(' · ');
	const total = figure('total');
	return <MetricPopover icon="database" label={label} heading={heading} value={total} wrapValues hover={!turn}>
		<MetricRows rows={[[text.chatProviderModel, model && `${model.providerId} / ${model.model}`],
			[text.chatUsageRequests, usage.count.toLocaleString()], ...rows]} />
	</MetricPopover>;
}

export function useChatMetrics(history: readonly SavedRun[], live: RunState | null, subagents?: readonly SavedRun[]) {
	return useMemo(() => {
		const runs = history.map(({ state }) => live?.taskId === state.taskId ? live : state);
		if (live && !runs.some(({ taskId }) => taskId === live.taskId)) runs.push(live);
		return conversationMetrics(runs, subagents?.map(({ state }) => state));
	}, [history, live, subagents]);
}

function speedValue(speed: ConversationMetrics['speed']) {
	return speed === undefined ? undefined : uiText().chatSpeedValue.replace('{n}',
		speed.toLocaleString(undefined, { maximumFractionDigits: 1 }));
}

function activityRows({ modelMs, toolMs, lagMs, speed }: ConversationMetrics) {
	const text = uiText();
	return [
		[text.chatModelDuration, chatDuration(modelMs, 1)], [text.chatToolDuration, chatDuration(toolMs, 1)],
		[text.chatFirstDelta, chatDuration(lagMs, 1)], [text.chatSpeed, speedValue(speed)],
	] as const;
}

export function ActivityMetric({ metrics, busy }: { metrics: ConversationMetrics; busy: boolean }) {
	const text = uiText();
	const { rounds, count } = metrics;
	if (!count) return null;
	const activity = text.chatActivitySummary.replace('{rounds}', abbreviatedNumber(rounds)).replace('{messages}', abbreviatedNumber(count));
	const speed = speedValue(metrics.speed);
	return <MetricPopover icon="gauge" label={speed === undefined ? activity : `${activity} · ${speed}`} heading={text.chatActivityStats} value={activity} hover>
		<MetricRows rows={activityRows(metrics)} />
		{busy && <p>{text.chatMetricsRunning}</p>}
	</MetricPopover>;
}

export function ContextMetric({ context, compaction, busy }: {
	context?: ContextUsage; compaction?: RunState['contextCompaction']; busy: boolean;
}) {
	const text = uiText();
	const percent = context?.percent.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const heading = percent === undefined ? text.chatContextCompaction : text.chatContextStats.replace('{n}', percent);
	const label = [percent === undefined ? undefined : text.chatContextUsed.replace('{n}', percent),
		compaction && text.chatContextCompacted].filter(Boolean).join(' · ');
	return <MetricPopover icon={context ? <ContextRing percent={context.percent} /> : 'minimize-2'} label={label}
		heading={heading} value={context && `${abbreviatedNumber(context.prompt)} / ${abbreviatedNumber(context.capacity)}`}>
		{context && <>
			<progress className="scribe-context-progress" aria-label={heading}
				value={Math.min(context.prompt, context.capacity)} max={context.capacity} />
			<MetricRows rows={[[text.chatPromptTokens, tokens(context.prompt)], [text.chatWindowCapacity, tokens(context.capacity)],
				[text.chatRemainingCapacity, tokens(context.remaining)]]} />
		</>}
		{compaction && <MetricRows rows={[
			[text.chatCompactionReason, text.chatCompactionReasons[compaction.reason]],
			[text.chatCompactionDroppedHistory, compaction.droppedHistory.toLocaleString()],
			[text.chatCompactionDroppedCurrent, compaction.droppedCurrent.toLocaleString()],
			[text.chatCompactionShortenedTools, compaction.shortenedToolResults.toLocaleString()],
			[text.chatCompactionSummary, text.chatCompactionSummaries[compaction.summary]],
			[text.chatCompactionThrough, compaction.throughMessage === undefined ? undefined
				: text.chatCompactionMessage.replace('{n}', compaction.throughMessage.toLocaleString())],
		]} />}
		{busy && <p>{text.chatMetricsRunning}</p>}
	</MetricPopover>;
}
