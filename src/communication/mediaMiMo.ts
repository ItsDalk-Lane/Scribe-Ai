import { Buffer } from 'node:buffer';
import { mediaDataUrl, mediaJson, type MediaAdapter, type MediaField } from './mediaApi';

const mimoProducts = [
	['xiaomi', 'api.xiaomimimo.com'],
	['xiaomi-token-plan-cn', 'token-plan-cn.xiaomimimo.com'],
	['xiaomi-token-plan-sgp', 'token-plan-sgp.xiaomimimo.com'],
	['xiaomi-token-plan-ams', 'token-plan-ams.xiaomimimo.com'],
] as const;

const formatField: MediaField = { key: 'format', label: ['音频格式', 'Audio format'], choices: ['wav', 'mp3'], default: 'wav' };
const styleField: MediaField = { key: 'style', label: ['朗读风格', 'Speaking style'], type: 'string' };
const voiceField: MediaField = { key: 'voice', label: ['内置音色', 'Built-in voice'],
	choices: ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'], default: 'mimo_default' };

interface MimoReply {
	choices?: { message?: { content?: string; audio?: { data?: string } } }[];
}

export const mimoMedia: readonly MediaAdapter[] = mimoProducts.flatMap(([providerId, host]) => {
	const endpoint = () => 'https://' + host + '/v1/chat/completions';
	const synthesize = (mode: 'basic' | 'design' | 'clone'): MediaAdapter => ({
		providerId, operation: 'speech-synthesis', endpoint,
		models: [mode === 'design' ? 'mimo-v2.5-tts-voicedesign' : mode === 'clone' ? 'mimo-v2.5-tts-voiceclone' : 'mimo-v2.5-tts'],
		input: mode === 'clone' ? 'audio' : undefined,
		fields: mode === 'basic' ? [formatField, voiceField, styleField] : mode === 'design'
			? [formatField, { ...styleField, label: ['音色设计描述', 'Voice design description'], required: true }] : [formatField],
		async run(ctx) {
			const { voice = 'mimo_default', style } = ctx.options;
			const format = ctx.options.format === 'mp3' ? 'mp3' : 'wav';
			const source = ctx.source;
			if (mode === 'clone' && (!source || !/\.(?:wav|mp3)$/iu.test(source.filename) || source.bytes.length > 7_500_000)) {
				throw new Error('小米 MiMo 声音克隆需要 7.5 MB 以内的 WAV 或 MP3 音频样本。');
			}
			if (mode === 'design' && (typeof style !== 'string' || !style.trim())) throw new Error('请填写小米 MiMo 的音色设计描述。');
			const messages = [
				...(typeof style === 'string' && style.trim() ? [{ role: 'user', content: style }] : []),
				{ role: 'assistant', content: ctx.prompt },
			];
			const audio = { format, ...(mode === 'basic' && { voice }),
				...(mode === 'clone' && source && { voice: mediaDataUrl(source) }) };
			const reply = await mediaJson<MimoReply>(ctx, ctx.endpoint, { model: ctx.model, messages, audio, stream: false });
			const data = reply.choices?.[0]?.message?.audio?.data;
			if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) throw new Error('小米 MiMo 未返回合成音频。');
			return { bytes: Buffer.from(data, 'base64'), extension: format };
		},
	});
	const recognize: MediaAdapter = {
		providerId, operation: 'speech-recognition', models: ['mimo-v2.5-asr'], input: 'audio', endpoint,
		fields: [{ key: 'language', label: ['识别语种', 'Recognition language'], choices: ['auto', 'zh', 'en'], default: 'auto' }],
		async run(ctx) {
			const source = ctx.source;
			if (!source || !/\.(?:wav|mp3)$/iu.test(source.filename) || source.bytes.length > 7_500_000) {
				throw new Error('小米 MiMo 语音识别需要 7.5 MB 以内的 WAV 或 MP3。');
			}
			const content = [{ type: 'input_audio', input_audio: { data: mediaDataUrl(source) } }];
			const reply = await mediaJson<MimoReply>(ctx, ctx.endpoint, {
				model: ctx.model, messages: [{ role: 'user', content }],
				asr_options: { language: ctx.options.language ?? 'auto' }, stream: false,
			});
			const text = reply.choices?.[0]?.message?.content;
			if (typeof text !== 'string' || !text.trim()) throw new Error('小米 MiMo 未返回语音识别文本。');
			return { text };
		},
	};
	return [synthesize('basic'), synthesize('design'), synthesize('clone'), recognize];
});
