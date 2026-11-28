import { Buffer } from 'node:buffer';
import { mediaJson } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaField, MediaResult, MediaRoute } from './mediaApi';
import {
	appendMediaOptions, directFormJson, directPostAudio, mediaBase64, mediaImageResult, mediaItems, mediaObject, mediaPart, mediaProperty,
	mediaSource, mediaTranscript,
} from './mediaDirectHttp';
import { gptImageFields, gptImageModels } from './mediaOpenAi';

const azureDeployment: MediaField = { key: 'deployment', label: ['Azure 部署名称', 'Azure deployment name'], type: 'string' };
const azureHeaders = (ctx: MediaCall) => ({ 'api-key': ctx.key });
const deployment = (ctx: MediaCall) => ctx.options.deployment ?? ctx.model;

function azureEndpoint(path: string) {
	return ({ baseUrl }: MediaRoute) => {
		const url = baseUrl && URL.parse(baseUrl);
		if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
			|| !/^[a-z0-9-]+\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/iu.test(url.hostname)) {
			throw new Error('请先在服务商设置里填写 Azure OpenAI 资源 HTTPS Base URL。');
		}
		return `${url.origin}/openai/v1/${path}?api-version=preview`;
	};
}

async function azureImage(ctx: MediaCall, edit: boolean): Promise<MediaResult> {
	const options = { ...ctx.options };
	delete options.deployment;
	const { output_format } = options;
	const input = { model: deployment(ctx), prompt: ctx.prompt, n: 1, ...options };
	let reply: unknown;
	if (edit) {
		const form = new FormData();
		mediaPart(form, 'image[]', mediaSource(ctx));
		appendMediaOptions(form, input);
		reply = await directFormJson(ctx, form, azureHeaders(ctx));
	} else reply = await mediaJson(ctx, ctx.endpoint, input, azureHeaders(ctx));
	return mediaImageResult(reply, output_format === 'jpeg' ? 'jpg' : output_format === 'webp' ? 'webp' : 'png');
}

const azureMedia: readonly MediaAdapter[] = [
	{ providerId: 'azure', operation: 'image', models: gptImageModels, endpoint: azureEndpoint('images/generations'),
		fields: (model) => [azureDeployment, ...gptImageFields(model)], run: (ctx) => azureImage(ctx, false) },
	{ providerId: 'azure', operation: 'image-edit', models: gptImageModels, input: 'image', endpoint: azureEndpoint('images/edits'),
		fields: (model) => [azureDeployment, ...gptImageFields(model, true)], run: (ctx) => azureImage(ctx, true) },
	{
		providerId: 'azure', operation: 'speech-synthesis', models: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'], endpoint: azureEndpoint('audio/speech'),
		fields: (model) => [
			azureDeployment, { key: 'voice', label: ['Azure OpenAI 音色', 'Azure OpenAI voice'], type: 'string', default: 'alloy' },
			{ key: 'response_format', label: ['音频封装', 'Audio container'], choices: ['mp3', 'wav', 'flac'], default: 'mp3' },
			{ key: 'speed', label: ['语速倍率', 'Speaking speed'], type: 'number', min: 0.25, max: 4 },
			...model === 'gpt-4o-mini-tts' ? [{ key: 'instructions', label: ['朗读风格', 'Voice instructions'] as [string, string], type: 'string' as const }] : [],
		],
		run: (ctx) => {
			const options = { ...ctx.options };
			delete options.deployment;
			const extension = options.response_format === 'wav' || options.response_format === 'flac' ? options.response_format : 'mp3';
			return directPostAudio(ctx, { model: deployment(ctx), input: ctx.prompt, voice: 'alloy', ...options }, extension, undefined, azureHeaders(ctx));
		},
	},
	{
		providerId: 'azure', operation: 'speech-recognition', models: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
		input: 'audio', endpoint: azureEndpoint('audio/transcriptions'),
		fields: [azureDeployment, { key: 'language', label: ['识别语言代码', 'Recognition language code'], type: 'string' },
			{ key: 'prompt', label: ['术语识别提示', 'Transcription vocabulary prompt'], type: 'string' }],
		run: async (ctx) => {
			const options = { ...ctx.options };
			delete options.deployment;
			const form = new FormData();
			mediaPart(form, 'file', mediaSource(ctx));
			appendMediaOptions(form, { model: deployment(ctx), response_format: 'json', ...options });
			return mediaTranscript(await directFormJson(ctx, form, azureHeaders(ctx)));
		},
	},
];

const vertexHost = 'https://aiplatform.googleapis.com';
const vertexImageModels = ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];

function vertexEndpoint({ baseUrl, model }: MediaRoute): string {
	if (baseUrl) {
		const url = URL.parse(baseUrl);
		if (!url || url.origin !== vertexHost || url.username || url.password) throw new Error('当前 Vertex 图片适配要求使用全球 Express 端点及 Express API Key。');
	}
	return `${vertexHost}/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

async function vertexImage(ctx: MediaCall, edit: boolean): Promise<MediaResult> {
	const source = edit && mediaSource(ctx);
	const reply = await mediaJson(ctx, ctx.endpoint, {
		contents: [{ role: 'user', parts: [{ text: ctx.prompt }, ...source ? [{
			inlineData: { mimeType: source.mimeType, data: Buffer.from(source.bytes).toString('base64') },
		}] : []] }],
		generationConfig: { responseModalities: ['IMAGE'], ...(Object.keys(ctx.options).length && { imageConfig: ctx.options }) },
	}, { 'x-goog-api-key': ctx.key });
	const parts = mediaItems(mediaObject(reply).candidates).flatMap((candidate) => mediaItems(mediaObject(mediaObject(candidate).content).parts));
	const image = mediaObject(parts.find((part) => Boolean(mediaObject(part).inlineData)));
	const inline = mediaObject(image.inlineData);
	return { bytes: mediaBase64(mediaProperty(inline, 'data')), extension: inline.mimeType === 'image/jpeg' ? 'jpg' : 'png' };
}

function vertexFields(model: string): MediaField[] {
	const nextGeneration = model !== 'gemini-2.5-flash-image';
	const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
	const output: MediaField[] = [{ key: 'aspectRatio', label: ['生成画幅', 'Generated aspect ratio'],
		choices: nextGeneration ? [...ratios, '1:4', '4:1', '1:8', '8:1'] : ratios }];
	if (nextGeneration) output.push({ key: 'imageSize', label: ['图片分辨率', 'Image resolution'],
		choices: model === 'gemini-3.1-flash-image' ? ['512', '1K', '2K', '4K'] : ['1K', '2K', '4K'] });
	return output;
}

const vertexMedia: readonly MediaAdapter[] = [
	{ providerId: 'google-vertex', operation: 'image', models: vertexImageModels, endpoint: vertexEndpoint,
		fields: vertexFields, run: (ctx) => vertexImage(ctx, false) },
	{ providerId: 'google-vertex', operation: 'image-edit', models: vertexImageModels, input: 'image', endpoint: vertexEndpoint,
		fields: vertexFields, run: (ctx) => vertexImage(ctx, true) },
];

function bedrockEndpoint({ baseUrl, model }: MediaRoute): string {
	const endpoint = URL.parse(baseUrl || 'https://bedrock-runtime.us-west-2.amazonaws.com');
	if (!endpoint || endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password
		|| !/^bedrock-runtime\.[a-z]{2}(?:-gov)?-[a-z]+-\d\.amazonaws\.com$/iu.test(endpoint.hostname)) {
		throw new Error('请在服务商设置里填写 AWS Bedrock 官方区域运行时地址。');
	}
	return `${endpoint.origin}/model/${encodeURIComponent(model)}/invoke`;
}

const bedrockSearchModel = 'us.stability.stable-image-search-replace-v1:0';
const bedrockUltraModel = 'stability.stable-image-ultra-v1:1';
const bedrockDiffusionModel = 'stability.sd3-5-large-v1:0';
const bedrockImageFields: readonly MediaField[] = [
	{ key: 'output_format', label: ['Stability 输出格式', 'Stability output format'], choices: ['png', 'jpeg', 'webp'], default: 'png' },
	{ key: 'negative_prompt', label: ['排除提示', 'Negative prompt'], type: 'string' },
	{ key: 'seed', label: ['生成种子', 'Generation seed'], type: 'number', min: 0, max: 4294967294 },
];

async function bedrockImage(ctx: MediaCall, edit: boolean): Promise<MediaResult> {
	const source = edit && mediaSource(ctx);
	const reply = mediaObject(await mediaJson(ctx, ctx.endpoint, {
		prompt: ctx.prompt, ...ctx.options, ...source && { image: Buffer.from(source.bytes).toString('base64') },
		...source && ctx.model === bedrockDiffusionModel && { mode: 'image-to-image' },
	}));
	const image = mediaItems(reply.images)[0];
	if (typeof image !== 'string') throw new Error('Bedrock 没有返回图像。');
	return { bytes: mediaBase64(image), extension: ctx.options.output_format === 'jpeg' ? 'jpg' : ctx.options.output_format === 'webp' ? 'webp' : 'png' };
}

const bedrockMedia: readonly MediaAdapter[] = [
	{
		providerId: 'amazon-bedrock', operation: 'image', models: ['stability.stable-image-core-v1:1', bedrockUltraModel, bedrockDiffusionModel],
		endpoint: bedrockEndpoint, fields: [...bedrockImageFields, { key: 'aspect_ratio', label: ['输出画幅', 'Output aspect ratio'],
			choices: ['16:9', '1:1', '21:9', '3:2', '2:3', '4:5', '5:4', '9:16', '9:21'] }], run: (ctx) => bedrockImage(ctx, false),
	},
	{
		providerId: 'amazon-bedrock', operation: 'image-edit', models: [bedrockSearchModel], input: 'image',
		endpoint: bedrockEndpoint, fields: [...bedrockImageFields, { key: 'search_prompt', label: ['要替换的物体', 'Object to replace'], type: 'string', required: true }],
		run: (ctx) => bedrockImage(ctx, true),
	},
	{
		providerId: 'amazon-bedrock', operation: 'image-edit', models: [bedrockUltraModel, bedrockDiffusionModel], input: 'image',
		endpoint: bedrockEndpoint, fields: [...bedrockImageFields, { key: 'strength', label: ['重绘强度', 'Redraw strength'],
			type: 'number', min: 0, max: 1, default: 0.35 }], run: (ctx) => bedrockImage(ctx, true),
	},
];

export const hostedMedia: readonly MediaAdapter[] = [...azureMedia, ...vertexMedia, ...bedrockMedia];
