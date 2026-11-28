import { Buffer } from 'node:buffer';
import { ARK_IMAGE_URL, ARK_VIDEO_URL, isArkVideoId } from './arkVisual';
import { mediaDataUrl, mediaJson, type MediaAdapter, type MediaCall, type MediaField, type MediaPoll } from './mediaApi';

const payg = 'volcengine-doubao';
const plan = 'volcengine-agent-plan';
const plans = ['doubao-seedream-5.5', 'doubao-seedream-5.0-pro', 'doubao-seedream-5.0-flash'];
const images = ['doubao-seedream-5-5-261028', 'doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'];
const videos = ['doubao-seedance-2-5-260628', 'doubao-seedance-2-5-flash-261115', 'doubao-seedance-2-0-260128',
	'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615'];
const planVideos = ['doubao-seedance-2.5', 'doubao-seedance-2.5-flash', 'doubao-seedance-2.0', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini'];

function imageFields(model: string): MediaField[] {
	return [{ key: 'size', label: ['尺寸档位或像素宽×高', 'Size preset or pixel width × height'] },
		{ key: 'output_format', label: ['输出格式', 'Output format'], choices: ['png', 'jpeg'] },
		...(model.includes('5.5') || model.includes('5-5') ? [{
			key: 'background', label: ['背景透明度', 'Background transparency'] as const, choices: ['auto', 'opaque', 'transparent'],
		}] : [])];
}

function videoFields(model: string): MediaField[] {
	return [{ key: 'resolution', label: ['视频分辨率', 'Resolution'],
		choices: model.includes('flash') || model.includes('fast') || model.includes('mini') ? ['480p', '720p'] : ['480p', '720p', '1080p', '4k'] }];
}

function imageAdapter(providerId: string, operation: 'image' | 'image-edit', models: string[]): MediaAdapter {
	return {
		providerId, operation, models, input: 'image', fields: imageFields,
		endpoint: () => providerId === plan ? ARK_IMAGE_URL : ARK_IMAGE_URL.replace('/plan/', '/'),
		async run(ctx) {
			const result = await mediaJson<{ data?: { b64_json?: string; url?: string }[] }>(ctx, ctx.endpoint, {
				model: ctx.model, prompt: ctx.prompt, response_format: 'b64_json', ...ctx.options,
				...(ctx.source && { image: mediaDataUrl(ctx.source) }),
			});
			const output = result.data?.[0];
			if (output?.b64_json) {
				const bytes = Buffer.from(output.b64_json, 'base64');
				const extension = bytes.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'jpg' : 'png';
				return { bytes, extension };
			}
			if (!output?.url) throw new Error('方舟未返回图片。');
			return { url: output.url, extension: ctx.options.output_format === 'jpeg' ? 'jpg' : 'png' };
		},
	};
}

async function pollVideo(ctx: MediaCall, id: string): Promise<MediaPoll> {
	if (!isArkVideoId(id)) throw new Error('方舟视频任务编号无效。');
	const result = await mediaJson<{ id?: string; status?: string; content?: { video_url?: string } }>(ctx, `${ctx.endpoint}/${id}`);
	if (result.id !== id) throw new Error('方舟视频任务编号不匹配。');
	if (result.status === 'succeeded' && result.content?.video_url) return { status: 'succeeded', result: { url: result.content.video_url, extension: 'mp4' } };
	if (result.status === 'queued' || result.status === 'running') return { status: result.status };
	return { status: 'failed' };
}

function videoAdapter(providerId: string, operation: 'video' | 'video-edit', models: string[]): MediaAdapter {
	const edit = operation === 'video-edit';
	return {
		providerId, operation, models, input: edit ? 'video-url' : 'image',
		endpoint: () => providerId === plan ? ARK_VIDEO_URL : ARK_VIDEO_URL.replace('/plan/', '/'),
		fields: (model) => [
			...videoFields(model),
			...(!edit ? [{ key: 'ratio', label: ['视频宽高比', 'Aspect ratio'] as const, choices: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'] },
				{ key: 'duration', label: ['视频时长（秒）', 'Duration (seconds)'] as const,
					choices: [-1, ...Array.from({ length: /2[.-]5/u.test(model) ? 27 : 12 }, (_, index) => index + 4)] }] : []),
			{ key: 'generate_audio', label: ['生成声音', 'Generate audio'], type: 'boolean' },
		],
		async run(ctx) {
			const result = await mediaJson<{ id?: string }>(ctx, ctx.endpoint, {
				model: ctx.model,
				content: [{ type: 'text', text: ctx.prompt },
					...(ctx.sourceUrl ? [{ type: 'video_url', role: 'reference_video', video_url: { url: ctx.sourceUrl } }] : []),
					...(ctx.source ? [{ type: 'image_url', role: 'first_frame', image_url: { url: mediaDataUrl(ctx.source) } }] : [])],
				...ctx.options,
				...(edit && { ratio: 'adaptive', duration: -1, ...(/2[.-]5/u.test(ctx.model) && { omni_reference_task_type: 'edit' }) }),
				...(!edit && ctx.source && /2[.-]5/u.test(ctx.model) && { ratio: 'adaptive' }),
			});
			if (!isArkVideoId(result.id)) throw new Error('方舟未返回有效的视频任务编号。');
			return { id: result.id };
		},
		poll: pollVideo,
	};
}

// https://console.volcengine.com/ark/region:cn-beijing/docs/create-video-generation-task-api
export const arkMedia = [
	imageAdapter(plan, 'image-edit', plans), imageAdapter(payg, 'image', images), imageAdapter(payg, 'image-edit', images),
	videoAdapter(plan, 'video-edit', planVideos), videoAdapter(payg, 'video', videos), videoAdapter(payg, 'video-edit', videos),
];
