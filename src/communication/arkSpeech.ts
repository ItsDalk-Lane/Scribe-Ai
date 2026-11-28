import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket, { type ClientOptions } from 'ws';
import { getProxyAgent } from './proxy';
import { DEFAULT_MEDIA_VOICE, resolveSpeechRecognitionOptions, resolveSpeechSynthesisOptions,
	type SpeechRecognitionOptions, type SpeechSynthesisOptions } from '../orchestration/settings/mediaSettings';

// Agent Plan uses its own /plan routes and the subscription's dedicated API key.
export const ARK_TTS_URL = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';
export const ARK_ASR_URL = 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream';
export const ARK_DEFAULT_VOICE = DEFAULT_MEDIA_VOICE;
export const ARK_MAX_SPEECH_TEXT_BYTES = 1024;
export const ARK_MAX_ASR_BYTES = 8 * 1024 * 1024;
const MAX_TTS_BYTES = 8 * 1024 * 1024;
const MAX_TTS_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_ASR_FRAME_BYTES = 1024 * 1024;

export type ArkSpeechAudioFormat = 'wav' | 'mp3' | 'ogg';
type BeforeSend = () => void | Promise<void>;

function requestHeaders(key: string, resource: string, id: string) {
	if (!key.trim()) throw new Error('请先在模型服务设置中配置方舟 Agent Plan 专属 API 密钥。');
	return { 'X-Api-Key': key, 'X-Api-Resource-Id': resource, 'X-Api-Request-Id': id };
}

function diagnosticId(value: string | string[] | null | undefined, key: string) {
	return typeof value === 'string' && !value.includes(key) && /^[\w-]{1,128}$/u.test(value) ? `（请求追踪号 ${value}）` : '';
}

function mp3Header(data: Buffer) {
	let start = 0;
	if (data.length >= 10 && data.toString('ascii', 0, 3) === 'ID3') {
		const size = data.subarray(6, 10);
		if (size.some((byte) => byte > 127)) return undefined;
		start = 10 + size.reduce((length, byte) => (length << 7) + byte, 0) + (data[5]! & 0x10 ? 10 : 0);
	}
	if (data.length < start + 4 || data[start] !== 0xff || (data[start + 1]! & 0xe6) !== 0xe2) return undefined;
	return { channels: data[start + 3]! >> 6 === 3 ? 1 : 2 };
}

export async function synthesizeSpeech(fetcher: typeof fetch, key: string, { text, voice = ARK_DEFAULT_VOICE, ...options }: {
	text: string; voice?: string;
} & Partial<SpeechSynthesisOptions>, signal: AbortSignal, beforeSend?: BeforeSend): Promise<Buffer> {
	if (!text.trim() || Buffer.byteLength(text) > ARK_MAX_SPEECH_TEXT_BYTES) throw new Error('待合成文本不能为空或超过 1024 字节。');
	if (!/^[a-z0-9_-]{1,120}$/iu.test(voice)) throw new Error('请填写有效的方舟语音合成音色 ID。');
	const { format, sampleRate, speechRate, loudnessRate } = resolveSpeechSynthesisOptions(options);
	const active = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
	active.throwIfAborted();
	const headers = requestHeaders(key, 'seed-tts-2.0', randomUUID());
	await beforeSend?.();
	active.throwIfAborted();
	const response = await fetcher(ARK_TTS_URL, {
		method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, redirect: 'error', signal: active,
		body: JSON.stringify({ req_params: { text, speaker: voice, audio_params: {
			format, sample_rate: sampleRate, speech_rate: speechRate || undefined, loudness_rate: loudnessRate || undefined,
		} } }),
	});
	const trace = diagnosticId(response.headers.get('x-tt-logid'), key);
	if (!response.ok || response.redirected || !response.body) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`方舟语音合成请求失败（HTTP ${response.status}）${trace}。`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const parts: Buffer[] = [];
	let audioBytes = 0;
	let responseBytes = 0;
	let pending = '';
	let complete = false;
	function consume(line: string) {
		if (!line.trim()) return;
		let event: { code?: unknown; data?: unknown } | null;
		try { event = JSON.parse(line) as typeof event; } catch { throw new Error(`方舟语音合成返回了无效数据${trace}。`); }
		if (!event || typeof event.code !== 'number' || !Number.isInteger(event.code)) throw new Error(`方舟语音合成响应缺少有效状态${trace}。`);
		if (event.code !== 0 && event.code !== 20_000_000) throw new Error(`方舟语音合成失败（${event.code}）${trace}。`);
		if (event.data !== undefined && event.data !== null && event.data !== '') {
			if (typeof event.data !== 'string' || event.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(event.data)) {
				throw new Error(`方舟语音合成返回了无效的音频数据${trace}。`);
			}
			const part = Buffer.from(event.data, 'base64');
			audioBytes += part.length;
			if (audioBytes > MAX_TTS_BYTES) throw new Error('生成的音频超过 8 MiB。');
			parts.push(part);
		}
		complete = event.code === 20_000_000;
	}
	const cancelRead = () => { void reader.cancel().catch(() => {}); };
	active.addEventListener('abort', cancelRead, { once: true });
	try {
		while (!complete) {
			active.throwIfAborted();
			const { value, done } = await reader.read();
			active.throwIfAborted();
			if (done) { consume(pending + decoder.decode()); break; }
			responseBytes += value.length;
			if (responseBytes > MAX_TTS_RESPONSE_BYTES) throw new Error('方舟语音合成的响应过大。');
			pending += decoder.decode(value, { stream: true });
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) { consume(line); if (complete) break; }
		}
		const bytes = Buffer.concat(parts, audioBytes);
		const audio = complete && (format === 'wav' ? completeWave(bytes, sampleRate)
			: validSpeechAudio(bytes, format) ? bytes : undefined);
		if (!audio) throw new Error(`方舟语音合成未返回完整的 ${format === 'ogg_opus' ? 'OGG Opus' : format.toUpperCase()}${trace}。`);
		return audio;
	} finally {
		active.removeEventListener('abort', cancelRead);
		cancelRead();
		reader.releaseLock();
	}
}

function oggOpusChannels(data: Buffer): number | undefined {
	const header = 27 + (data[26] ?? 0);
	const channels = data[header + 9];
	if (data.toString('ascii', 0, 4) === 'OggS' && data.toString('ascii', header, header + 8) === 'OpusHead'
		&& (channels === 1 || channels === 2)) return channels;
	return undefined;
}

function validSpeechAudio(data: Buffer, format: 'mp3' | 'pcm' | 'ogg_opus'): boolean {
	if (format === 'mp3') return Boolean(mp3Header(data));
	if (format === 'ogg_opus') return Boolean(oggOpusChannels(data));
	return data.length > 0 && data.length % 2 === 0;
}

function waveLengthPlaceholder(length: number): boolean {
	return length === 0xffff_ffff || length === 0x7fff_ffff;
}

function waveData(data: Buffer, sampleRate: number, streaming = false) {
	if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return undefined;
	let channels = 0;
	for (let offset = 12; offset + 8 <= data.length;) {
		const kind = data.toString('ascii', offset, offset + 4);
		const start = offset + 8;
		const declared = data.readUInt32LE(offset + 4);
		const placeholder = kind === 'data' && streaming && waveLengthPlaceholder(declared);
		const size = placeholder ? data.length - start : declared;
		if (start + size > data.length) break;
		if (kind === 'fmt ' && size >= 16 && data.readUInt16LE(start) === 1
			&& data.readUInt32LE(start + 4) === sampleRate && data.readUInt16LE(start + 14) === 16) {
			channels = data.readUInt16LE(start + 2);
		}
		if (kind === 'data' && (channels === 1 || channels === 2) && size > 0 && size % (2 * channels) === 0) {
			return { channels, start, size, placeholder };
		}
		offset = start + size + size % 2;
	}
	return undefined;
}

function completeWave(data: Buffer, sampleRate: number): Buffer | undefined {
	let header: Buffer | undefined;
	let channels = 0;
	let samples = 0;
	const parts: Buffer[] = [];
	for (let offset = 0; offset < data.length;) {
		const remaining = data.length - offset;
		if (remaining < 12) return undefined;
		const declared = data.readUInt32LE(offset + 4);
		const streaming = waveLengthPlaceholder(declared);
		const length = streaming ? remaining : declared + 8;
		if (length < 12 || length > remaining || (streaming && offset > 0)) return undefined;
		const segment = data.subarray(offset, offset + length);
		const whole = offset === 0 && length === data.length;
		const wave = waveData(segment, sampleRate, whole);
		if (!wave || (channels && channels !== wave.channels)) return undefined;
		if (whole && !streaming && !wave.placeholder) return data;
		header ??= Buffer.from(segment.subarray(0, wave.start));
		channels = wave.channels;
		parts.push(segment.subarray(wave.start, wave.start + wave.size));
		samples += wave.size;
		offset += length;
	}
	if (!header) return undefined;
	// A WAVE container counts all PCM samples once, regardless of how Ark framed the response.
	header.writeUInt32LE(header.length + samples - 8, 4);
	header.writeUInt32LE(samples, header.length - 4);
	return Buffer.concat([header, ...parts], header.length + samples);
}

function audioParameters(data: Buffer, format: ArkSpeechAudioFormat) {
	let channel: number;
	if (format === 'wav') {
		const channels = waveData(data, 16_000)?.channels;
		if (!channels) throw new Error('WAV 须为 16 kHz、16-bit PCM，支持单声道或双声道。');
		channel = channels;
	} else if (format === 'ogg') {
		const channels = oggOpusChannels(data);
		if (!channels) throw new Error('OGG 音频须使用 Opus 编码，支持单声道或双声道。');
		channel = channels;
	} else {
		const header = format === 'mp3' && mp3Header(data);
		if (!header) throw new Error('音频须为有效的 MP3、PCM WAV 或 Opus OGG。');
		channel = header.channels;
	}
	return { format, codec: format === 'ogg' ? 'opus' : 'raw', rate: 16_000, bits: 16, channel };
}

function requestFrame(type: number, sequence: number, bytes: Uint8Array) {
	const payload = gzipSync(bytes);
	const header = Buffer.from([0x11, (type << 4) | (sequence < 0 ? 3 : 1), 0x11, 0]);
	const prefix = Buffer.alloc(8);
	prefix.writeInt32BE(sequence, 0);
	prefix.writeUInt32BE(payload.length, 4);
	return Buffer.concat([header, prefix, payload]);
}

type SpeechUtterance = { text: string; startMs?: number; endMs?: number };
export type SpeechRecognitionResult = { text: string; utterances?: SpeechUtterance[] };

function speechUtterances(value: unknown): SpeechUtterance[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const milliseconds = (time: unknown) => typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 ? time : undefined;
	return value.flatMap((entry: unknown) => {
		if (!entry || typeof entry !== 'object') return [];
		const { text, start_time, end_time } = entry as { text?: unknown; start_time?: unknown; end_time?: unknown };
		if (typeof text !== 'string' || !text.trim()) return [];
		const startMs = milliseconds(start_time);
		const endMs = milliseconds(end_time);
		return [{ text: text.trim(), ...(startMs !== undefined && { startMs }),
			...(endMs !== undefined && (startMs === undefined || endMs >= startMs) && { endMs }) }];
	});
}

function speechResponse(frame: Buffer, trace: string, showUtterances: boolean): { final: boolean } & Partial<SpeechRecognitionResult> {
	const invalid = () => new Error(`方舟语音识别返回了无效数据${trace}。`);
	if (frame.length < 8 || frame.length > MAX_ASR_FRAME_BYTES || frame[0]! >> 4 !== 1) throw invalid();
	const flags = frame[1]! & 0x0f;
	const type = frame[1]! >> 4;
	let offset = (frame[0]! & 0x0f) * 4 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
	if ((frame[0]! & 0x0f) < 1 || offset + (type === 15 ? 8 : 4) > frame.length) throw invalid();
	if (type === 15) throw new Error(`方舟语音识别失败（${frame.readInt32BE(offset)}）${trace}。`);
	if (type !== 9) throw invalid();
	const size = frame.readUInt32BE(offset);
	offset += 4;
	if (size !== frame.length - offset) throw invalid();
	const final = Boolean(flags & 2);
	if (!size) return { final };
	const encoding = frame[2]! & 0x0f;
	if (frame[2]! >> 4 !== 1 || (encoding !== 0 && encoding !== 1)) throw invalid();
	try {
		const body = frame.subarray(offset);
		const json = encoding === 1 ? gunzipSync(body, { maxOutputLength: MAX_ASR_FRAME_BYTES }) : body;
		const result = JSON.parse(json.toString('utf8')) as { result?: { text?: unknown; utterances?: unknown } } | null;
		if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid();
		return { final, text: typeof result.result?.text === 'string' ? result.result.text : undefined,
			utterances: showUtterances ? speechUtterances(result.result?.utterances) : undefined };
	} catch { throw invalid(); }
}

type RecognitionOptions = { beforeSend?: BeforeSend; connect?: (url: string, options: ClientOptions) => WebSocket };

export async function recognizeSpeech(key: string, { data, format, ...parameters }: {
	data: Uint8Array; format: ArkSpeechAudioFormat;
} & Partial<SpeechRecognitionOptions>, signal: AbortSignal, { beforeSend, connect }: RecognitionOptions = {}): Promise<SpeechRecognitionResult> {
	if (!data.byteLength || data.byteLength > ARK_MAX_ASR_BYTES) throw new Error('待转写的音频不能为空或超过 8 MiB。');
	const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	const audio = audioParameters(bytes, format);
	const { enablePunctuation, normalizeText, showUtterances } = resolveSpeechRecognitionOptions(parameters);
	const active = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
	active.throwIfAborted();
	const id = randomUUID();
	const headers = { ...requestHeaders(key, 'volc.seedasr.sauc.duration', id), 'X-Api-Connect-Id': id, 'X-Api-Sequence': '-1' };
	const target = new URL(ARK_ASR_URL);
	target.protocol = 'https:';
	const agent = connect ? undefined : await getProxyAgent(target);
	active.throwIfAborted();
	await beforeSend?.();
	active.throwIfAborted();
	const options = { agent, headers, followRedirects: false, handshakeTimeout: 15_000, maxPayload: MAX_ASR_FRAME_BYTES, perMessageDeflate: false };
	const socket = connect ? connect(ARK_ASR_URL, options) : new WebSocket(ARK_ASR_URL, options);
	const upload = new AbortController();
	const uploadSignal = AbortSignal.any([active, upload.signal]);
	return new Promise<SpeechRecognitionResult>((resolve, reject) => {
		let trace = '';
		let accepted = false;
		let lastSent = false;
		let settled = false;
		let text = '';
		let utterances: SpeechUtterance[] | undefined;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			active.removeEventListener('abort', stop);
			upload.abort();
			if (error !== undefined) {
				socket.terminate();
				reject(error instanceof Error ? error : new Error('方舟语音识别已中断。'));
			} else {
				socket.close();
				resolve({ text, ...(utterances?.length && { utterances }) });
			}
		};
		const stop = () => finish(active.reason);
		const send = (frame: Buffer) => new Promise<void>((ok, fail) => socket.send(frame, (error) => {
			if (error) fail(new Error(`无法发送方舟语音识别数据${trace}。`));
			else ok();
		}));
		const sendConfiguration = async () => {
			await beforeSend?.();
			uploadSignal.throwIfAborted();
			await send(requestFrame(1, 1, Buffer.from(JSON.stringify({ audio, request: {
				model_name: 'bigmodel', enable_itn: normalizeText, enable_punc: enablePunctuation, result_type: 'full',
				show_utterances: showUtterances || undefined,
			} }))));
		};
		const sendAudio = async () => {
			const segment = 6400 * (format === 'wav' ? audio.channel : 1);
			for (let offset = 0, sequence = 2; offset < bytes.length; offset += segment, sequence++) {
				await beforeSend?.();
				uploadSignal.throwIfAborted();
				lastSent = offset + segment >= bytes.length;
				await send(requestFrame(2, lastSent ? -sequence : sequence, bytes.subarray(offset, offset + segment)));
				if (!lastSent) await delay(100, undefined, { signal: uploadSignal });
			}
		};
		socket.on('upgrade', (result) => { trace = diagnosticId(result.headers['x-tt-logid'], key); });
		socket.on('unexpected-response', (_request, result) => {
			const id = diagnosticId(result.headers['x-tt-logid'], key);
			result.destroy();
			finish(new Error(`方舟语音识别连接失败（HTTP ${result.statusCode ?? 0}）${id}。`));
		});
		socket.on('error', () => finish(new Error(`方舟语音识别连接失败${trace}。`)));
		socket.on('close', () => finish(new Error(`方舟语音识别连接提前关闭${trace}。`)));
		socket.on('open', () => { void sendConfiguration().catch(finish); });
		socket.on('message', (value, binary) => {
			if (settled) return;
			try {
				if (!binary || !Buffer.isBuffer(value)) throw new Error(`方舟语音识别返回了无效消息${trace}。`);
				const result = speechResponse(value, trace, showUtterances);
				if (result.text !== undefined) text = result.text.trim();
				if (result.utterances?.length) utterances = result.utterances;
				if (result.final) {
					if (!lastSent) throw new Error(`音频尚未发送完整，方舟语音识别已结束${trace}。`);
					if (!text && utterances?.length) text = utterances.map((entry) => entry.text).join('\n');
					if (!text) throw new Error('未识别到可转写的语音。');
					finish();
				} else if (!accepted) {
					accepted = true;
					void sendAudio().catch(finish);
				}
			} catch (error) { finish(error); }
		});
		active.addEventListener('abort', stop, { once: true });
		if (active.aborted) stop();
	});
}
