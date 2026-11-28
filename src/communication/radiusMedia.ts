import { Buffer } from 'node:buffer';
import { mediaJson, type MediaAdapter, type MediaCall, type MediaField } from './mediaApi';
import { imageResult } from './gatewayMediaFiles';

// Radius advertises image-capable models through /v1/config and serves the native Pi image protocol.
// https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/pi-image.ts
const endpoint = 'https://radius.pi.dev/v1/image';
const models = ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image',
	'gpt-5.4-image-2', 'gpt-5-image-mini'];

function fields(model: string): readonly MediaField[] {
	return model.startsWith('gemini-') ? [
		{ key: 'aspectRatio', label: ['宽高比', 'Aspect ratio'], choices: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] },
		{ key: 'size', label: ['图片分辨率', 'Image resolution'], choices: ['1K', '2K', '4K'] },
	] : [{ key: 'size', label: ['图片尺寸', 'Image size'], choices: ['1024x1024', '1024x1536', '1536x1024'] }];
}

async function image(ctx: MediaCall) {
	const input = [
		{ type: 'text', text: ctx.prompt },
		...(ctx.source ? [{ type: 'image', mimeType: ctx.source.mimeType, data: Buffer.from(ctx.source.bytes).toString('base64') }] : []),
	];
	const result = await mediaJson<{ output?: { type?: string; data?: unknown }[] }>(ctx, ctx.endpoint, {
		model: ctx.model, context: { input }, ...(Object.keys(ctx.options).length > 0 && { options: ctx.options }),
	});
	return imageResult(result.output?.find((part) => part.type === 'image')?.data);
}

export const radiusMedia: readonly MediaAdapter[] = [
	{ providerId: 'radius', operation: 'image', models, endpoint: () => endpoint, fields, run: image },
	{ providerId: 'radius', operation: 'image-edit', models, endpoint: () => endpoint, fields, input: 'image', run: image },
];
