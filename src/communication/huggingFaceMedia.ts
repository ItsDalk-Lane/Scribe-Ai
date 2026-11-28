import { mediaDataUrl, mediaJson } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaExtension, MediaField, MediaOutput, MediaPoll } from './mediaApi';
import { imageBytesResult, imageResult, mediaReplyBytes, mediaReplyJson, mediaSource, postMedia,
	seedField, sourceBlob, transcriptResult, videoJobId } from './gatewayMediaFiles';

// Only routes with live Hub inference-provider mappings can be called using a Hugging Face token.
// https://github.com/huggingface/huggingface.js/tree/main/packages/inference/src/providers
const router = 'https://router.huggingface.co';
const providerId = 'huggingface';
const diffusion = 'stabilityai/stable-diffusion-3-medium-diffusers';
const flux = 'black-forest-labs/FLUX.2-dev';
const wan = 'Wan-AI/Wan2.2-TI2V-5B';
const chatterbox = 'ResembleAI/chatterbox';

const sizeFields: readonly MediaField[] = [
	{ key: 'width', label: ['像素宽度', 'Width in pixels'], choices: [512, 768, 1024, 1280, 1536] },
	{ key: 'height', label: ['像素高度', 'Height in pixels'], choices: [512, 768, 1024, 1280, 1536] },
];
const formatField: MediaField = { key: 'output_format', label: ['输出格式', 'Output format'], choices: ['jpeg', 'png', 'webp'] };

function nativeEndpoint({ model }: { model: string }) { return `${router}/hf-inference/models/${model}`; }

async function nativeImage(ctx: MediaCall) {
	const response = await postMedia(ctx, { inputs: ctx.prompt, parameters: ctx.options });
	if (response.headers.get('content-type')?.includes('application/json')) {
		const data = await mediaReplyJson<{ data?: { b64_json?: string }[]; output?: string[] }>(response, ctx.signal);
		if (data.output?.[0]) return { url: data.output[0], extension: 'jpg' as const };
		return imageResult(data.data?.[0]?.b64_json);
	}
	const { bytes } = await mediaReplyBytes(response, 'jpg', ctx.signal);
	return imageBytesResult(bytes);
}

async function nativeTranscribe(ctx: MediaCall) {
	const source = mediaSource(ctx);
	const response = await postMedia(ctx, sourceBlob(source), { 'Content-Type': source.mimeType });
	const result = await mediaReplyJson<{ text?: string }>(response, ctx.signal);
	return transcriptResult(result.text);
}

const falRoute = (path: string, queue = false) => `${router}/fal-ai/${path}${queue ? '?_subdomain=queue' : ''}`;
const falWanPath = 'fal-ai/wan/v2.2-5b/text-to-video';

type FalOutput = {
	images?: { url?: string; content_type?: string }[];
	video?: { url?: string };
	audio?: { url?: string };
};
function falFile(url: string | undefined, extension: MediaExtension): MediaOutput {
	if (!url) throw new Error('服务未返回媒体文件地址。');
	return { url, extension };
}

async function submitWan(ctx: MediaCall) {
	const result = await mediaJson<{ request_id?: string; response_url?: string }>(ctx, ctx.endpoint, { prompt: ctx.prompt, ...ctx.options });
	const id = videoJobId(result.request_id);
	const resultUrl = new URL(result.response_url ?? '');
	const match = /^(\/fal-ai\/wan(?:\/[a-zA-Z0-9_-]+){0,4}\/requests\/)\w[\w-]*$/u.exec(resultUrl.pathname);
	if (resultUrl.origin !== 'https://queue.fal.run' || resultUrl.search || resultUrl.hash
		|| !match || resultUrl.pathname !== match[1] + id) {
		throw new Error('服务未返回可查询的任务地址。');
	}
	const route = resultUrl.pathname.slice('/fal-ai/wan/'.length, -id.length);
	return { id: route === 'requests/' ? id : `${route.slice(0, -'/requests/'.length).replaceAll('/', '.')}.${id}` };
}

async function pollWan(ctx: MediaCall, id: string): Promise<MediaPoll> {
	const parts = id.split('.');
	const request = videoJobId(parts.pop());
	if (parts.length > 4 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) throw new Error('无效的视频任务。');
	const path = ['fal-ai/wan', ...parts, 'requests', request].join('/');
	const result = await mediaJson<{ status?: string }>(ctx, falRoute(`${path}/status`, true));
	if (result.status === 'IN_QUEUE') return { status: 'queued' };
	if (result.status === 'IN_PROGRESS') return { status: 'running' };
	if (result.status !== 'COMPLETED') return { status: 'failed' };
	const output = await mediaJson<FalOutput>(ctx, falRoute(path, true));
	return output.video?.url ? { status: 'succeeded', result: falFile(output.video.url, 'mp4') } : { status: 'failed' };
}

async function editFlux(ctx: MediaCall) {
	const result = await mediaJson<FalOutput>(ctx, ctx.endpoint, {
		prompt: ctx.prompt, ...ctx.options, image_urls: [mediaDataUrl(mediaSource(ctx))],
	});
	const first = result.images?.[0];
	const format = first?.content_type ?? ctx.options.output_format;
	return falFile(first?.url, format === 'image/webp' || format === 'webp' ? 'webp'
		: format === 'image/png' || format === 'png' ? 'png' : 'jpg');
}

async function speakFal(ctx: MediaCall) {
	const result = await mediaJson<FalOutput>(ctx, ctx.endpoint, { text: ctx.prompt, ...ctx.options });
	return falFile(result.audio?.url, 'wav');
}

export const huggingFaceMedia: readonly MediaAdapter[] = [
	{ providerId, operation: 'image', models: [diffusion], endpoint: nativeEndpoint, run: nativeImage, fields: [
		...sizeFields, { key: 'guidance_scale', label: ['提示词引导强度', 'Guidance scale'], type: 'number', min: 0, max: 30 },
		{ key: 'negative_prompt', label: ['负向提示词', 'Negative prompt'], type: 'string' }, seedField,
	] },
	{ providerId, operation: 'image-edit', models: [flux], endpoint: () => falRoute('fal-ai/flux-2/edit'),
		input: 'image', fields: [formatField, seedField], run: editFlux },
	{ providerId, operation: 'video', models: [wan], endpoint: () => falRoute(falWanPath, true),
		fields: [
			{ key: 'resolution', label: ['分辨率', 'Resolution'], choices: ['580p', '720p'] },
			{ key: 'aspect_ratio', label: ['宽高比', 'Aspect ratio'], choices: ['16:9', '9:16', '1:1'] },
			{ key: 'num_frames', label: ['帧数', 'Frame count'], type: 'number', min: 17, max: 161 },
			{ key: 'frames_per_second', label: ['每秒帧数', 'Frames per second'], type: 'number', min: 4, max: 60 }, seedField,
		], run: submitWan, poll: pollWan },
	{ providerId, operation: 'speech-synthesis', models: [chatterbox], endpoint: () => falRoute('fal-ai/chatterbox/text-to-speech'),
		fields: [{ key: 'exaggeration', label: ['语气表现强度', 'Expressiveness'], type: 'number', min: 0, max: 1 }, seedField], run: speakFal },
	{ providerId, operation: 'speech-recognition', models: ['openai/whisper-large-v3', 'openai/whisper-large-v3-turbo'],
		endpoint: nativeEndpoint, input: 'audio', run: nativeTranscribe },
];
