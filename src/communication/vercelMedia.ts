import { Buffer } from 'node:buffer';
import { mediaJson } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaField, MediaPoll } from './mediaApi';
import { base64Result, imageResult, mediaSource, seedField, transcriptResult } from './gatewayMediaFiles';

// One-shot and resumable endpoints used by the official AI Gateway SDK.
// https://github.com/vercel/ai/tree/main/packages/gateway/src
const api = 'https://ai-gateway.vercel.sh/v4/ai';
const providerId = 'vercel-ai-gateway';
const images = ['openai/gpt-image-2.6-flare', 'bfl/flux-3-image-klein'];
const grokVideo = 'spacexai/grok-imagine-video';
const imageToVideo = 'spacexai/grok-imagine-video-1.5';
const videoLite = 'spacexai/grok-imagine-video-1.5-lite';

function headers(ctx: MediaCall, modelKind: string) {
	return { 'ai-gateway-protocol-version': '0.0.1', 'ai-gateway-auth-method': 'api-key',
		'ai-model-id': ctx.model, [`ai-${modelKind}-model-specification-version`]: '4' };
}

function imageFields(model: string): readonly MediaField[] {
	if (model.startsWith('openai/')) return [
		{ key: 'size', label: ['图片尺寸', 'Image size'], choices: ['1024x1024', '1536x1024', '1024x1536'] },
		{ key: 'quality', label: ['质量', 'Quality'], choices: ['low', 'medium', 'high', 'xhigh', 'max'] },
		{ key: 'background', label: ['背景', 'Background'], choices: ['auto', 'transparent', 'opaque'] },
	];
	return [{ key: 'aspectRatio', label: ['宽高比', 'Aspect ratio'], choices: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] }, seedField];
}

function imageOptions(ctx: MediaCall) {
	const { quality, background, ...fields } = ctx.options;
	return { ...fields, ...((quality || background) && { providerOptions: { openai: { quality, background } } }) };
}

async function image(ctx: MediaCall) {
	const files = ctx.source ? [{ type: 'file', mediaType: ctx.source.mimeType, data: Buffer.from(ctx.source.bytes).toString('base64') }] : undefined;
	const result = await mediaJson<{ images?: unknown[] }>(ctx, ctx.endpoint,
		{ prompt: ctx.prompt, n: 1, ...imageOptions(ctx), files }, headers(ctx, 'image'));
	return imageResult(result.images?.[0]);
}

function videoFields(model: string): readonly MediaField[] {
	return [
		{ key: 'duration', label: ['时长（秒）', 'Duration (seconds)'], type: 'number', min: 1, max: 15 },
		{ key: 'resolution', label: ['分辨率', 'Resolution'], choices: model === videoLite ? ['854x480', '1280x720', '1920x1080'] : ['480p', '720p'] },
		{ key: 'aspectRatio', label: ['宽高比', 'Aspect ratio'], choices: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'] },
		...(model === videoLite ? [{ key: 'generateAudio', label: ['生成音轨', 'Generate audio'] as const, type: 'boolean' as const }] : []),
	];
}

function encodeOperation(operation: unknown) {
	// Gateway's opaque JSON is required verbatim for polling. Limit the record to a small token and discard malformed or media-bearing values.
	if (!operation || (typeof operation !== 'object' && typeof operation !== 'string')) throw new Error('服务未返回有效的视频任务。');
	const serialized = JSON.stringify(operation);
	if (Buffer.byteLength(serialized) > 3000 || /data:|https?:\/\//iu.test(serialized)) throw new Error('视频任务凭据无法安全保存。');
	return Buffer.from(serialized).toString('base64url');
}

async function video(ctx: MediaCall, edit = false) {
	if (edit && !ctx.sourceUrl) throw new Error('请明确提供要编辑的视频 HTTPS 地址。');
	const source = !edit && ctx.model === imageToVideo ? mediaSource(ctx) : ctx.source;
	const { resolution, ...options } = ctx.options;
	const providerOptions = edit ? { xai: { mode: 'edit-video', videoUrl: ctx.sourceUrl } }
		: resolution && ctx.model !== videoLite ? { xai: { resolution } } : undefined;
	const image = source ? { type: 'file', mediaType: source.mimeType, data: Buffer.from(source.bytes).toString('base64') } : undefined;
	const result = await mediaJson<{ operation?: unknown }>(ctx, ctx.endpoint,
		{ prompt: ctx.prompt, n: 1, ...options, ...(ctx.model === videoLite && { resolution }), providerOptions, image }, headers(ctx, 'video'));
	return { id: encodeOperation(result.operation) };
}

async function poll(ctx: MediaCall, id: string): Promise<MediaPoll> {
	if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(id)) throw new Error('无效的视频任务。');
	const operation: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
	if (encodeOperation(operation) !== id) throw new Error('无效的视频任务。');
	const result = await mediaJson<{
		status?: string; videos?: { type?: string; data?: string; url?: string }[];
	}>(ctx, `${api}/video-model/status`, { operation }, headers(ctx, 'video'));
	if (result.status === 'pending') return { status: 'running' };
	if (result.status === 'completed') {
		const first = result.videos?.[0];
		if (first?.type === 'url' && first.url) return { status: 'succeeded', result: { url: first.url, extension: 'mp4' } };
		if (first?.type === 'base64') return { status: 'succeeded', result: base64Result(first.data, 'mp4') };
	}
	return { status: 'failed' };
}

async function speech(ctx: MediaCall) {
	const result = await mediaJson<{ audio?: unknown }>(ctx, ctx.endpoint,
		{ text: ctx.prompt, ...ctx.options, outputFormat: 'mp3' }, headers(ctx, 'speech'));
	return base64Result(result.audio, 'mp3');
}

async function transcribe(ctx: MediaCall) {
	const source = mediaSource(ctx);
	const result = await mediaJson<{ text?: unknown }>(ctx, ctx.endpoint,
		{ audio: Buffer.from(source.bytes).toString('base64'), mediaType: source.mimeType }, headers(ctx, 'transcription'));
	return transcriptResult(result.text);
}

export const vercelMedia: readonly MediaAdapter[] = [
	{ providerId, operation: 'image', models: images, endpoint: () => `${api}/image-model`, fields: imageFields, run: image },
	{ providerId, operation: 'image-edit', models: images, endpoint: () => `${api}/image-model`, input: 'image', fields: imageFields, run: image },
	{ providerId, operation: 'video', models: [grokVideo, videoLite], endpoint: () => `${api}/video-model/start`, input: 'image', fields: videoFields, run: video, poll },
	{ providerId, operation: 'video', models: [imageToVideo], endpoint: () => `${api}/video-model/start`,
		input: 'image', requiresSource: true, fields: videoFields, run: video, poll },
	{ providerId, operation: 'video-edit', models: [grokVideo], endpoint: () => `${api}/video-model/start`, input: 'video-url', run: (ctx) => video(ctx, true), poll },
	{ providerId, operation: 'speech-recognition', models: ['openai/whisper-1', 'openai/gpt-4o-transcribe', 'openai/gpt-4o-mini-transcribe'],
		endpoint: () => `${api}/transcription-model`, input: 'audio', run: transcribe },
	{ providerId, operation: 'speech-synthesis', models: ['mistral/voxtral-mini-tts-3'], endpoint: () => `${api}/speech-model`,
		fields: [{ key: 'voice', label: ['音色 ID', 'Voice ID'], type: 'string', default: 'en_paul_neutral' }], run: speech },
];
