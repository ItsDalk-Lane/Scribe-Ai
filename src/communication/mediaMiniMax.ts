import { Buffer } from 'node:buffer';
import { checkMiniMaxPlanKey } from './extraProviders';
import { mediaDataUrl, mediaJson, responseBytes, type MediaAdapter, type MediaCall, type MediaField, type MediaResult } from './mediaApi';

const providers = [
	['minimax', 'https://api.minimax.io'],
	['minimax-cn', 'https://api.minimax.cn'],
	['minimax-m-plan', 'https://api.minimax.io'],
	['minimax-m-plan-cn', 'https://api.minimax.cn'],
] as const;
const h3Image = ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'];
const h3Video = ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite'];

const h3ImageFields = [
	{ key: 'size', label: ['输出尺寸（auto 或宽×高）', 'Output size (auto or width × height)'], type: 'string' },
	{ key: 'aspect_ratio', label: ['画面比例（自动尺寸）', 'Aspect ratio (automatic size)'], choices: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] },
	{ key: 'area', label: ['图像面积（自动尺寸）', 'Image area (automatic size)'], choices: ['1K', '2K', '4K'] },
	{ key: 'output_format', label: ['图片编码格式', 'Image encoding'], choices: ['jpeg', 'png', 'webp'], default: 'jpeg' },
] satisfies MediaField[];

function h3Fields(model: string, edit: boolean): MediaField[] {
	return [
		{ key: 'resolution', label: ['视频清晰度', 'Video resolution'], choices: model === 'MiniMax-H3' ? ['480P', '768P', '2K'] : ['480P', '768P'], default: '768P' },
		{ key: 'duration', label: ['视频长度（秒）', 'Video length (seconds)'], type: 'number', min: 4, max: 15, default: 5 },
		{ key: 'ratio', label: ['视频比例', 'Video aspect ratio'], choices: [...(edit && model !== 'MiniMax-H3-Lite' ? ['adaptive'] : []), '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
		{ key: 'generate_audio', label: ['生成视频声音', 'Generate video audio'], type: 'boolean' },
	];
}

const speechFields = [
	{ key: 'voice_id', label: ['音色 ID', 'Voice ID'], type: 'string', default: 'female-shaonv', required: true },
	{ key: 'speed', label: ['语速倍数', 'Speaking speed'], type: 'number', min: 0.5, max: 2, default: 1 },
	{ key: 'vol', label: ['音量倍数', 'Voice volume'], type: 'number', min: 0.01, max: 10, default: 1 },
	{ key: 'pitch', label: ['音高（半音）', 'Pitch (semitones)'], type: 'number', min: -12, max: 12, default: 0 },
	{ key: 'emotion', label: ['声音情绪', 'Emotion'], choices: ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral', 'fluent', 'whisper'] },
	{ key: 'format', label: ['音频格式', 'Audio format'], choices: ['mp3', 'wav', 'flac'], default: 'mp3' },
	{ key: 'sample_rate', label: ['音频采样率', 'Audio sample rate'], choices: [8000, 16000, 22050, 24000, 32000, 44100], default: 32000 },
] satisfies MediaField[];

const recognizeFields = [
	{ key: 'language', label: ['主要口语语言代码', 'Primary spoken language code'], choices: ['zh', 'yue', 'en', 'ja', 'ko', 'th', 'vi', 'id', 'ms', 'fil', 'ar', 'tr', 'fr', 'de', 'es', 'it', 'pt', 'pl', 'ru', 'uk'] },
	{ key: 'timestamp_level', label: ['时间戳粒度', 'Timestamp granularity'], choices: ['off', 'segment', 'word'], default: 'off' },
] satisfies MediaField[];

function stringResult(value: unknown, message: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(message);
	return value;
}

function requireKind(ctx: MediaCall) {
	if (!ctx.source) throw new Error('请选择要发送的源文件。');
	return ctx.source;
}

interface MiniMaxReply {
	base_resp?: { status_code?: number };
	task_id?: string;
	task?: { status?: string; content?: { url?: string } };
	data?: { audio?: string };
}

async function paidJson(ctx: MediaCall, url: string, body?: object) {
	const result = await mediaJson<MiniMaxReply>(ctx, url, body);
	if (result.base_resp?.status_code) throw new Error('MiniMax 拒绝了媒体请求。');
	return result;
}

function h3VideoAdapter(providerId: string, origin: string, edit: boolean, plan: boolean): MediaAdapter {
	return {
		providerId, operation: edit ? 'video-edit' : 'video', models: plan ? ['MiniMax-H3'] : h3Video,
		input: edit ? 'video' : 'image', endpoint: () => origin + '/v2/video_generation', fields: (model) => h3Fields(model, edit),
		async run(ctx) {
			const source = edit ? requireKind(ctx) : ctx.source;
			if (edit && source && !['video/mp4', 'video/quicktime'].includes(source.mimeType)) throw new Error('MiniMax H3 接受 MP4 或 MOV 视频。');
			if (source && source.bytes.byteLength > (edit ? 47_000_000 : 30_000_000)) throw new Error('源文件超过 MiniMax H3 单次请求可发送的大小。');
			const { duration = 5, resolution = '768P', ratio, generate_audio } = ctx.options;
			if (!Number.isInteger(duration)) throw new Error('MiniMax H3 的视频时长需要为整数。');
			const content = [
				{ type: 'text', text: ctx.prompt },
				...(source ? [edit
					? { type: 'video_url', video_url: { url: mediaDataUrl(source) }, role: 'reference_video' }
					: { type: 'image_url', image_url: { url: mediaDataUrl(source) }, role: 'first_frame' }] : []),
			];
			const effectiveRatio = source && !edit ? 'adaptive' : ratio ?? (edit && ctx.model !== 'MiniMax-H3-Lite' ? 'adaptive' : '16:9');
			const result = await paidJson(ctx, ctx.endpoint, {
				model: ctx.model, content, duration, resolution, ratio: effectiveRatio, generate_audio, response_format: 'task',
			});
			return { id: stringResult(result.task_id, 'MiniMax 未返回任务编号。') };
		},
		async poll(ctx, id) {
			const task = (await paidJson(ctx, origin + '/v2/query/video_generation/' + encodeURIComponent(id))).task;
			switch (task?.status?.toLowerCase()) {
				case 'pending':
				case 'queued': return { status: 'queued' };
				case 'running':
				case 'processing': return { status: 'running' };
				case 'succeeded':
				case 'success': return { status: 'succeeded', result: { url: stringResult(task.content?.url, 'MiniMax 未返回视频下载地址。'), extension: 'mp4' } };
				case 'failed':
				case 'expired':
				case 'cancelled': return { status: 'failed' };
				default: throw new Error('MiniMax 未返回可识别的任务状态。');
			}
		},
	};
}

async function transcribe(ctx: MediaCall): Promise<MediaResult> {
	const source = requireKind(ctx);
	if (!/\.(?:wav|aiff|flac|m4a|mp3|aac|opus|ogg)$/iu.test(source.filename) || source.bytes.byteLength > 50_000_000) {
		throw new Error('MiniMax 语音识别需要 50 MB 以内的受支持音频文件。');
	}
	const body = new FormData();
	const { language, timestamp_level = 'off' } = ctx.options;
	body.set('model', ctx.model);
	body.set('file', new Blob([new Uint8Array(source.bytes)], { type: source.mimeType }), source.filename);
	body.set('response_format', timestamp_level === 'off' ? 'json' : 'verbose_json');
	if (timestamp_level === 'word') body.set('timestamp_level', timestamp_level);
	body.set('stream', 'false');
	const response = await ctx.fetch(ctx.endpoint, {
		method: 'POST', redirect: 'error', signal: ctx.signal, body,
		headers: { Authorization: 'Bearer ' + ctx.key, ...(typeof language === 'string' && { language }) },
	});
	const result = JSON.parse((await responseBytes(response, 4 * 1024 * 1024, ctx.signal)).toString('utf8')) as { text?: string; segments?: { start?: number; end?: number; text?: string }[] };
	const text = stringResult(result.text, 'MiniMax 未返回识别文本。');
	const lines = timestamp_level !== 'off' && Array.isArray(result.segments)
		? result.segments.filter((segment) => typeof segment.text === 'string' && Number.isFinite(segment.start) && Number.isFinite(segment.end))
			.map(({ start, end, text: line }) => '[' + start + 's – ' + end + 's] ' + line)
		: [];
	return { text: lines.length ? text + '\n\n' + lines.join('\n') : text };
}

export const miniMaxMedia: readonly MediaAdapter[] = providers.flatMap(([providerId, origin]) => {
	const plan = providerId.startsWith('minimax-m-plan');
	const spec = (edit: boolean): MediaAdapter => ({
		providerId, operation: edit ? 'image-edit' : 'image', models: h3Image, input: edit ? 'image' : undefined,
		endpoint: () => origin + '/v1/images/' + (edit ? 'edits' : 'generations'), fields: h3ImageFields,
		async run(ctx) {
			const { size, aspect_ratio, area, output_format = 'jpeg' } = ctx.options;
			const source = edit ? requireKind(ctx) : undefined;
			if (size && size !== 'auto' && (aspect_ratio || area || typeof size !== 'string' || !/^\d{3,4}x\d{3,4}$/u.test(size))) {
				throw new Error('MiniMax H3 Image 的固定尺寸使用宽x高，固定尺寸与自动比例或面积不可同时选择。');
			}
			const reply = await mediaJson<{ data?: { url?: string }[] }>(ctx, ctx.endpoint, {
				model: ctx.model, prompt: ctx.prompt, size, aspect_ratio, area, output_format, response_format: 'url', n: 1,
				...(source && { images: [{ image_url: mediaDataUrl(source) }] }),
			});
			return { url: stringResult(reply.data?.[0]?.url, 'MiniMax 未返回图像链接。'),
				extension: output_format === 'png' ? 'png' : output_format === 'webp' ? 'webp' : 'jpg' };
		},
	});
	const adapters: MediaAdapter[] = [
		spec(false), spec(true), h3VideoAdapter(providerId, origin, false, plan), h3VideoAdapter(providerId, origin, true, plan),
		{
			providerId, operation: 'speech-synthesis', models: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo'],
			endpoint: () => origin + '/v1/t2a_v2', fields: speechFields,
			async run(ctx: MediaCall) {
				const { voice_id = 'female-shaonv', speed, vol, pitch, emotion, sample_rate, format } = ctx.options;
				if (pitch !== undefined && !Number.isInteger(pitch)) throw new Error('音高需要填写整数半音。');
				const extension = format === 'wav' || format === 'flac' ? format : 'mp3';
				const reply = await paidJson(ctx, ctx.endpoint, {
					model: ctx.model, text: ctx.prompt, stream: false, output_format: 'hex',
					voice_setting: { voice_id, speed, vol, pitch, emotion },
					audio_setting: { sample_rate, format: extension, channel: 1 },
				});
				const audio = stringResult(reply.data?.audio, 'MiniMax 未返回合成音频。');
				if (audio.length % 2 || !/^[0-9a-f]+$/iu.test(audio)) throw new Error('MiniMax 返回的音频编码无效。');
				return { bytes: Buffer.from(audio, 'hex'), extension };
			},
		},
		{
			providerId, operation: 'speech-recognition', models: ['asr-1.0'], input: 'audio',
			endpoint: () => origin + '/v1/speech_to_text', fields: recognizeFields, run: transcribe,
		},
	];
	if (!plan) return adapters;
	return adapters.map(({ poll, ...adapter }): MediaAdapter => ({
		...adapter,
		async run(ctx) {
			checkMiniMaxPlanKey(providerId, ctx.key);
			return adapter.run(ctx);
		},
		...(poll && { async poll(ctx, id) {
			checkMiniMaxPlanKey(providerId, ctx.key);
			return poll(ctx, id);
		} }),
	}));
});
