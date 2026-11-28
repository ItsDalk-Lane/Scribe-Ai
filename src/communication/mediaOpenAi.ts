import { mediaJson } from './mediaApi';
import type { MediaAdapter, MediaField } from './mediaApi';
import { appendMediaOptions, directFormJson, directPostAudio, mediaImageResult, mediaItems, mediaObject, mediaPart, mediaSource, mediaTranscript } from './mediaDirectHttp';

const host = 'https://api.openai.com/v1';
export const gptImageModels = [
	'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare',
	'gpt-image-2.5-sunburst-2026-09-08', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2', 'gpt-image-2-2026-04-21',
	'gpt-image-1.5', 'gpt-image-1-mini', 'chatgpt-image-latest',
];
const synthesisModels = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];
const recognitionModels = ['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize', 'whisper-1'];
const voiceIds = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

export function gptImageFields(model: string, edit = false): MediaField[] {
	const image2 = /^gpt-image-2/u.test(model);
	const sunburstOrFlare = /-(?:sunburst|flare)(?:-|$)/u.test(model);
	return [
		{ key: 'size', label: ['图片尺寸', 'Image size'], choices: ['auto', '1024x1024', '1536x1024', '1024x1536', ...image2 ? ['2048x2048', '3840x2160', '2160x3840'] : []] },
		{ key: 'quality', label: ['渲染质量', 'Render quality'], choices: ['auto', 'low', 'medium', 'high', ...sunburstOrFlare ? ['xhigh', 'max'] : []] },
		{ key: 'output_format', label: ['输出格式', 'Output format'], choices: ['png', 'jpeg', 'webp'], default: 'png' },
		...(!image2 || sunburstOrFlare) ? [{ key: 'background', label: ['背景透明度', 'Background transparency'] as [string, string], choices: ['auto', 'transparent', 'opaque'] }] : [],
		...edit && model === 'gpt-image-1.5' ? [{ key: 'input_fidelity', label: ['输入图保真度', 'Source fidelity'] as [string, string], choices: ['low', 'high'] }] : [],
	];
}

const speechFields = (model: string): MediaField[] => [
	{ key: 'voice', label: ['音色', 'Voice'], choices: model.startsWith('tts-') ? ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] : voiceIds, default: 'alloy' },
	{ key: 'response_format', label: ['音频格式', 'Audio format'], choices: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'], default: 'mp3' },
	{ key: 'speed', label: ['语速倍率', 'Speaking speed'], type: 'number', min: 0.25, max: 4 },
	...!model.startsWith('tts-') ? [{ key: 'instructions', label: ['朗读风格', 'Voice instructions'] as [string, string], type: 'string' as const }] : [],
];

function imageExtension(output: unknown) {
	return output === 'jpeg' ? 'jpg' : output === 'webp' ? 'webp' : 'png';
}

function speechExtension(output: unknown) {
	return output === 'opus' ? 'ogg' : output === 'aac' || output === 'flac' || output === 'wav' || output === 'pcm' ? output : 'mp3';
}

export const openAiMedia: readonly MediaAdapter[] = [
	{
		providerId: 'openai', operation: 'image', models: gptImageModels,
		endpoint: () => `${host}/images/generations`, fields: gptImageFields,
		run: async (ctx) => {
			const reply = await mediaJson(ctx, ctx.endpoint, { model: ctx.model, prompt: ctx.prompt, n: 1, ...ctx.options });
			return mediaImageResult(reply, imageExtension(ctx.options.output_format));
		},
	},
	{
		providerId: 'openai', operation: 'image-edit', models: gptImageModels, input: 'image',
		endpoint: () => `${host}/images/edits`,
		fields: (model) => gptImageFields(model, true),
		run: async (ctx) => {
			const form = new FormData();
			mediaPart(form, 'image[]', mediaSource(ctx));
			appendMediaOptions(form, { model: ctx.model, prompt: ctx.prompt, n: 1, ...ctx.options });
			return mediaImageResult(await directFormJson(ctx, form), imageExtension(ctx.options.output_format));
		},
	},
	{
		providerId: 'openai', operation: 'speech-synthesis', models: synthesisModels,
		endpoint: () => `${host}/audio/speech`, fields: speechFields,
		run: (ctx) => {
			const extension = speechExtension(ctx.options.response_format);
			return directPostAudio(ctx, { model: ctx.model, voice: 'alloy', input: ctx.prompt, ...ctx.options },
				extension, extension === 'pcm' ? 24000 : undefined);
		},
	},
	{
		providerId: 'openai', operation: 'speech-recognition', models: recognitionModels, input: 'audio',
		endpoint: () => `${host}/audio/transcriptions`,
		fields: (model) => [
			{ key: 'language', label: ['语言代码', 'Language code'], type: 'string' },
			...model !== 'gpt-4o-transcribe-diarize' ? [{ key: 'prompt', label: ['转写提示', 'Transcription prompt'] as [string, string], type: 'string' as const }] : [],
			...model === 'whisper-1' ? [{ key: 'temperature', label: ['采样温度', 'Temperature'] as [string, string], type: 'number' as const, min: 0, max: 1 }] : [],
		],
		run: async (ctx) => {
			const diarize = ctx.model === 'gpt-4o-transcribe-diarize';
			const form = new FormData();
			mediaPart(form, 'file', mediaSource(ctx));
			appendMediaOptions(form, { model: ctx.model, response_format: diarize ? 'diarized_json' : 'json',
				...diarize && { chunking_strategy: 'auto' }, ...ctx.options });
			const reply = await directFormJson(ctx, form);
			if (diarize) {
				const segments = mediaItems(mediaObject(reply).segments).map((segment) => {
					const entry = mediaObject(segment);
					return typeof entry.speaker === 'string' && typeof entry.text === 'string' ? `[${entry.speaker}] ${entry.text}` : '';
				}).filter(Boolean);
				if (segments.length) return { text: segments.join('\n') };
			}
			return mediaTranscript(reply);
		},
	},
];
