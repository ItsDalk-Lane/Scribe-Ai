import { mediaDataUrl, mediaJson } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaField } from './mediaApi';
import { mediaBase64, mediaProperty, mediaSource } from './mediaDirectHttp';

const endpoint = () => 'https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano';
const imageProfile = 'nvidia/cosmos3-nano-image';
const videoProfile = 'nvidia/cosmos3-nano-video';

const sampling: readonly MediaField[] = [
	{ key: 'resolution', label: ['分辨率和画幅', 'Resolution and aspect ratio'],
		choices: ['256', '480', '720'].flatMap((tier) => ['16_9', '1_1', '9_16', '4_3', '3_4'].map((ratio) => `${tier}_${ratio}`)) },
	{ key: 'negative_prompt', label: ['排除提示', 'Negative prompt'], type: 'string' },
	{ key: 'seed', label: ['生成种子', 'Generation seed'], type: 'number', min: 0, max: 4294967295 },
	{ key: 'guidance_scale', label: ['提示词引导强度', 'Prompt guidance scale'], type: 'number', min: 1, max: 7 },
	{ key: 'num_inference_steps', label: ['推理步数', 'Inference steps'], type: 'number', min: 1, max: 100 },
];
const videoFields: readonly MediaField[] = [...sampling,
	{ key: 'num_frames', label: ['输出帧数', 'Output frame count'], type: 'number', min: 25, max: 397 },
	{ key: 'fps', label: ['每秒帧数', 'Frames per second'], type: 'number', min: 1, max: 60 },
];

async function cosmos(ctx: MediaCall, mode: 'text2image' | 'text2video' | 'image2video' | 'video2video') {
	const { resolution, num_frames, seed, num_inference_steps } = ctx.options;
	const maxFrames = typeof resolution === 'string' && resolution.startsWith('256') ? 397
		: typeof resolution === 'string' && resolution.startsWith('480') ? 297 : 197;
	if (typeof num_frames === 'number' && (!Number.isInteger(num_frames) || num_frames > maxFrames)) {
		throw new Error(`当前分辨率下，输出帧数须为 25 至 ${maxFrames} 的整数。`);
	}
	if ([seed, num_inference_steps].some((value) => value !== undefined && !Number.isInteger(value))) {
		throw new Error('生成种子和推理步数须为整数。');
	}
	const source = mode === 'image2video' || mode === 'video2video' ? mediaSource(ctx) : undefined;
	const reply = await mediaJson(ctx, ctx.endpoint, {
		model_mode: mode, prompt: ctx.prompt, ...ctx.options,
		...(source && { input_reference: mediaDataUrl(source) }),
	});
	const image = mode === 'text2image';
	return { bytes: mediaBase64(mediaProperty(reply, image ? 'b64_image' : 'b64_video')), extension: image ? 'jpg' as const : 'mp4' as const };
}

export const nvidiaMedia: readonly MediaAdapter[] = [
	{ providerId: 'nvidia', operation: 'image', models: [imageProfile], endpoint, fields: sampling,
		run: (ctx) => cosmos(ctx, 'text2image') },
	{ providerId: 'nvidia', operation: 'video', models: [videoProfile], input: 'image', endpoint, fields: videoFields,
		run: (ctx) => cosmos(ctx, ctx.source ? 'image2video' : 'text2video') },
	{ providerId: 'nvidia', operation: 'video-edit', models: [videoProfile], input: 'video', endpoint,
		fields: [...videoFields, { key: 'condition_video_keep', label: ['保留原视频片段', 'Keep source video portion'], choices: ['first', 'last'] }],
		run: (ctx) => cosmos(ctx, 'video2video') },
];
