import { responseBytes, type MediaAdapter } from './mediaApi';

// The standalone tools have no RPC model identifier: the local IDs select their endpoints.
const toolsBase = 'https://api.deepseek.com/v1/tools';

export const deepSeekMedia: readonly MediaAdapter[] = [
	{
		providerId: 'deepseek', operation: 'speech-synthesis', models: ['deepseek-tts'], endpoint: () => toolsBase + '/tts',
		fields: [
			{ key: 'voice_id', label: ['音色', 'Voice'], choices: ['stella', 'tide'], default: 'stella' },
			{ key: 'format', label: ['音频格式', 'Audio format'], choices: ['wav', 'pcm'], default: 'wav' },
			{ key: 'filter_markdown', label: ['朗读前移除 Markdown 标记', 'Remove Markdown formatting before narration'], type: 'boolean', default: true },
		],
		async run(ctx) {
			const { voice_id, filter_markdown } = ctx.options;
			const extension = ctx.options.format === 'pcm' ? 'pcm' : 'wav';
			const response = await ctx.fetch(ctx.endpoint, {
				method: 'POST', redirect: 'error', signal: ctx.signal,
				headers: { Authorization: 'Bearer ' + ctx.key, 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: ctx.prompt, format: extension, voice_id, filter_markdown }),
			});
			const bytes = await responseBytes(response, 32 * 1024 * 1024, ctx.signal);
			if (extension === 'pcm' ? !bytes.length || bytes.length % 2 !== 0
				: bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
				throw new Error('DeepSeek 未返回可播放的语音。');
			}
			return { bytes, extension, ...(extension === 'pcm' && { sampleRate: 24000 }) };
		},
	},
	{
		providerId: 'deepseek', operation: 'speech-recognition', models: ['deepseek-asr'], endpoint: () => toolsBase + '/asr', input: 'audio',
		async run(ctx) {
			const source = ctx.source;
			if (!source || !['audio/wav', 'audio/ogg'].includes(source.mimeType) || source.bytes.byteLength > 8 * 1024 * 1024) {
				throw new Error('DeepSeek 语音识别接受 8 MiB 以内的 16 位 PCM WAV 或 Ogg Opus。');
			}
			const form = new FormData();
			form.set('file', new Blob([new Uint8Array(source.bytes)], { type: source.mimeType }), source.filename);
			const response = await ctx.fetch(ctx.endpoint, {
				method: 'POST', redirect: 'error', signal: ctx.signal, body: form, headers: { Authorization: 'Bearer ' + ctx.key },
			});
			const reply = JSON.parse((await responseBytes(response, 1024 * 1024, ctx.signal)).toString('utf8')) as { text?: string };
			if (typeof reply.text !== 'string' || !reply.text.trim()) throw new Error('DeepSeek 未返回转写文本。');
			return { text: reply.text };
		},
	},
];
