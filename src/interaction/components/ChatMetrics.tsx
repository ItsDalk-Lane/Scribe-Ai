import { useMemo } from 'react';
import type { RunState, SavedRun } from '../../types';
import type { ConversationMetrics, ContextUsage, UsageTotals } from '../chatMetrics';
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

function optionalTokens(value: number | undefined, compact = false) {
	return value === undefined ? undefined : tokens(value, compact);
}

function cachePercent(hit: number, turn: boolean) {
	return hit.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: turn ? 1 : 0 });
}

export function UsagePopover({ usage, model, busy, turn = false }: {
	usage: UsageTotals; model?: SavedRun['model']; busy?: boolean; turn?: boolean;
}) {
	const text = uiText();
	const heading = turn ? text.chatRunUsage : text.chatSessionUsage;
	const hit = usage.hit === undefined ? undefined : cachePercent(usage.hit, turn);
	const label = [usage.partialTotal ? text.chatIncompleteUsage : undefined, optionalTokens(usage.total, true),
		!turn && hit ? `${text.chatCacheHit} ${hit}` : undefined].filter(Boolean).join(' · ');
	return <MetricPopover icon="database" label={label} heading={heading} value={optionalTokens(usage.total)} wrapValues>
		<MetricRows rows={[
			[text.chatProviderModel, model && `${model.providerId} / ${model.model}`],
			[text.chatCacheHit, hit],
			[text.chatUncachedInput, optionalTokens(usage.input)],
			[text.chatCacheRead, optionalTokens(usage.cacheRead)],
			[text.chatCacheWrite, optionalTokens(usage.cacheWrite)],
			[text.chatOutputTokens, optionalTokens(usage.output)],
			[usage.partialTotal ? text.chatIncompleteUsage : text.chatTotalTokens, optionalTokens(usage.total)],
			[text.chatReportedCost, usage.cost?.toLocaleString(undefined, { style: 'currency', currency: 'USD',
				minimumFractionDigits: 4, maximumFractionDigits: 4 })],
		]} />
		{busy && <p>{text.chatMetricsRunning}</p>}
	</MetricPopover>;
}

export function useChatMetrics(history: readonly SavedRun[], live: RunState | null) {
	return useMemo(() => {
		const runs = history.map(({ state }) => live?.taskId === state.taskId ? live : state);
		if (live && !runs.some(({ taskId }) => taskId === live.taskId)) runs.push(live);
		return conversationMetrics(runs);
	}, [history, live]);
}

export function ActivityMetric({ metrics, busy }: { metrics: ConversationMetrics; busy: boolean }) {
	const text = uiText();
	const { rounds, count, modelMs, toolMs, lagMs, speed } = metrics;
	if (!count) return null;
	const activity = text.chatActivitySummary.replace('{rounds}', abbreviatedNumber(rounds)).replace('{messages}', abbreviatedNumber(count));
	const speedNumber = speed === undefined ? undefined : abbreviatedNumber(Math.round(speed));
	const speedLabel = speedNumber === undefined ? '' : ` · ${text.chatSpeedValue.replace('{n}', speedNumber)}`;
	return <MetricPopover icon="gauge" label={activity + speedLabel} heading={text.chatActivityStats} value={activity}>
		<MetricRows rows={[
			[text.chatModelDuration, chatDuration(modelMs, 1)], [text.chatToolDuration, chatDuration(toolMs, 1)],
			[text.chatFirstDelta, chatDuration(lagMs, 1)],
			[text.chatSpeed, speedNumber === undefined ? undefined : text.chatSpeedValue.replace('{n}', speedNumber)],
		]} />
		{busy && <p>{text.chatMetricsRunning}</p>}
	</MetricPopover>;
}

export function ContextMetric({ context, busy }: {
	context: ContextUsage; busy: boolean;
}) {
	const text = uiText();
	const percent = context.percent.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const heading = text.chatContextStats.replace('{n}', percent);
	return <MetricPopover icon={<ContextRing percent={context.percent} />}
		label={text.chatContextUsed.replace('{n}', percent)}
		heading={heading} value={`${abbreviatedNumber(context.prompt)} / ${abbreviatedNumber(context.capacity)}`}>
		<progress className="scribe-context-progress" aria-label={heading}
			value={Math.min(context.prompt, context.capacity)} max={context.capacity} />
		<MetricRows rows={[[text.chatPromptTokens, tokens(context.prompt)], [text.chatWindowCapacity, tokens(context.capacity)],
			[text.chatRemainingCapacity, tokens(context.remaining)]]} />
		{busy && <p>{text.chatMetricsRunning}</p>}
	</MetricPopover>;
}
