import { mediaDataUrl, mediaJson } from './mediaApi';
import type { MediaAdapter, MediaCall, MediaField } from './mediaApi';
import { appendMediaOptions, directFormJson, directPostAudio, mediaImageResult, mediaObject, mediaPart, mediaProperty, mediaSource,
	mediaTranscript } from './mediaDirectHttp';

const host = 'https://api.x.ai/v1';
const imageModels = ['grok-imagine-image-2.0', 'grok-imagine-image', 'grok-imagine-image-pro'];
const videoModel = 'grok-imagine-video';

const imageFields = (model: string): MediaField[] => [
	{ key: 'aspect_ratio', label: ['图片宽高比', 'Image aspect ratio'], choices: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', 'auto'] },
	{ key: 'resolution', label: ['图片分辨率', 'Image resolution'], choices: ['1k', '2k'] },
	...(model === 'grok-imagine-image-2.0' ? [{ key: 'quality', label: ['图像质量', 'Image quality'] as [string, string], choices: ['auto', 'low', 'medium'] }] : []),
];

const poll: NonNullable<MediaAdapter['poll']> = async (ctx, id) => {
	const value = mediaObject(await mediaJson(ctx, `${host}/videos/${encodeURIComponent(id)}`));
	if (value.status === 'done') return { status: 'succeeded', result: { url: mediaProperty(value.video, 'url'), extension: 'mp4' } };
	if (value.status === 'failed' || value.status === 'expired') return { status: 'failed' };
	return { status: 'running' };
};

async function xaiVideo(ctx: MediaCall, edit: boolean) {
	const source = ctx.source && mediaDataUrl(ctx.source);
	const options = { ...ctx.options };
	if (source && !edit) delete options.aspect_ratio;
	const input = source && (edit ? { video: { url: source } } : { image: { url: source } });
	const value = await mediaJson(ctx, ctx.endpoint, { model: ctx.model, prompt: ctx.prompt, ...options, ...input });
	return { id: mediaProperty(value, 'request_id') };
}

export const xaiMedia: readonly MediaAdapter[] = [
	{
		providerId: 'xai', operation: 'image', models: imageModels,
		endpoint: () => `${host}/images/generations`, fields: imageFields,
		run: async (ctx) => mediaImageResult(await mediaJson(ctx, ctx.endpoint, {
			model: ctx.model, prompt: ctx.prompt, response_format: 'b64_json', ...ctx.options,
		}), 'jpg'),
	},
	{
		providerId: 'xai', operation: 'image-edit', models: imageModels, input: 'image',
		endpoint: () => `${host}/images/edits`, fields: imageFields,
		run: async (ctx) => mediaImageResult(await mediaJson(ctx, ctx.endpoint, {
			model: ctx.model, prompt: ctx.prompt, response_format: 'b64_json', ...ctx.options,
			image: { type: 'image_url', url: mediaDataUrl(mediaSource(ctx)) },
		}), 'jpg'),
	},
	{
		providerId: 'xai', operation: 'video', models: [videoModel, 'grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite'], input: 'image',
		endpoint: () => `${host}/videos/generations`,
		fields: (model) => [
			{ key: 'duration', label: ['视频秒数', 'Video duration'], choices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
			{ key: 'aspect_ratio', label: ['视频宽高比', 'Video aspect ratio'], choices: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'] },
			{ key: 'resolution', label: ['视频分辨率', 'Video resolution'], choices: model === videoModel ? ['480p', '720p'] : ['480p', '720p', '1080p'] },
		],
		run: (ctx) => xaiVideo(ctx, false), poll,
	},
	{
		providerId: 'xai', operation: 'video-edit', models: [videoModel], input: 'video',
		endpoint: () => `${host}/videos/edits`, run: (ctx) => { mediaSource(ctx); return xaiVideo(ctx, true); }, poll,
	},
	{
		providerId: 'xai', operation: 'speech-synthesis', models: ['grok-voice-tts'], endpoint: () => `${host}/tts`,
		fields: [
			{ key: 'voice_id', label: ['音色 ID', 'Voice ID'], type: 'string', default: 'eve' },
			{ key: 'language', label: ['语言代码', 'Language code'], type: 'string', default: 'auto' },
			{ key: 'codec', label: ['音频编码', 'Audio codec'], choices: ['mp3', 'wav', 'pcm'], default: 'mp3' },
			{ key: 'sample_rate', label: ['采样率（Hz）', 'Sample rate (Hz)'], choices: [16000, 22050, 24000, 32000, 44100, 48000], default: 24000 },
		],
		run: (ctx) => {
			const { voice_id, language, codec, sample_rate } = ctx.options;
			const extension = codec === 'pcm' || codec === 'wav' ? codec : 'mp3';
			const sampleRate = typeof sample_rate === 'number' ? sample_rate : 24000;
			return directPostAudio(ctx, { text: ctx.prompt, voice_id: voice_id ?? 'eve', language: language ?? 'auto',
				output_format: { codec: extension, sample_rate: sampleRate } }, extension, extension === 'pcm' ? sampleRate : undefined);
		},
	},
	{
		providerId: 'xai', operation: 'speech-recognition', models: ['grok-voice-transcribe-2.0'], input: 'audio', endpoint: () => `${host}/stt`,
		fields: [
			{ key: 'language', label: ['语言代码', 'Language code'], type: 'string' },
			{ key: 'format', label: ['规范化数字和单位', 'Normalize numbers and units'], type: 'boolean' },
			{ key: 'diarize', label: ['区分说话人', 'Speaker diarization'], type: 'boolean' },
		],
		run: async (ctx) => {
			const form = new FormData();
			mediaPart(form, 'file', mediaSource(ctx));
			if (ctx.options.format === true && !ctx.options.language) throw new Error('规范化转写需要填写语言代码。');
			appendMediaOptions(form, { model: ctx.model, ...ctx.options });
			const reply = await directFormJson(ctx, form);
			if (ctx.options.diarize === true) {
				const words = mediaObject(reply).words;
				if (Array.isArray(words)) {
					const runs: { speaker: number; words: string[] }[] = [];
					for (const word of words) {
						const item = mediaObject(word);
						if (typeof item.speaker !== 'number' || typeof item.text !== 'string') continue;
						const last = runs.at(-1);
						if (last?.speaker === item.speaker) last.words.push(item.text);
						else runs.push({ speaker: item.speaker, words: [item.text] });
					}
					if (runs.length) return { text: runs.map(({ speaker, words }) => `[${speaker}] ${words.join(' ')}`).join('\n') };
				}
			}
			return mediaTranscript(reply);
		},
	},
];
