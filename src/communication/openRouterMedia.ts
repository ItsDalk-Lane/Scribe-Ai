import { Buffer } from 'node:buffer';
import { mediaBytes, mediaDataUrl, mediaJson } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaField, MediaPoll } from './mediaApi';
import { imageResult, languageField, mediaReplyBytes, mediaSource, postMedia, seedField, transcriptResult, videoJobId } from './gatewayMediaFiles';

const api = 'https://openrouter.ai/api/v1';
const imageModels = ['black-forest-labs/flux-3-image-klein', 'google/gemini-3.1-flash-image', 'openai/gpt-image-2.6-flare'];
const videoModels = ['x-ai/grok-imagine-video', 'google/veo-3.1-fast', 'bytedance/seedance-2.0'];
const outputFormat = (choices: readonly string[]): MediaField => ({ key: 'output_format', label: ['图片格式', 'Image format'], choices });
const ratio = (choices: readonly string[]): MediaField => ({ key: 'aspect_ratio', label: ['宽高比', 'Aspect ratio'], choices });
const resolution = (choices: readonly string[]): MediaField => ({ key: 'resolution', label: ['分辨率', 'Resolution'], choices });

// OpenRouter publishes an independent image model catalogue with fields specific to each model.
function imageFields(model: string): readonly MediaField[] {
	if (model.startsWith('google/')) return [resolution(['512', '1K', '2K', '4K']), ratio(['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'])];
	if (model.startsWith('openai/')) return [ratio(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9']), outputFormat(['png', 'jpeg', 'webp']),
		{ key: 'quality', label: ['质量', 'Quality'], choices: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
		{ key: 'background', label: ['背景', 'Background'], choices: ['auto', 'transparent', 'opaque'] }];
	return [resolution(['768', '1K', '1.5K', '2K', '4K']), ratio(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9']), outputFormat(['jpeg', 'png']), seedField];
}

async function image(ctx: MediaCall) {
	const references = ctx.source ? [{ type: 'image_url', image_url: { url: mediaDataUrl(ctx.source) } }] : undefined;
	const result = await mediaJson<{ data?: { b64_json?: unknown }[] }>(ctx, ctx.endpoint, {
		model: ctx.model, prompt: ctx.prompt, ...ctx.options, response_format: 'b64_json', ...(references && { input_references: references }),
	});
	return imageResult(result.data?.[0]?.b64_json);
}

function videoFields(model: string): readonly MediaField[] {
	const duration = (choices: readonly number[]): MediaField => ({ key: 'duration', label: ['时长（秒）', 'Duration (seconds)'], choices });
	const sound: MediaField = { key: 'generate_audio', label: ['生成音轨', 'Generate audio'], type: 'boolean' };
	if (model.startsWith('google/')) return [resolution(['720p', '1080p', '4K']), ratio(['16:9', '9:16']), duration([4, 6, 8]), sound, seedField];
	if (model.startsWith('bytedance/')) return [resolution(['480p', '720p', '1080p', '4K']), ratio(['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21']),
		{ key: 'duration', label: ['时长（秒）', 'Duration (seconds)'], type: 'number', min: 4, max: 15 }, sound, seedField];
	return [resolution(['480p', '720p']), ratio(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']),
		{ key: 'duration', label: ['时长（秒）', 'Duration (seconds)'], type: 'number', min: 1, max: 15 }];
}

async function video(ctx: MediaCall, edit = false) {
	if (edit && !ctx.sourceUrl) throw new Error('请在当轮消息中明确提供已有视频的 HTTPS 地址。');
	const references = edit ? [{ type: 'video_url', video_url: { url: ctx.sourceUrl } }] : undefined;
	const result = await mediaJson<{ id?: unknown }>(ctx, ctx.endpoint, { model: ctx.model, prompt: ctx.prompt, ...ctx.options,
		...(references && { input_references: references }),
		...(!edit && ctx.source && { frame_images: [{ frame_type: 'first_frame', image_url: { url: mediaDataUrl(ctx.source) } }] }),
	});
	return { id: videoJobId(result.id) };
}

async function poll(ctx: MediaCall, id: string): Promise<MediaPoll> {
	const url = `${api}/videos/${videoJobId(id)}`;
	const result = await mediaJson<{ status?: string; urls?: string[] }>(ctx, url);
	if (result.status === 'pending') return { status: 'queued' };
	if (result.status === 'in_progress') return { status: 'running' };
	if (result.status === 'completed') {
		const first = result.urls?.[0];
		return { status: 'succeeded', result: first ? { url: first, extension: 'mp4' } : await mediaBytes(ctx, `${url}/content`, 'mp4') };
	}
	return { status: 'failed' };
}

function speechFields(model: string): readonly MediaField[] {
	return model.startsWith('x-ai/') ? [
		{ key: 'voice', label: ['声音', 'Voice'], choices: ['eve', 'ara', 'rex', 'sal', 'leo'], default: 'eve' },
	] : [{ key: 'voice', label: ['音色 ID', 'Voice ID'], type: 'string', default: 'en_paul_neutral' }];
}

async function speech(ctx: MediaCall) {
	const response = await postMedia(ctx, { model: ctx.model, input: ctx.prompt, ...ctx.options, response_format: 'mp3' });
	return mediaReplyBytes(response, 'mp3', ctx.signal);
}

async function transcribe(ctx: MediaCall) {
	const source = mediaSource(ctx);
	const format = source.filename.split('.').at(-1)?.toLowerCase();
	if (!format || !['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac'].includes(format)) throw new Error('请选择此接口支持的音频格式。');
	const result = await mediaJson<{ text?: unknown }>(ctx, ctx.endpoint, { model: ctx.model,
		input_audio: { data: Buffer.from(source.bytes).toString('base64'), format }, ...ctx.options });
	return transcriptResult(result.text);
}

export const openRouterMedia: readonly MediaAdapter[] = [
	{ providerId: 'openrouter', operation: 'image', models: imageModels, endpoint: () => `${api}/images`, fields: imageFields, run: image },
	{ providerId: 'openrouter', operation: 'image-edit', models: imageModels, endpoint: () => `${api}/images`, fields: imageFields, input: 'image', run: image },
	{ providerId: 'openrouter', operation: 'video', models: videoModels, endpoint: () => `${api}/videos`, fields: videoFields, run: video, poll },
	{ providerId: 'openrouter', operation: 'video-edit', models: ['black-forest-labs/flux-video-edit'], endpoint: () => `${api}/videos`, input: 'video-url', run: (ctx) => video(ctx, true), poll },
	{ providerId: 'openrouter', operation: 'speech-synthesis', models: ['mistralai/voxtral-mini-tts-2603', 'x-ai/grok-voice-tts-1.0'], endpoint: () => `${api}/audio/speech`, fields: speechFields, run: speech },
	{ providerId: 'openrouter', operation: 'speech-recognition', models: ['openai/whisper-1', 'openai/gpt-4o-transcribe'], endpoint: () => `${api}/audio/transcriptions`, fields: [languageField], input: 'audio', run: transcribe },
];
