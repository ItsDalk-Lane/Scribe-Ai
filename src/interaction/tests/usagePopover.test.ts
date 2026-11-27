import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { ComponentProps, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageTotals } from '../chatMetrics';
import type MetricPopover from '../components/MetricPopover';

void test('turn and conversation usage display totals and available rows without status text', async (t) => {
	const hooks = registerHooks({
		resolve: (id, context, next) => id === 'obsidian'
			? { shortCircuit: true, format: 'commonjs', url: 'test:obsidian' } : next(id, context),
		load: (url, context, next) => url === 'test:obsidian'
			? { shortCircuit: true, format: 'commonjs', source: "exports.getLanguage = () => 'zh-CN';" } : next(url, context),
	});
	t.after(() => hooks.deregister());
	const { UsagePopover } = await import('../components/ChatMetrics');
	const usage: UsageTotals = { count: 2, partial: {
		total: { value: 12, reported: 1, provisional: 1 }, output: { value: 0, reported: 1, provisional: 1 },
		hit: { value: 0.25, reported: 1 },
	} };
	for (const turn of [true, false]) {
		const props = { usage, turn, busy: true };
		const widget: ReactElement<ComponentProps<typeof MetricPopover>> = UsagePopover(props);
		assert.equal(widget.props.label, turn ? '12 个 token' : '12 个 token · 缓存命中 25%');
		assert.equal(widget.props.value, '12 个 token');
		const rows = renderToStaticMarkup(widget.props.children).replace(/<[^>]+>/gu, '');
		assert.equal(rows, '模型请求次数2缓存命中25%输出0 个 token');
		const empty: ReactElement<ComponentProps<typeof MetricPopover>> = UsagePopover({ ...props, usage: { count: 1 } });
		assert.equal(renderToStaticMarkup(empty.props.children).replace(/<[^>]+>/gu, ''), '模型请求次数1');
		const promptOnly: UsageTotals = { count: 1, partial: { prompt: { value: 48, reported: 1, provisional: 1 } } };
		const sending: ReactElement<ComponentProps<typeof MetricPopover>> = UsagePopover({ ...props, usage: promptOnly });
		assert.equal(renderToStaticMarkup(sending.props.children).replace(/<[^>]+>/gu, ''), '模型请求次数1提示词 token 总数48 个 token');
	}
});
