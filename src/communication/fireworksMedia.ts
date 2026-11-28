import type { MediaAdapter, MediaCall, MediaField } from './mediaApi';
import { imageBytesResult, mediaReplyBytes, mediaSource, postMedia, seedField, sourceBlob } from './gatewayMediaFiles';

// The original public SDXL endpoints are distinct from the retired FLUX workflows.
// https://fireworks.ai/blog/sdxl-ssd-1b-image-to-image-controlnet
const root = 'https://api.fireworks.ai/inference/v1/image_generation';
const sdxl = 'accounts/fireworks/models/stable-diffusion-xl-1024-v1-0';
const playground = 'accounts/fireworks/models/playground-v2-1024px-aesthetic';
const common: readonly MediaField[] = [
	{ key: 'size', label: ['输出尺寸（像素）', 'Dimensions (pixels)'],
		choices: ['1024x1024', '1152x896', '896x1152', '1216x832', '832x1216', '1344x768', '768x1344', '1536x640', '640x1536'] },
	{ key: 'format', label: ['输出格式', 'Output format'], choices: ['png', 'jpeg'], default: 'png' },
	{ key: 'cfg_scale', label: ['提示词引导强度', 'Guidance scale'], type: 'number', min: 0, max: 35 },
	{ key: 'steps', label: ['采样步数', 'Sampling steps'], type: 'number', min: 1, max: 150 },
	{ key: 'negative_prompt', label: ['负向提示词', 'Negative prompt'], type: 'string' }, seedField,
];

async function image(ctx: MediaCall, edit = false) {
	const { format, size, ...fields } = ctx.options;
	const [width, height] = typeof size === 'string' ? size.split('x').map(Number) : [];
	const params = { prompt: ctx.prompt, ...fields, ...(width && height && { width, height }), samples: 1 };
	let body: FormData | object = params;
	if (edit) {
		const source = mediaSource(ctx);
		const form = new FormData();
		for (const [key, value] of Object.entries(params)) form.set(key, String(value));
		form.set('init_image_mode', 'IMAGE_STRENGTH');
		form.set('init_image', sourceBlob(source), source.filename);
		body = form;
	}
	const response = await postMedia(ctx, body, { Accept: format === 'jpeg' ? 'image/jpeg' : 'image/png' });
	if (response.headers.get('finish-reason') === 'CONTENT_FILTERED') {
		await response.body?.cancel().catch(() => {});
		throw new Error('Fireworks 未返回可保存的图片。');
	}
	return imageBytesResult((await mediaReplyBytes(response, format === 'jpeg' ? 'jpg' : 'png', ctx.signal)).bytes);
}

export const fireworksMedia: readonly MediaAdapter[] = [
	{ providerId: 'fireworks', operation: 'image', models: [sdxl, playground], endpoint: ({ model }) => `${root}/${model}`, fields: common, run: image },
	{ providerId: 'fireworks', operation: 'image-edit', models: [sdxl], endpoint: ({ model }) => `${root}/${model}/image_to_image`,
		fields: [...common, { key: 'image_strength', label: ['原图保留强度', 'Source image strength'], type: 'number', min: 0, max: 1, default: 0.35 }],
		input: 'image', run: (ctx) => image(ctx, true) },
];
