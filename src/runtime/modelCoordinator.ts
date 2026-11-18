import { setTimeout as delay } from 'node:timers/promises';
import { inputBytes } from '../orchestration/context/contextBuilder';
import { ContextOverflowError, RetryableModelError } from '../types';
import type { ContextBuilder, ModelCoordinator, ModelRequest, ModelService } from '../types';

const reconnectDelays = [1_000, 3_000, 8_000];

export function createModelCoordinator(service: Pick<ModelService, 'stream' | 'contextLimits'>, context: ContextBuilder): ModelCoordinator {
	return {
		nextTurn: async (state, ctx) => {
			ctx.signal.throwIfAborted();
			ctx.checkModel?.();
			const limits = service.contextLimits?.(ctx.model);
			const { contextWindow = 0, maxTokens = 0 } = limits ?? {};
			const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 32_000;
			const output = Math.min(Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 8_000, window / 3);
			// shortcut: 按字节保守估算输入量，服务商有可用的计数接口时改用精确计数。
			const maxBytes = Math.floor((window * 0.85 - output) * 2);
			let request = await context.build(ctx, state.messages, maxBytes);
			let visibleText = false;
			let shortened = false;
			let attempts = 0;
			const query = async (input: ModelRequest) => {
				ctx.signal.throwIfAborted();
				ctx.checkModel?.();
				const review = ctx.resumeReview;
				review?.prepare(input);
				const stream = service.stream({
					...input,
					...(attempts === 0 ? {} : { maxRetries: 0 }),
					...(review ? { beforeSend: review.beforeSend } : {}),
				});
				try {
					for await (const event of stream) {
						ctx.signal.throwIfAborted();
						if (event.type === 'text_delta' && event.delta) {
							visibleText = true;
							ctx.observer.onEvent?.({ type: 'text-delta', text: event.delta });
						}
					}
					return await stream.result();
				} catch (error) {
					stream.cancel(error);
					throw error;
				}
			};
			while (true) {
				visibleText = false;
				try {
					const response = await query(request);
					ctx.signal.throwIfAborted();
					ctx.readDelivery.accept(request.messages);
					return response;
				} catch (error) {
					ctx.signal.throwIfAborted();
					if (error instanceof ContextOverflowError && !visibleText && !shortened) {
						ctx.checkModel?.();
						const size = inputBytes(request);
						const smaller = await context.build(ctx, state.messages, Math.floor(size / 2));
						if (inputBytes(smaller) >= size) throw error;
						request = smaller;
						shortened = true;
						continue;
					}
					if (!(error instanceof RetryableModelError)) throw error;
					// 同一轮只重新请求模型，前面已经保存的工具结果继续作为输入。
					const pause = reconnectDelays[attempts++];
					if (pause !== undefined) {
						ctx.observer.onEvent?.({ type: 'model-retry', waiting: false });
						await delay(pause, undefined, { signal: ctx.signal });
					} else {
						if (!ctx.observer.retryConnection) throw new Error('模型服务多次重连未成功。已保留本次任务的进度。');
						ctx.observer.onEvent?.({ type: 'model-retry', waiting: true });
						await ctx.observer.retryConnection(ctx.signal);
						ctx.observer.onEvent?.({ type: 'model-retry', waiting: false });
						attempts = 0;
					}
				}
			}
		},
	};
}
