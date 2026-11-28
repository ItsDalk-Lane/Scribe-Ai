import { mediaDataUrl, mediaJson, responseBytes, type MediaAdapter, type MediaField, type MediaResult } from './mediaApi';

const endpoints = {
	'zai-payg': 'https://api.z.ai/api/paas/v4',
	'zai-payg-cn': 'https://open.bigmodel.cn/api/paas/v4',
};
const videoFields = [
	{ key: 'quality', label: ['生成模式', 'Generation mode'], choices: ['speed', 'quality'], default: 'speed' },
	{ key: 'size', label: ['视频分辨率', 'Video resolution'], choices: ['1280x720', '720x1280', '1024x1024', '1920x1080', '1080x1920', '2048x1080', '3840x2160'] },
	{ key: 'fps', label: ['帧率', 'Frame rate'], choices: [30, 60], default: 30 },
	{ key: 'duration', label: ['时长（秒）', 'Duration (seconds)'], choices: [5, 10], default: 5 },
	{ key: 'with_audio', label: ['生成视频配音', 'Generate video audio'], type: 'boolean', default: false },
] satisfies MediaField[];

const imageFields = [
	{ key: 'size', label: ['图片尺寸（宽x高）', 'Image size (width x height)'], type: 'string', default: '1280x1280' },
	{ key: 'quality', label: ['画质', 'Quality'], choices: ['hd', 'standard'], default: 'hd' },
] satisfies MediaField[];

const speechFields = [
	{ key: 'voice', label: ['音色 ID', 'Voice ID'], type: 'string', default: 'tongtong' },
	{ key: 'response_format', label: ['音频格式', 'Audio format'], choices: ['wav', 'pcm'], default: 'wav' },
	{ key: 'speed', label: ['语速倍数', 'Speaking speed'], type: 'number', min: 0.5, max: 2, default: 1 },
	{ key: 'volume', label: ['音量倍数', 'Voice volume'], type: 'number', min: 0.01, max: 10, default: 1 },
	{ key: 'watermark_enabled', label: ['添加音频水印', 'Add an audio watermark'], type: 'boolean', default: true },
] satisfies MediaField[];

export const zaiMedia: readonly MediaAdapter[] = Object.entries(endpoints).flatMap(([providerId, base]) => {
	const speech: MediaAdapter = {
		providerId, operation: 'speech-synthesis', models: ['glm-tts'], endpoint: () => base + '/audio/speech', fields: speechFields,
		async run(ctx) {
			const { voice = 'tongtong', response_format, speed, volume, watermark_enabled } = ctx.options;
			const extension = response_format === 'pcm' ? 'pcm' : 'wav';
			const response = await ctx.fetch(ctx.endpoint, {
				method: 'POST', signal: ctx.signal, redirect: 'error',
				headers: { Authorization: 'Bearer ' + ctx.key, 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: ctx.model, input: ctx.prompt, voice, response_format: extension, speed, volume, watermark_enabled, stream: false }),
			});
			const bytes = await responseBytes(response, 32 * 1024 * 1024, ctx.signal);
			return { bytes, extension, ...(extension === 'pcm' && { sampleRate: 24000 }) };
		},
	};
	return [
		{
			providerId, operation: 'image', models: ['glm-image'], endpoint: () => base + '/images/generations', fields: imageFields,
			async run(ctx) {
				const { size, quality } = ctx.options;
				if (size !== undefined) {
					const match = typeof size === 'string' && /^(\d{4})x(\d{4})$/u.exec(size);
					if (!match || [Number(match[1]), Number(match[2])].some((dimension) => dimension < 1024 || dimension > 2048 || dimension % 32 !== 0)) {
						throw new Error('智谱图片尺寸的两边须在 1024 至 2048 像素之间且为 32 的倍数，格式为宽x高。');
					}
				}
				const result = await mediaJson<{ data?: { url?: string }[] }>(ctx, ctx.endpoint, { model: ctx.model, prompt: ctx.prompt, size, quality });
				const url = result.data?.[0]?.url;
				if (typeof url !== 'string' || !url) throw new Error('智谱未返回图片下载地址。');
				return { url, extension: /\.jpe?g$/iu.test(URL.parse(url)?.pathname ?? '') ? 'jpg' : 'png' };
			},
		},
		{
			providerId, operation: 'video', models: ['cogvideox-3'], endpoint: () => base + '/videos/generations', fields: videoFields, input: 'image',
			async run(ctx) {
				if (ctx.source && (!['image/png', 'image/jpeg'].includes(ctx.source.mimeType) || ctx.source.bytes.byteLength > 5_000_000)) {
					throw new Error('智谱视频生成只接受 5 MB 以内的 PNG 或 JPEG 图片。');
				}
				const result = await mediaJson<{ id?: string }>(ctx, ctx.endpoint, {
					model: ctx.model, prompt: ctx.prompt, ...ctx.options, ...(ctx.source && { image_url: [mediaDataUrl(ctx.source)] }),
				});
				if (typeof result.id !== 'string' || !result.id) throw new Error('智谱未返回视频任务编号。');
				return { id: result.id };
			},
			async poll(ctx, id) {
				const result = await mediaJson<{ task_status?: string; video_result?: { url?: string }[] }>(ctx, base + '/async-result/' + encodeURIComponent(id));
				if (result.task_status === 'PROCESSING') return { status: 'running' };
				if (result.task_status === 'FAIL') return { status: 'failed' };
				const url = result.video_result?.[0]?.url;
				if (result.task_status === 'SUCCESS' && typeof url === 'string' && url) return { status: 'succeeded', result: { url, extension: 'mp4' } };
				throw new Error('智谱未返回可识别的任务状态或视频地址。');
			},
		},
		...(providerId === 'zai-payg-cn' ? [speech] : []),
		{
			providerId, operation: 'speech-recognition', models: ['glm-asr-2512'], input: 'audio', endpoint: () => base + '/audio/transcriptions',
			fields: [{ key: 'prompt', label: ['转写参考上下文', 'Transcription reference context'], type: 'string' }],
			async run(ctx): Promise<MediaResult> {
				const { source } = ctx;
				if (!source || !['audio/wav', 'audio/mpeg'].includes(source.mimeType) || source.bytes.byteLength > 25_000_000) {
					throw new Error('智谱语音识别只接受 25 MB 以内的 WAV 或 MP3。');
				}
				const form = new FormData();
				form.set('model', ctx.model);
				form.set('file', new Blob([new Uint8Array(source.bytes)], { type: source.mimeType }), source.filename);
				if (typeof ctx.options.prompt === 'string') form.set('prompt', ctx.options.prompt);
				const response = await ctx.fetch(ctx.endpoint, {
					method: 'POST', signal: ctx.signal, redirect: 'error', body: form, headers: { Authorization: 'Bearer ' + ctx.key },
				});
				const reply = JSON.parse((await responseBytes(response, 4 * 1024 * 1024, ctx.signal)).toString('utf8')) as { text?: string };
				if (typeof reply.text !== 'string') throw new Error('智谱未返回转写结果。');
				return { text: reply.text };
			},
		},
	] satisfies MediaAdapter[];
});
