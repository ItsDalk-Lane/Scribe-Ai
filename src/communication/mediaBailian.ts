import { mediaDataUrl, mediaJson, type MediaAdapter, type MediaCall, type MediaField, type MediaRoute } from './mediaApi';

const multimodal = '/api/v1/services/aigc/multimodal-generation/generation';
const speech = '/api/v1/services/audio/tts/SpeechSynthesizer';
const video = '/api/v1/services/aigc/video-generation/video-synthesis';
const products = [
	['bailian-payg', 'https://dashscope.aliyuncs.com'],
	['bailian-token-plan', 'https://token-plan.cn-beijing.maas.aliyuncs.com'],
	['qwen-token-plan-cn', 'https://token-plan.maas.qianwenaiapi.com'],
	['qwen-token-plan-individual-cn', 'https://token-plan.maas.qianwenaiapi.com'],
	['qwen-token-plan', 'https://token-plan.maas.qwencloudapi.com'],
	['qwen-token-plan-individual', 'https://token-plan.maas.qwencloudapi.com'],
] as const;

const imageFields = [
	{ key: 'size', label: ['图像尺寸（宽×高）', 'Image size (width × height)'], type: 'string' },
	{ key: 'prompt_extend', label: ['提示词改写', 'Extend prompt'], type: 'boolean' },
	{ key: 'watermark', label: ['添加水印', 'Watermark'], type: 'boolean' },
] satisfies MediaField[];
const videoFields = [
	{ key: 'resolution', label: ['分辨率', 'Resolution'], choices: ['480P', '720P', '1080P'] },
	{ key: 'ratio', label: ['画面比例', 'Aspect ratio'], choices: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
	{ key: 'duration', label: ['时长（秒，-1 自动）', 'Duration (seconds, -1 automatic)'], type: 'number', min: -1, max: 30 },
	{ key: 'audio', label: ['生成音轨', 'Generate audio'], type: 'boolean' },
	{ key: 'prompt_extend', label: ['提示词改写', 'Extend prompt'], type: 'boolean' },
	{ key: 'watermark', label: ['添加水印', 'Watermark'], type: 'boolean' },
] satisfies MediaField[];
const ttsFields = [
	{ key: 'voice', label: ['音色 ID', 'Voice ID'], type: 'string', default: 'longanhuan_v3.6', required: true },
	{ key: 'format', label: ['输出格式', 'Output format'], choices: ['mp3', 'wav'], default: 'mp3' },
	{ key: 'sample_rate', label: ['采样率', 'Sample rate'], choices: [8000, 16000, 22050, 24000, 44100, 48000], default: 22050 },
] satisfies MediaField[];
const asrFields = [
	{ key: 'language_hints', label: ['语言提示（最多四个，以逗号分隔）', 'Language hints (up to four, comma-separated)'], type: 'string' },
	{ key: 'sample_rate', label: ['输入音频采样率', 'Input sample rate'], type: 'number', min: 8000, max: 48000 },
] satisfies MediaField[];

function paygOrigin({ baseUrl }: MediaRoute, fallback: string): string {
	if (!baseUrl) return fallback;
	const url = URL.parse(baseUrl);
	if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
		|| !/^(?:dashscope(?:-intl)?\.aliyuncs\.com|[a-z\d-]+\.(?:cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1|cn-hongkong)\.maas\.aliyuncs\.com)$/u.test(url.hostname)) {
		throw new Error('请为百炼按量媒体配置官方地域或工作空间地址。');
	}
	return url.origin;
}

interface DashScopeReply {
	code?: string;
	output?: {
		choices?: { message?: { content?: { image?: string }[] } }[];
		audio?: { url?: string };
		text?: string;
		sentence?: { text?: string };
		task_id?: string;
		task_status?: string;
		video_url?: string;
	};
}

function output(reply: DashScopeReply) {
	if (reply.code) throw new Error('百炼媒体服务拒绝了请求。');
	return reply.output ?? {};
}

function nonEmpty(value: unknown, message: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(message);
	return value;
}

const wanModels = ['wan3.0-video', 'wan3.0-video-prime'];
type VideoMode = 'wan' | 'wan-edit' | 'happy-text' | 'happy-frame' | 'happy-reference' | 'happy-edit';

function videoSpec(providerId: string, endpoint: MediaAdapter['endpoint'], mode: VideoMode, models: readonly string[]): MediaAdapter {
	const wan = mode === 'wan' || mode === 'wan-edit';
	const edit = mode === 'wan-edit' || mode === 'happy-edit';
	const needsImage = mode === 'happy-frame' || mode === 'happy-reference';
	const beijingPlan = providerId === 'bailian-token-plan';
	const minDuration = wan && !beijingPlan ? 2 : 3;
	const maxDuration = wan && !beijingPlan ? 30 : 15;
	const acceptedFields = videoFields.flatMap((field): MediaField[] => {
		if (field.key === 'duration') return mode === 'happy-edit' ? [] : [{ ...field,
			...(wan && !beijingPlan ? {} : { label: ['时长（秒）', 'Duration (seconds)'], min: 3, max: 15 }),
		}];
		if (wan) return [field];
		if (field.key === 'ratio' && (mode === 'happy-text' || mode === 'happy-reference')) return [{ ...field, choices: ['16:9', '9:16', '3:4', '4:3', '4:5', '5:4', '1:1', '9:21', '21:9'] }];
		if (field.key === 'resolution' && mode === 'happy-edit') return [{ ...field, choices: ['720P', '1080P'] }];
		return field.key === 'resolution' || field.key === 'watermark' ? [field] : [];
	});
	return {
		providerId, models, operation: edit ? 'video-edit' : 'video', endpoint, fields: acceptedFields,
		input: edit ? 'video-url' : mode === 'happy-text' ? undefined : 'image',
		requiresSource: needsImage,
		async run(ctx) {
			const { duration } = ctx.options;
			if (duration !== undefined && (typeof duration !== 'number' || !Number.isInteger(duration)
				|| (!(wan && !beijingPlan && duration === -1) && (duration < minDuration || duration > maxDuration)))) {
				throw new Error(`视频时长需要为 ${minDuration}–${maxDuration} 秒的整数。`);
			}
			if (needsImage && !ctx.source) throw new Error('请选择用于生成视频的源图片。');
			if (ctx.source && (!['image/jpeg', 'image/png', 'image/webp'].includes(ctx.source.mimeType) || ctx.source.bytes.byteLength > 20_000_000)) {
				throw new Error('百炼视频生成需要 20 MB 以内的 JPEG、PNG 或 WebP 图片。');
			}
			const media = edit
				? [{ type: wan ? 'reference_video' : 'video', url: nonEmpty(ctx.sourceUrl, '请提供要编辑的视频直链。') }]
				: ctx.source ? [{ type: mode === 'happy-reference' ? 'reference_image' : 'first_frame', url: mediaDataUrl(ctx.source) }] : undefined;
			const reply = await mediaJson<DashScopeReply>(ctx, ctx.endpoint, {
				model: ctx.model, input: { prompt: ctx.prompt, ...(media && { media }) },
				parameters: mode === 'wan-edit' ? { ratio: 'adaptive', duration: -1, ...ctx.options } : ctx.options,
			}, { 'X-DashScope-Async': 'enable' });
			return { id: nonEmpty(output(reply).task_id, '百炼未返回视频任务编号。') };
		},
		async poll(ctx, id) {
			const pollEndpoint = new URL('/api/v1/tasks/' + encodeURIComponent(id), ctx.endpoint).href;
			const result = output(await mediaJson<DashScopeReply>(ctx, pollEndpoint));
			switch (result.task_status) {
				case 'PENDING': return { status: 'queued' };
				case 'RUNNING': return { status: 'running' };
				case 'SUCCEEDED':
					return { status: 'succeeded', result: { url: nonEmpty(result.video_url, '百炼未返回视频下载地址。'), extension: 'mp4' } };
				case 'FAILED':
				case 'CANCELED':
				case 'UNKNOWN': return { status: 'failed' };
				default: throw new Error('百炼未返回可识别的任务状态。');
			}
		},
	};
}

export const bailianMedia: readonly MediaAdapter[] = products.flatMap(([providerId, origin]) => {
	const payg = providerId === 'bailian-payg';
	const beijing = providerId === 'bailian-token-plan';
	const url = (path: string) => (route: MediaRoute) => (payg ? paygOrigin(route, origin) : origin) + path;
	const imageModels = payg
		? ['qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.1-pro', 'qwen-image-2.1-turbo']
		: ['qwen-image-3.0-pro'];
	const videoModels = payg ? wanModels : ['wan3.0-video'];
	const imageSpec = (edit: boolean): MediaAdapter => ({
		providerId, models: imageModels, operation: edit ? 'image-edit' : 'image', fields: imageFields,
		endpoint: url(multimodal), input: 'image',
		async run(ctx) {
			if (edit && !ctx.source) throw new Error('请提供要编辑的图像。');
			const content = [...(ctx.source ? [{ image: mediaDataUrl(ctx.source) }] : []), { text: ctx.prompt }];
			const { size, ...options } = ctx.options;
			if (size !== undefined && (typeof size !== 'string' || !/^\d{3,4}[*x×]\d{3,4}$/iu.test(size))) {
				throw new Error('百炼的图像尺寸格式为宽×高，例如 1024×1024。');
			}
			const parameters = { ...options, ...(typeof size === 'string' && { size: size.replace(/[x×]/iu, '*') }), n: 1 };
			const reply = await mediaJson<DashScopeReply>(ctx, ctx.endpoint, {
				model: ctx.model, input: { messages: [{ role: 'user', content }] }, parameters,
			});
			const result = output(reply).choices?.flatMap((choice) => choice.message?.content ?? []).find((part) => part.image)?.image;
			return { url: nonEmpty(result, '百炼未返回图像下载地址。'), extension: 'png' };
		},
	});
	return [
		imageSpec(false), imageSpec(true), videoSpec(providerId, url(video), 'wan', videoModels),
		videoSpec(providerId, url(video), 'happy-text', ['happyhorse-1.1-t2v']),
		videoSpec(providerId, url(video), 'happy-frame', ['happyhorse-1.1-i2v']),
		videoSpec(providerId, url(video), 'happy-reference', ['happyhorse-1.1-r2v']),
		...(!beijing ? [videoSpec(providerId, url(video), 'wan-edit', videoModels)] : []),
		...(payg ? [videoSpec(providerId, url(video), 'happy-edit', ['happyhorse-1.0-video-edit'])] : []),
		{
			providerId, operation: 'speech-synthesis', models: ['qwen-audio-3.0-tts-plus'], endpoint: url(speech), fields: ttsFields,
			async run(ctx: MediaCall) {
				const format = ctx.options.format === 'wav' ? 'wav' : 'mp3';
				const reply = await mediaJson<DashScopeReply>(ctx, ctx.endpoint, {
					model: ctx.model, input: { voice: 'longanhuan_v3.6', ...ctx.options, format, text: ctx.prompt },
				});
				return { url: nonEmpty(output(reply).audio?.url, '百炼未返回生成音频的下载地址。'), extension: format };
			},
		},
		{
			providerId, operation: 'speech-recognition', models: ['qwen-audio-3.0-asr-flash'], endpoint: url(multimodal), fields: asrFields, input: 'audio',
			async run(ctx: MediaCall) {
				const source = ctx.source;
				if (!source) throw new Error('请选择待识别的音频。');
				const format = source.filename.split('.').at(-1)?.toLowerCase();
				if (!format || !['aac', 'amr', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'webm'].includes(format)) {
					throw new Error('百炼语音识别不支持此音频格式。');
				}
				const { language_hints, ...options } = ctx.options;
				const hints = typeof language_hints === 'string' ? language_hints.split(',').map((value) => value.trim()).filter(Boolean) : [];
				if (hints.length > 4 || hints.some((value) => !/^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/iu.test(value))) {
					throw new Error('请填写最多四个用逗号分隔的语言代码。');
				}
				const content = [{ type: 'input_audio', input_audio: { data: mediaDataUrl(source) } }];
				const result = output(await mediaJson<DashScopeReply>(ctx, ctx.endpoint, {
					model: ctx.model, input: { messages: [{ role: 'user', content }] },
					parameters: { format, ...options, ...(hints.length && { language_hints: hints }) },
				}));
				return { text: nonEmpty(result.text || result.sentence?.text, '百炼未返回识别文本。') };
			},
		},
	] satisfies MediaAdapter[];
});
