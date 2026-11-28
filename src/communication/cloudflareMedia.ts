import { Buffer } from 'node:buffer';
import { mediaDataUrl, mediaJson } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaField, MediaRoute } from './mediaApi';
import { imageResult, languageField, mediaReplyBytes, mediaReplyJson, mediaSource, postMedia, seedField, sourceBlob, transcriptResult } from './gatewayMediaFiles';

const gateway = 'cloudflare-ai-gateway';
const workers = 'cloudflare-workers-ai';

// Accept the official account URL and the account/gateway URL already used by the chat configuration.
function accountRoute({ baseUrl }: MediaRoute) {
	const url = baseUrl && URL.parse(baseUrl);
	const account = url && url.protocol === 'https:' && !url.username && !url.password && !url.port
		? (url.hostname === 'api.cloudflare.com' ? /^\/client\/v4\/accounts\/([a-f\d]{32})\/ai(?:\/|$)/iu.exec(url.pathname)?.[1]
			: url.hostname === 'gateway.ai.cloudflare.com' ? /^\/v1\/([a-f\d]{32})(?:\/|$)/iu.exec(url.pathname)?.[1] : undefined)
		: undefined;
	if (!account) throw new Error('请在 Cloudflare 服务商的 API 地址中填写官方账户地址。');
	return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`;
}

function workersRoute(route: MediaRoute) {
	return `${accountRoute(route)}/${route.model}`;
}

function gatewayHeaders(ctx: MediaCall): Record<string, string> {
	const url = ctx.baseUrl && URL.parse(ctx.baseUrl);
	const gatewayId = url && url.hostname === 'gateway.ai.cloudflare.com' ? /^\/v1\/[a-f\d]{32}\/([a-z\d_-]+)(?:\/|$)/iu.exec(url.pathname)?.[1] : undefined;
	return gatewayId ? { 'cf-aig-gateway-id': gatewayId } : {};
}

function pixels(min: number, max: number): readonly MediaField[] {
	return [{ key: 'width', label: ['宽度（像素）', 'Width (pixels)'], type: 'number', min, max },
		{ key: 'height', label: ['高度（像素）', 'Height (pixels)'], type: 'number', min, max }];
}

async function fluxImage(ctx: MediaCall) {
	const params = new FormData();
	params.append('prompt', ctx.prompt);
	for (const [key, value] of Object.entries(ctx.options)) params.append(key, String(value));
	if (ctx.source) params.append('input_image_0', sourceBlob(ctx.source), ctx.source.filename);
	// FLUX.2 accepts multipart only on the native Workers AI endpoint.
	const response = await postMedia(ctx, params, gatewayHeaders(ctx));
	const body = await mediaReplyJson<{ result?: { image?: unknown } }>(response, ctx.signal);
	return imageResult(body.result?.image);
}

async function gatewayImage(ctx: MediaCall) {
	const result = await mediaJson<{ result?: { image?: unknown } }>(ctx, ctx.endpoint, { model: ctx.model,
		input: { prompt: ctx.prompt, output_format: 'png', ...ctx.options, ...(ctx.source && { input_images: [mediaDataUrl(ctx.source)] }) },
	}, gatewayHeaders(ctx));
	if (typeof result.result?.image !== 'string') throw new Error('服务未返回图片。');
	const extension = ctx.options.output_format === 'jpeg' ? 'jpg' : ctx.options.output_format === 'webp' ? 'webp' : 'png';
	return { url: result.result.image, extension } as const;
}

async function video(ctx: MediaCall, edit = false) {
	const asset = edit ? { video_uri: mediaDataUrl(mediaSource(ctx)) } : ctx.source ? { image_input: mediaDataUrl(ctx.source) } : {};
	const result = await mediaJson<{ result?: { video?: unknown } }>(ctx, ctx.endpoint,
		{ model: ctx.model, input: { prompt: ctx.prompt, ...ctx.options, ...asset } }, gatewayHeaders(ctx));
	if (typeof result.result?.video !== 'string') throw new Error('服务未返回视频。');
	return { url: result.result.video, extension: 'mp4' as const };
}

async function transcribe(ctx: MediaCall) {
	const source = mediaSource(ctx);
	const result = await mediaJson<{ result?: { text?: unknown } }>(ctx, ctx.endpoint,
		{ audio: Buffer.from(source.bytes).toString('base64'), ...ctx.options }, gatewayHeaders(ctx));
	return transcriptResult(result.result?.text);
}

async function speech(ctx: MediaCall) {
	const response = await postMedia(ctx, { text: ctx.prompt, ...ctx.options, encoding: 'mp3' }, gatewayHeaders(ctx));
	return mediaReplyBytes(response, 'mp3', ctx.signal);
}

export const cloudflareMedia: readonly MediaAdapter[] = [
	...([gateway, workers].flatMap((providerId): MediaAdapter[] => [
		...(['image', 'image-edit'] as const).map((operation): MediaAdapter => ({
			providerId, operation, models: ['@cf/black-forest-labs/flux-2-klein-4b', '@cf/black-forest-labs/flux-2-klein-9b'], endpoint: workersRoute,
			fields: [...pixels(256, 1920), { key: 'guidance', label: ['提示词引导强度', 'Guidance scale'], type: 'number' }, seedField],
			...(operation === 'image-edit' && { input: 'image' }), run: fluxImage,
		})),
		{ providerId, operation: 'speech-recognition', models: ['@cf/openai/whisper-large-v3-turbo'], endpoint: workersRoute, input: 'audio',
			fields: [languageField, { key: 'vad_filter', label: ['跳过静音', 'Filter silence'], type: 'boolean' },
				{ key: 'beam_size', label: ['解码候选数', 'Beam size'], type: 'number', min: 1, max: 10 }], run: transcribe },
		{ providerId, operation: 'speech-synthesis', models: ['@cf/deepgram/aura-2-en'], endpoint: workersRoute,
			fields: [{ key: 'speaker', label: ['说话人', 'Speaker'], choices: ['luna', 'athena', 'orion', 'asteria', 'zeus', 'pandora'], default: 'luna' }], run: speech },
	])),
	...(['image', 'image-edit'] as const).map((operation): MediaAdapter => ({
		providerId: gateway, operation, models: ['black-forest-labs/flux-2-pro-preview'], endpoint: accountRoute,
		fields: [...pixels(64, 4096), seedField, { key: 'output_format', label: ['图片格式', 'Image format'], choices: ['png', 'jpeg', 'webp'] }],
		...(operation === 'image-edit' && { input: 'image' }), run: gatewayImage,
	})),
	{ providerId: gateway, operation: 'video', models: ['runwayml/gen-4.5'], endpoint: accountRoute,
		fields: [{ key: 'ratio', label: ['视频尺寸', 'Video size'], choices: ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672'], default: '1280:720' },
			{ key: 'duration', label: ['时长（秒）', 'Duration (seconds)'], type: 'number', min: 2, max: 10, default: 5 }, seedField], run: video },
	{ providerId: gateway, operation: 'video-edit', models: ['runwayml/aleph-2'], endpoint: accountRoute, input: 'video', fields: [seedField], run: (ctx) => video(ctx, true) },
];
