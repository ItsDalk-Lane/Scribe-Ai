import { mediaJson } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaField, MediaPoll } from './mediaApi';
import { imageResult, languageField, mediaReplyBytes, mediaReplyJson, mediaSource, postMedia, ratioField, seedField, sourceBlob, transcriptResult, videoJobId } from './gatewayMediaFiles';

const api = 'https://api.together.ai';
const providerId = 'together';
const flux = 'black-forest-labs/FLUX.2-pro';
const kontext = 'black-forest-labs/FLUX.1-kontext-pro';

function imageFields(model: string): readonly MediaField[] {
	return model === kontext ? [ratioField, seedField] : [
		{ key: 'width', label: ['宽度（像素）', 'Width (pixels)'], type: 'number', min: 256, max: 2048 },
		{ key: 'height', label: ['高度（像素）', 'Height (pixels)'], type: 'number', min: 256, max: 2048 }, seedField,
	];
}

async function image(ctx: MediaCall) {
	const reference = ctx.sourceUrl ? (ctx.model === kontext ? { image_url: ctx.sourceUrl } : { reference_images: [ctx.sourceUrl] }) : {};
	const result = await mediaJson<{ data?: { b64_json?: unknown }[] }>(ctx, ctx.endpoint,
		{ model: ctx.model, prompt: ctx.prompt, ...ctx.options, response_format: 'base64', ...reference });
	return imageResult(result.data?.[0]?.b64_json);
}

async function video(ctx: MediaCall, edit = false) {
	if (edit && !ctx.sourceUrl) throw new Error('请明确提供要编辑的视频 HTTPS 地址。');
	const { seconds, ...fields } = ctx.options;
	const result = await mediaJson<{ id?: unknown }>(ctx, ctx.endpoint, { model: ctx.model, prompt: ctx.prompt, ...fields,
		...(seconds !== undefined && { seconds: String(seconds) }), ...(edit && { media: { source_video: ctx.sourceUrl } }),
	});
	return { id: videoJobId(result.id) };
}

async function poll(ctx: MediaCall, id: string): Promise<MediaPoll> {
	const result = await mediaJson<{ status?: string; outputs?: { video_url?: string } }>(ctx, `${api}/v2/videos/${videoJobId(id)}`);
	if (result.status === 'queued') return { status: 'queued' };
	if (result.status === 'in_progress') return { status: 'running' };
	if (result.status === 'completed' && result.outputs?.video_url) return { status: 'succeeded', result: { url: result.outputs.video_url, extension: 'mp4' } };
	return { status: 'failed' };
}

async function speech(ctx: MediaCall) {
	const format = ctx.options.response_format === 'wav' ? 'wav' : 'mp3';
	const response = await postMedia(ctx, { model: ctx.model, input: ctx.prompt, ...ctx.options, response_format: format });
	return mediaReplyBytes(response, format, ctx.signal);
}

async function transcribe(ctx: MediaCall) {
	const source = mediaSource(ctx);
	const params = new FormData();
	params.set('file', sourceBlob(source), source.filename);
	params.set('model', ctx.model);
	for (const [key, value] of Object.entries(ctx.options)) params.set(key, String(value));
	const result = await mediaReplyJson<{ text?: unknown }>(await postMedia(ctx, params), ctx.signal);
	return transcriptResult(result.text);
}

export const togetherMedia: readonly MediaAdapter[] = [
	{ providerId, operation: 'image', models: [flux, kontext], endpoint: () => `${api}/v1/images/generations`, fields: imageFields, run: image },
	{ providerId, operation: 'image-edit', models: [flux, kontext], endpoint: () => `${api}/v1/images/generations`, input: 'image-url', fields: imageFields, run: image },
	{ providerId, operation: 'video', models: ['Wan-AI/wan2.7-t2v'], endpoint: () => `${api}/v2/videos`, fields: [
		{ key: 'resolution', label: ['分辨率', 'Resolution'], choices: ['720P', '1080P'] },
		{ key: 'ratio', label: ['宽高比', 'Aspect ratio'], choices: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
		{ key: 'seconds', label: ['时长（秒）', 'Duration (seconds)'], type: 'number', min: 2, max: 15 },
	], run: video, poll },
	{ providerId, operation: 'video-edit', models: ['Wan-AI/wan2.7-videoedit'], endpoint: () => `${api}/v2/videos`, input: 'video-url', run: (ctx) => video(ctx, true), poll },
	{ providerId, operation: 'speech-synthesis', models: ['canopylabs/orpheus-3b-0.1-ft', 'hexgrad/Kokoro-82M'], endpoint: () => `${api}/v1/audio/speech`,
		fields: (model) => model.startsWith('hexgrad/') ? [
			{ key: 'voice', label: ['音色 ID', 'Voice ID'], type: 'string', default: 'af_heart' },
			{ key: 'response_format', label: ['输出格式', 'Output format'], choices: ['mp3', 'wav'], default: 'mp3' },
		] : [{ key: 'voice', label: ['音色', 'Voice'], choices: ['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'], default: 'tara' }], run: speech },
	{ providerId, operation: 'speech-recognition', models: ['openai/whisper-large-v3'], endpoint: () => `${api}/v1/audio/transcriptions`, input: 'audio', fields: [languageField], run: transcribe },
];
