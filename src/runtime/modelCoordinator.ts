import { setTimeout as delay } from 'node:timers/promises';
import { inputBytes } from '../orchestration/context/contextBuilder';
import { ContextOverflowError, RetryableModelError } from '../types';
import type { ContextBuilder, ModelCoordinator, ModelRequest, ModelService } from '../types';
import { assistantMessageId } from './runState';

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
			let visibleThinking = false;
			let shortened = false;
			let attempts = 0;
			let requested = 0;
			const query = async (input: ModelRequest, messageId: string) => {
				ctx.signal.throwIfAborted();
				ctx.checkModel?.();
				const review = ctx.resumeReview;
				review?.prepare(input);
				const started = performance.now();
				let firstDelta: number | undefined;
				let firstDeltaMs: number | undefined;
				let reviewMs = 0;
				const stream = service.stream({
					...input,
					...(attempts === 0 ? {} : { maxRetries: 0 }),
					...(review ? { beforeSend: async (address: string) => {
						const waitingAt = performance.now();
						try {
							await review.beforeSend(address);
						} finally {
							reviewMs += performance.now() - waitingAt;
						}
					} } : {}),
				});
				const thinking = new Map<number, { start: number; shown?: boolean; durationMs?: number }>();
				const blockAt = (index: number) => {
					let block = thinking.get(index);
					if (!block) thinking.set(index, block = { start: performance.now() });
					return block;
				};
				const showThinking = (contentIndex: number, text: string) => {
					if (!text) return;
					blockAt(contentIndex).shown = visibleThinking = true;
					ctx.observer.onEvent?.({ type: 'thinking-delta', messageId, contentIndex, text });
				};
				const finishThinking = (contentIndex: number) => {
					const block = thinking.get(contentIndex);
					if (!block?.shown || block.durationMs !== undefined) return;
					block.durationMs = Math.round(performance.now() - block.start);
					ctx.observer.onEvent?.({ type: 'thinking-end', messageId, contentIndex, durationMs: block.durationMs });
				};
				try {
					for await (const event of stream) {
						ctx.signal.throwIfAborted();
						if (firstDelta === undefined && (event.type === 'text_delta' || event.type === 'thinking_delta') && event.delta) {
							firstDelta = performance.now();
							firstDeltaMs = firstDelta - started - reviewMs;
						}
						if (event.type === 'text_delta' && event.delta) {
							visibleText = true;
							ctx.observer.onEvent?.({ type: 'text-delta', messageId, contentIndex: event.contentIndex, text: event.delta });
						}
						if (event.type === 'thinking_start' || event.type === 'thinking_delta' || event.type === 'thinking_end') {
							const { contentIndex } = event;
							const block = event.partial.content[contentIndex];
							if (block?.type === 'thinking' && block.redacted) continue;
							const progress = blockAt(contentIndex);
							// Pi Messages 到思考结束才公开是否隐藏这个块。
							if (event.type === 'thinking_delta' && event.partial.api !== 'pi-messages') showThinking(contentIndex, event.delta);
							if (event.type === 'thinking_end') {
								if (!progress.shown) showThinking(contentIndex, event.content);
								finishThinking(contentIndex);
							}
						}
					}
					const result = await stream.result();
					const ended = performance.now();
					const response = { ...result, metrics: {
						endedAt: Date.now(),
						modelMs: ended - started - reviewMs,
						firstDeltaMs,
						decodeMs: firstDelta === undefined ? undefined : ended - firstDelta,
						contextWindow: Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
					} };
					if (!thinking.size) return response;
					const content = response.raw.content.map((block, index) => {
						if (block.type !== 'thinking' || block.redacted) return block;
						finishThinking(index);
						const durationMs = thinking.get(index)?.durationMs;
						return durationMs === undefined ? block : { ...block, durationMs };
					});
					return { ...response, raw: { ...response.raw, content } };
				} catch (error) {
					stream.cancel(error);
					throw error;
				}
			};
			while (true) {
				const messageId = assistantMessageId(state, requested++);
				visibleText = false;
				visibleThinking = false;
				try {
					const response = await query(request, messageId);
					ctx.signal.throwIfAborted();
					ctx.readDelivery.accept(request.messages);
					return { ...response, id: messageId };
				} catch (error) {
					ctx.signal.throwIfAborted();
					if (error instanceof ContextOverflowError && !visibleText && !shortened) {
						ctx.checkModel?.();
						const size = inputBytes(request);
						const smaller = await context.build(ctx, state.messages, Math.floor(size / 2));
						if (inputBytes(smaller) >= size) throw error;
						request = smaller;
						shortened = true;
						if (visibleThinking) ctx.observer.onEvent?.({ type: 'model-retry', messageId, waiting: false, reason: 'context' });
						continue;
					}
					if (!(error instanceof RetryableModelError)) throw error;
					// 同一轮只重新请求模型，前面已经保存的工具结果继续作为输入。
					const pause = reconnectDelays[attempts++];
					if (pause !== undefined) {
						ctx.observer.onEvent?.({ type: 'model-retry', messageId, waiting: false });
						await delay(pause, undefined, { signal: ctx.signal });
					} else {
						if (!ctx.observer.retryConnection) throw new Error('模型服务多次重连未成功。已保留本次任务的进度。');
						ctx.observer.onEvent?.({ type: 'model-retry', messageId, waiting: true });
						await ctx.observer.retryConnection(ctx.signal);
						ctx.observer.onEvent?.({ type: 'model-retry', messageId, waiting: false });
						attempts = 0;
					}
				}
			}
		},
	};
}
