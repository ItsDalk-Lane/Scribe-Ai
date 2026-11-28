import { Buffer } from 'node:buffer';
import { mediaJson, responseBytes, type MediaAdapter, type MediaCall, type MediaField, type MediaResult } from './mediaApi';

const root = 'https://api.ant-ling.com/v1';
const providerId = 'ant-ling';
const imageFields = [
	{ key: 'size', label: ['图片尺寸（auto 或宽×高）', 'Image size (auto or width × height)'], type: 'string' },
	{ key: 'output_format', label: ['图片格式', 'Image format'], choices: ['png', 'jpeg'], default: 'png' },
	{ key: 'watermark', label: ['添加水印', 'Watermark'], type: 'boolean' },
] satisfies MediaField[];

function authenticatedPost(ctx: MediaCall, body: FormData | object) {
	const form = body instanceof FormData;
	return ctx.fetch(ctx.endpoint, {
		method: 'POST', signal: ctx.signal, redirect: 'error',
		headers: { Authorization: 'Bearer ' + ctx.key, ...(!form && { 'Content-Type': 'application/json' }) },
		body: form ? body : JSON.stringify(body),
	});
}

function antImage(edit: boolean): MediaAdapter {
	return {
		providerId, operation: edit ? 'image-edit' : 'image', models: ['Ming-Image-0.1-Design'],
		input: edit ? 'image' : undefined, fields: imageFields,
		endpoint: () => root + '/images/' + (edit ? 'edits' : 'generations'),
		async run(ctx): Promise<MediaResult> {
			const { size, output_format = 'png' } = ctx.options;
			if (size && size !== 'auto' && (typeof size !== 'string' || !/^\d{4}x\d{4}$/u.test(size))) {
				throw new Error('蚂蚁百灵图片尺寸须写为宽x高或 auto。');
			}
			const input = { ...ctx.options, model: ctx.model, prompt: ctx.prompt, response_format: 'url', output_format };
			type Reply = { data?: { url?: string }[] };
			let reply: Reply;
			if (edit) {
				const source = ctx.source;
				if (!source) throw new Error('请选择要修改的图片。');
				const form = new FormData();
				for (const [key, value] of Object.entries(input)) form.set(key, String(value));
				form.set('image[]', new Blob([new Uint8Array(source.bytes)], { type: source.mimeType }), source.filename);
				reply = JSON.parse((await responseBytes(await authenticatedPost(ctx, form), 256 * 1024, ctx.signal)).toString('utf8')) as Reply;
			} else reply = await mediaJson<Reply>(ctx, ctx.endpoint, input);
			const url = reply.data?.[0]?.url;
			if (typeof url !== 'string' || !url) throw new Error('蚂蚁百灵未返回生成的图片。');
			return { url, extension: output_format === 'jpeg' ? 'jpg' : 'png' };
		},
	};
}

const antTranscribe: MediaAdapter = {
	providerId, operation: 'speech-recognition', models: ['Ming-3.0-asr-tiny'],
	endpoint: () => root + '/audio/transcriptions', input: 'audio',
	fields: [
		{ key: 'language', label: ['识别语言代码', 'Recognition language'], type: 'string' },
		{ key: 'prompt', label: ['转写上下文', 'Transcription context'], type: 'string' },
	],
	async run(ctx) {
		const source = ctx.source;
		if (!source || source.bytes.length > 10_000_000) throw new Error('蚂蚁百灵语音识别需要 10 MB 以内的音频。');
		const form = new FormData();
		form.set('model', ctx.model);
		form.set('response_format', 'json');
		form.set('file', new Blob([new Uint8Array(source.bytes)], { type: source.mimeType }), source.filename);
		for (const [key, value] of Object.entries(ctx.options)) form.set(key, String(value));
		const result = JSON.parse((await responseBytes(await authenticatedPost(ctx, form), 256 * 1024, ctx.signal)).toString('utf8')) as { text?: string };
		if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('蚂蚁百灵未返回识别文本。');
		return { text: result.text };
	},
};

const antSpeech: MediaAdapter = {
	providerId, operation: 'speech-synthesis', models: ['Ming-3.0-tts-0.5B'],
	endpoint: () => root + '/audio/speech',
	fields: [
		{ key: 'voice', label: ['音色 ID', 'Voice ID'], type: 'string' },
		{ key: 'response_format', label: ['输出编码', 'Audio encoding'], choices: ['pcm', 'mp3', 'wav', 'aac'], default: 'pcm' },
		{ key: 'sample_rate', label: ['采样率', 'Sample rate'], choices: [8000, 16000, 22050, 24000, 44100, 48000], default: 44100 },
		{ key: 'speed', label: ['语速倍数', 'Speaking speed'], type: 'number', min: 0.25, max: 4 },
		{ key: 'volume', label: ['音量倍数', 'Voice volume'], type: 'number', min: 0.5, max: 2 },
		{ key: 'pitch', label: ['音高倍数', 'Pitch'], type: 'number', min: 0.5, max: 2 },
	],
	async run(ctx) {
		const setting = ctx.options.response_format;
		const format = setting === 'mp3' || setting === 'wav' || setting === 'aac' ? setting : 'pcm';
		const sampleRate = typeof ctx.options.sample_rate === 'number' ? ctx.options.sample_rate : 44100;
		const response = await authenticatedPost(ctx, {
			...ctx.options, model: ctx.model, input: ctx.prompt, response_format: format, sample_rate: sampleRate, stream_format: 'sse',
		});
		const streamed = (await responseBytes(response, 44 * 1024 * 1024, ctx.signal)).toString('utf8');
		const chunks: Uint8Array[] = [];
		let done = false;
		for (const line of streamed.split(/\r?\n/u)) {
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (!data || data === '[DONE]') continue;
			const event = JSON.parse(data) as { type?: string; audio?: string };
			if (event.type === 'speech.audio.done') done = true;
			if (event.type === 'speech.audio.delta' && typeof event.audio === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(event.audio)) {
				chunks.push(Buffer.from(event.audio, 'base64'));
			}
		}
		if (!done || !chunks.length) throw new Error('蚂蚁百灵没有完整返回语音。');
		return { bytes: Buffer.concat(chunks), extension: format, ...(format === 'pcm' && { sampleRate }) };
	},
};

export const antLingMedia: readonly MediaAdapter[] = [antImage(false), antImage(true), antTranscribe, antSpeech];
