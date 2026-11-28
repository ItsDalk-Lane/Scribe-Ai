import { Buffer } from 'node:buffer';
import { setTimeout as wait } from 'node:timers/promises';
import { mediaBytes, mediaJson, responseBytes } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaField, MediaResult, MediaSource } from './mediaApi';
import { mediaBase64, mediaItems, mediaObject, mediaProperty, mediaSource } from './mediaDirectHttp';

const host = 'https://generativelanguage.googleapis.com';
const interactions = `${host}/v1beta/interactions`;
const uploadEndpoint = `${host}/upload/v1beta/files`;
const imageModels = ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];
const voiceModels = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-pro-preview-tts'];
const videoModels = ['gemini-omni-1.2-flash', 'gemini-omni-1.1-flash'];

const headers = (ctx: MediaCall) => ({ 'x-goog-api-key': ctx.key });
const text = (value: string) => ({ type: 'text', text: value });
const inline = (source: MediaSource) => ({ type: source.mimeType.split('/')[0], mime_type: source.mimeType,
	data: Buffer.from(source.bytes).toString('base64') });

function outputParts(reply: unknown) {
	return mediaItems(mediaObject(reply).steps).filter((step) => mediaObject(step).type === 'model_output')
		.flatMap((step) => mediaItems(mediaObject(step).content)).map(mediaObject);
}

const aspectRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function imageFields(model: string): MediaField[] {
	return [
		{ key: 'aspect_ratio', label: ['画幅比例', 'Aspect ratio'], choices: aspectRatios },
		...model !== 'gemini-2.5-flash-image' ? [{ key: 'image_size', label: ['生成像素档位', 'Image resolution tier'] as [string, string], choices: ['1K', '2K', '4K'] }] : [],
		{ key: 'mime_type', label: ['图片编码', 'Image encoding'], choices: ['image/png', 'image/jpeg'], default: 'image/png' },
	];
}

async function googleImage(ctx: MediaCall, edit: boolean): Promise<MediaResult> {
	const reply = await mediaJson(ctx, ctx.endpoint, {
		model: ctx.model, store: false,
		input: edit ? [text(ctx.prompt), inline(mediaSource(ctx))] : ctx.prompt,
		response_format: { type: 'image', mime_type: 'image/png', ...ctx.options },
	}, headers(ctx));
	const asset = outputParts(reply).find((part) => part.type === 'image');
	return { bytes: mediaBase64(mediaProperty(asset, 'data')), extension: (asset?.mime_type ?? ctx.options.mime_type) === 'image/jpeg' ? 'jpg' : 'png' };
}

function fileResource(uri: string, download: boolean): URL {
	const url = new URL(uri, `${host}/v1beta/`);
	if (url.origin !== host || url.username || url.password || !/^\/v1beta\/files\/[a-z0-9_-]+(?::download)?$/iu.test(url.pathname)) {
		throw new Error('Google 返回的素材地址无效。');
	}
	if (download && !url.pathname.endsWith(':download')) url.pathname += ':download';
	url.search = download ? '?alt=media' : '';
	return url;
}

async function googleUpload(ctx: MediaCall, source: MediaSource) {
	const request = await ctx.fetch(uploadEndpoint, {
		method: 'POST', redirect: 'error', signal: ctx.signal,
		headers: { ...headers(ctx), 'content-type': 'application/json', 'x-goog-upload-protocol': 'resumable',
			'x-goog-upload-command': 'start', 'x-goog-upload-header-content-length': String(source.bytes.length),
			'x-goog-upload-header-content-type': source.mimeType },
		body: JSON.stringify({ file: { display_name: 'scribe-reference' } }),
	});
	const session = request.headers.get('x-goog-upload-url');
	await request.body?.cancel();
	if (!request.ok || !session) throw new Error(`Google 素材上传未能开始（HTTP ${request.status}）。`);
	const url = new URL(session);
	if (url.origin !== host || url.pathname !== '/upload/v1beta/files' || url.username || url.password) throw new Error('Google 返回了无效的上传会话。');
	const result = await ctx.fetch(url, {
		method: 'POST', redirect: 'error', signal: ctx.signal, headers: {
			'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0', 'content-type': source.mimeType,
		}, body: Uint8Array.from(source.bytes),
	});
	const upload: unknown = JSON.parse((await responseBytes(result, 64 * 1024, ctx.signal)).toString('utf8'));
	let file = mediaObject(mediaObject(upload).file);
	const resource = fileResource(mediaProperty(file, 'uri'), false);
	for (let attempt = 0; file.state === 'PROCESSING' && attempt < 30; attempt++) {
		await wait(1000, undefined, { signal: ctx.signal });
		file = mediaObject(await mediaJson(ctx, resource.href, undefined, headers(ctx)));
	}
	if (file.state !== 'ACTIVE') throw new Error('Google 未能处理参考文件。');
	return { type: source.mimeType.split('/')[0], uri: resource.href, mime_type: source.mimeType };
}

const videoFields: readonly MediaField[] = [
	{ key: 'aspect_ratio', label: ['视频画幅', 'Video aspect ratio'], choices: ['16:9', '9:16'] },
	{ key: 'resolution', label: ['输出分辨率', 'Output resolution'], choices: ['360p', '720p', '1080p', '4k'] },
	{ key: 'duration', label: ['时长（秒）', 'Duration (s)'], choices: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
];

async function googleVideo(ctx: MediaCall, edit: boolean): Promise<MediaResult> {
	const { duration, ...parameters } = ctx.options;
	const source = edit ? await googleUpload(ctx, mediaSource(ctx)) : ctx.source && inline(ctx.source);
	const reply = await mediaJson(ctx, ctx.endpoint, {
		model: ctx.model, background: true,
		input: source ? [source, text(ctx.prompt)] : ctx.prompt,
		response_format: { type: 'video', delivery: 'uri', ...parameters, ...(duration !== undefined && { duration: `${duration}s` }) },
	}, headers(ctx));
	return { id: mediaProperty(reply, 'id') };
}

const pollGoogleVideo: NonNullable<MediaAdapter['poll']> = async (ctx, id) => {
	const reply = mediaObject(await mediaJson(ctx, `${interactions}/${encodeURIComponent(id)}`, undefined, headers(ctx)));
	if (reply.status === 'failed' || reply.status === 'cancelled' || reply.status === 'incomplete') return { status: 'failed' };
	if (reply.status !== 'completed') return { status: reply.status === 'queued' ? 'queued' : 'running' };
	const video = outputParts(reply).find((part) => part.type === 'video');
	if (typeof video?.data === 'string') return { status: 'succeeded', result: { bytes: mediaBase64(video.data), extension: 'mp4' } };
	return { status: 'succeeded', result: await mediaBytes(ctx, fileResource(mediaProperty(video, 'uri'), true).href, 'mp4', headers(ctx)) };
};

const spokenVoices = ['Kore', 'Puck', 'Aoede', 'Charon', 'Zephyr', 'Leda', 'Fenrir', 'Orus', 'Autonoe', 'Callirrhoe'];

export const googleMedia: readonly MediaAdapter[] = [
	{ providerId: 'google', operation: 'image', models: imageModels, endpoint: () => interactions, fields: imageFields,
		run: (ctx) => googleImage(ctx, false) },
	{ providerId: 'google', operation: 'image-edit', models: imageModels, input: 'image', endpoint: () => interactions, fields: imageFields,
		run: (ctx) => googleImage(ctx, true) },
	{ providerId: 'google', operation: 'video', models: videoModels, input: 'image', endpoint: () => interactions, fields: videoFields,
		run: (ctx) => googleVideo(ctx, false), poll: pollGoogleVideo },
	{ providerId: 'google', operation: 'video-edit', models: videoModels, input: 'video', endpoint: () => interactions, fields: videoFields,
		run: (ctx) => googleVideo(ctx, true), poll: pollGoogleVideo },
	{
		providerId: 'google', operation: 'speech-synthesis', models: voiceModels, endpoint: () => interactions,
		fields: (model) => [{ key: 'voice', label: ['Gemini 音色', 'Gemini voice'], choices: spokenVoices, default: 'Kore' },
			...model.startsWith('gemini-3.8-') ? [{ key: 'style', label: ['朗读风格', 'Speech style'] as [string, string], type: 'string' as const }] : []],
		run: async (ctx) => {
			const { voice, style } = ctx.options;
			const reply = await mediaJson(ctx, ctx.endpoint, {
				model: ctx.model, store: false, response_format: { type: 'audio' },
				input: style ? [{ type: 'user_input', content: [{ ...text(ctx.prompt), annotations: [{ type: 'speech_metadata', style }] }] }] : ctx.prompt,
				generation_config: { speech_config: [{ voice: voice ?? 'Kore' }] },
			}, headers(ctx));
			const audio = outputParts(reply).find((part) => part.type === 'audio');
			const bytes = mediaBase64(mediaProperty(audio, 'data'));
			return bytes.toString('ascii', 0, 4) === 'RIFF' ? { bytes, extension: 'wav' } : { bytes, extension: 'pcm', sampleRate: 24000 };
		},
	},
	{
		providerId: 'google', operation: 'speech-recognition', models: ['gemini-3.5-transcribe'], input: 'audio', endpoint: () => interactions,
		fields: [
			{ key: 'language', label: ['语言代码（BCP 47）', 'Language code (BCP 47)'], type: 'string' },
			{ key: 'mode', label: ['转写模式', 'Transcription mode'], choices: ['verbatim', 'smart'], default: 'verbatim' },
			{ key: 'vocabulary', label: ['词汇提示（逗号分隔）', 'Vocabulary hints (comma-separated)'], type: 'string' },
		],
		run: async (ctx) => {
			const { language, mode, vocabulary } = ctx.options;
			const audio = await googleUpload(ctx, mediaSource(ctx));
			const reply = await mediaJson(ctx, ctx.endpoint, {
				model: `models/${ctx.model}`, input: [{ type: 'file', file_uri: audio.uri }], store: false,
				generation_config: { transcription_config: {
					mode: mode === 'smart' ? 'smart' : 'verbatim',
					...(language && { language_codes: [language] }),
					...(typeof vocabulary === 'string' && vocabulary.trim() && {
						custom_vocabulary: vocabulary.split(/[,，]/u).map((word) => word.trim()).filter(Boolean).slice(0, 1000),
					}),
				} },
			}, headers(ctx));
			const transcript = outputParts(reply).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
			if (!transcript) throw new Error('Google 未返回语音转写。');
			return { text: transcript };
		},
	},
];
