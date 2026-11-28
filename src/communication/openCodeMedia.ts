import { Buffer } from 'node:buffer';
import { mediaDataUrl, mediaJson } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaField } from './mediaApi';
import { imageResult, mediaReplyJson, mediaSource, postMedia, ratioField, sourceBlob } from './gatewayMediaFiles';

// Console image APIs are separate from the account's text model endpoints and Go subscription.
// https://opencode.ai/docs/console/models/#image-models
const base = 'https://opencode.ai/inference';
const openai = 'gpt-image-2.5-sunburst';
const xai = 'grok-imagine-image-2.0';
const google = 'gemini-nano-banana-2.1';

const openAIFields: readonly MediaField[] = [
	{ key: 'size', label: ['图片尺寸', 'Image size'], choices: ['auto', '1024x1024', '1536x1024', '1024x1536'] },
	{ key: 'quality', label: ['质量', 'Quality'], choices: ['auto', 'low', 'medium', 'high'] },
	{ key: 'output_format', label: ['输出格式', 'Output format'], choices: ['png', 'jpeg', 'webp'] },
];
const xaiFields: readonly MediaField[] = [ratioField,
	{ key: 'resolution', label: ['分辨率', 'Resolution'], choices: ['1k', '2k'] },
];
const googleFields: readonly MediaField[] = [ratioField,
	{ key: 'imageSize', label: ['图片尺寸', 'Image size'], choices: ['512', '1K', '2K', '4K'] },
];

async function openAIEdit(ctx: MediaCall) {
	const source = mediaSource(ctx);
	const params = new FormData();
	params.append('model', ctx.model);
	params.append('prompt', ctx.prompt);
	params.append('image', sourceBlob(source), source.filename);
	for (const [key, value] of Object.entries(ctx.options)) params.append(key, String(value));
	const result = await mediaReplyJson<{ data?: { b64_json?: unknown }[] }>(await postMedia(ctx, params), ctx.signal);
	return imageResult(result.data?.[0]?.b64_json);
}

async function image(ctx: MediaCall) {
	if (ctx.model === openai && ctx.source) return openAIEdit(ctx);
	const result = await mediaJson<{ data?: { b64_json?: unknown }[] }>(ctx, ctx.endpoint, { model: ctx.model, prompt: ctx.prompt, ...ctx.options,
		...(ctx.model === xai && { response_format: 'b64_json' }),
		...(ctx.source && { image: { url: mediaDataUrl(ctx.source), type: 'image_url' } }),
	});
	return imageResult(result.data?.[0]?.b64_json);
}

async function googleImage(ctx: MediaCall) {
	const generationConfig = { responseModalities: ['IMAGE'], ...(Object.keys(ctx.options).length && {
		imageConfig: { aspectRatio: ctx.options.aspect_ratio, imageSize: ctx.options.imageSize },
	}) };
	const parts = [{ text: ctx.prompt }, ...(ctx.source ? [{ inlineData: { mimeType: ctx.source.mimeType, data: Buffer.from(ctx.source.bytes).toString('base64') } }] : [])];
	const result = await mediaJson<{
		candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
	}>(ctx, ctx.endpoint, { contents: [{ role: 'user', parts }], generationConfig });
	return imageResult(result.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData?.data);
}

export const openCodeMedia: readonly MediaAdapter[] = (['image', 'image-edit'] as const).flatMap((operation): MediaAdapter[] => {
	const edit = operation === 'image-edit';
	const required = edit ? { input: 'image' as const } : {};
	return [
		{ providerId: 'opencode', operation, models: [openai], endpoint: () => `${base}/openai/v1/images/${edit ? 'edits' : 'generations'}`,
			...required, fields: openAIFields, run: image },
		{ providerId: 'opencode', operation, models: [xai], endpoint: () => `${base}/xai/v1/images/${edit ? 'edits' : 'generations'}`,
			...required, fields: xaiFields, run: image },
		{ providerId: 'opencode', operation, models: [google], endpoint: () => `${base}/google/v1beta/models/${google}:generateContent`,
			...required, fields: googleFields, run: googleImage },
	];
});
