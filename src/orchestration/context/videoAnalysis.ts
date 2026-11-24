import { Buffer } from 'node:buffer';
import { basename } from 'node:path';
import { videoMime } from '../../communication/modelVideo';
import type { AuxiliaryUsage, ModelRequest, ModelService, RunContext, RunObserver, ScribeSettings, VideoSourceKind } from '../../types';
import { meteredService } from '../meteredService';
import { isModelAvailable, videoModelFor } from '../settings/modelAvailability';
import { guardModelConnection } from '../settings/modelConnection';
import { prepareVideo, transcodableVideo } from './videoEncoding';
import { videoSourceKind, videoSources } from './videoAttachments';

type VideoModels = Pick<ModelService, 'send' | 'contextLimits' | 'modelOrigin' | 'modelCapabilities'> & Partial<Pick<ModelService, 'modelConnection'>>;

export function createVideoAnalysis(ctx: RunContext, settings: ScribeSettings, models: VideoModels,
	record: (usage: AuxiliaryUsage) => Promise<void>, save: (content: string, kinds: VideoSourceKind[]) => Promise<void>,
	confirmResume?: RunObserver['confirmResume']): RunContext['videoAnalysis'] {
	const { task, observer, signal } = ctx;
	const sources = videoSources(task.request, transcodableVideo).flatMap((source) => {
		const kind = videoSourceKind(source);
		const choice = videoModelFor(settings, kind);
		if (!choice) return [];
		const origin = models.modelOrigin?.(choice);
		const guard = guardModelConnection(settings, choice, models.modelConnection);
		const check = () => {
			guard();
			const input = models.modelCapabilities?.(choice.providerId, choice.model).videoAnalysis;
			if (videoModelFor(settings, kind) !== choice || !isModelAvailable(settings, choice) || !input
				|| (kind === 'file' && input !== 'file')) {
				throw new Error('视频解析模型已停用或连接已变更，请在「服务」中重新选择后提交。');
			}
			if (!ctx.permissions.canSendOutbound()) throw new Error('本次任务未授权使用视频解析服务。');
			return input;
		};
		return [{ source, kind, choice, origin, check }];
	});
	if (!sources.length) return;
	const kinds = [...new Set(sources.map(({ kind }) => kind))];
	const videoModels = meteredService(models, 'video', record);
	const approved = new Set<string>();
	let pending: Promise<string> | undefined;

	async function analyze() {
		observer.onEvent?.({ type: 'model-intent', intent: '正在准备并解析视频' });
		const reports: string[] = [];
		for (const [index, { source, choice, origin, check }] of sources.entries()) {
			const label = '视频 ' + (index + 1) + '（' + basename(source.path ?? new URL(source.url).pathname) + '）';
			try {
				signal.throwIfAborted();
				const input = check();
				let video;
				if (input === 'link') {
					const mimeType = source.url && videoMime(new URL(source.url).pathname);
					if (!source.url || !mimeType || mimeType === 'video/webm') {
						throw new Error('所选视频连接需要 MP4、MOV 或 MKV 的 HTTPS 直链，请更换视频链接。');
					}
					video = { mimeType, url: source.url };
				} else video = await prepareVideo(ctx, source, signal);
				check();
				const checkAddress = (address: string) => {
					check();
					if (!origin || URL.parse(address)?.origin !== origin) throw new Error('视频解析请求的实际接收地址已变更。');
				};
				const request: ModelRequest = {
					...choice,
					system: '你负责分析一个视频。按照用户问题提取有用的事实。每行以 [MM:SS] 或 [HH:MM:SS] 开头，描述对应时刻的画面、文字或声音。不要添加无时间戳的标题；无法确认的细节应明确标注。',
					messages: [{ role: 'user', content: task.request.instruction || '概述这段视频的主要内容。' }],
					tools: [], signal, maxTokens: 2_000, reasoning: null,
					video: { messageIndex: 0, hasFiles: video.data !== undefined, load: (active) => {
						active.throwIfAborted();
						return Promise.resolve([video]);
					} },
					async beforeSend(address) {
						checkAddress(address);
						const key = JSON.stringify([address, choice.providerId, choice.model]);
						if (confirmResume && !approved.has(key)) {
							observer.onWork?.(task.id, false);
							if (!await confirmResume({ request, address, source: task.request }, signal)) {
								throw new Error('未确认向视频解析模型重新发送视频。');
							}
							approved.add(key);
							observer.onWork?.(task.id, true);
							checkAddress(address);
						}
					},
				};
				observer.onWork?.(task.id, true);
				const response = await videoModels.send(request).finally(() => observer.onWork?.(task.id, false));
				signal.throwIfAborted();
				if (!response.reportedUsage?.videoInput) throw new Error('服务商未确认处理视频输入。');
				if (response.stopReason !== 'end') throw new Error('视频解析结果未完整返回。');
				const lines = response.content.trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
				if (!lines.length || lines.some((line) => !/^\[(?:\d{1,3}:[0-5]\d|\d{1,3}):[0-5]\d\]\s*\S/u.test(line))) {
					throw new Error('视频模型没有返回有效的带时间戳解析结果。');
				}
				reports.push(label + '\n' + lines.join('\n'));
			} catch (error) {
				signal.throwIfAborted();
				throw Object.assign(new Error(label + '解析失败。' + (error instanceof Error ? error.message : String(error))), { cause: error });
			}
		}
		const content = reports.join('\n\n');
		if (Buffer.byteLength(content) > 16_384) throw new Error('视频解析结果过长，请减少一次发送的视频数量。');
		await save(content, kinds);
		observer.onEvent?.({ type: 'model-intent', intent: '视频已送达，正在交接解析结果' });
		return content;
	}
	return { sources: kinds, read: () => pending ??= analyze() };
}
