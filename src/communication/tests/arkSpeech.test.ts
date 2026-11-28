import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { ARK_ASR_URL, ARK_DEFAULT_VOICE, ARK_TTS_URL, recognizeSpeech, synthesizeSpeech } from '../arkSpeech';

const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0xc4, 0x11, 0x22, 0x33, 0x44]);
const signal = new AbortController().signal;

void test('Agent Plan TTS sends only the approved request and assembles streamed MP3 bytes', async () => {
	let checked = false;
	const first = JSON.stringify({ code: 0, data: mp3.subarray(0, 3).toString('base64') });
	const second = JSON.stringify({ code: 0, data: mp3.subarray(3).toString('base64') });
	const audio = await synthesizeSpeech((input, init) => {
		assert.ok(checked);
		const request = new Request(input, init);
		assert.equal(request.url, ARK_TTS_URL);
		assert.equal(request.method, 'POST');
		assert.equal(request.redirect, 'error');
		assert.equal(request.headers.get('X-Api-Key'), 'fixture-key');
		assert.equal(request.headers.get('X-Api-Resource-Id'), 'seed-tts-2.0');
		assert.match(request.headers.get('X-Api-Request-Id') ?? '', /^[\da-f-]{36}$/u);
		const body = init?.body;
		assert.ok(typeof body === 'string');
		assert.deepEqual(JSON.parse(body), { req_params: { text: '你好', speaker: ARK_DEFAULT_VOICE,
			audio_params: { format: 'mp3', sample_rate: 24_000 } } });
		return Promise.resolve(new Response(new ReadableStream({ start(controller) {
			for (const chunk of [first.slice(0, 7), first.slice(7) + '\r\n\n' + second, '\n{"code":20000000,"data":null}']) {
				controller.enqueue(Buffer.from(chunk));
			}
			controller.close();
		} })));
	}, 'fixture-key', { text: '你好' }, signal, () => { checked = true; });
	assert.deepEqual(audio, mp3);
});

void test('Agent Plan TTS discards incomplete audio, redacts remote errors and cancels a stalled body', async () => {
	const first = JSON.stringify({ code: 0, data: mp3.toString('base64') }) + '\n';
	const fake = (body: string) => () => Promise.resolve(new Response(body));
	await assert.rejects(synthesizeSpeech(fake(first), 'fixture-key', { text: '测试' }, signal), /未返回完整/u);
	await assert.rejects(synthesizeSpeech(fake(first + '{"code":50000000,"message":"fixture-key"}'), 'fixture-key', { text: '测试' }, signal),
		{ message: '方舟语音合成失败（50000000）。' });
	await assert.rejects(synthesizeSpeech(() => assert.fail('unexpected send'), 'fixture-key', { text: '测'.repeat(342) }, signal), /1024 字节/u);
	const controller = new AbortController();
	let cancelled = false;
	const result = synthesizeSpeech(() => Promise.resolve(new Response(new ReadableStream({
		start(stream) { stream.enqueue(Buffer.from(first)); }, cancel() { cancelled = true; },
	}))), 'fixture-key', { text: '测试' }, controller.signal);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error('本地停止'));
	await assert.rejects(result, /本地停止/u);
	assert.ok(cancelled);
});

function wave(data: Buffer, sampleRate: number, streaming = false): Buffer {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(streaming ? 0xffff_ffff : 36 + data.length, 4);
	header.write('WAVEfmt ', 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36);
	header.writeUInt32LE(streaming ? 0xffff_ffff : data.length, 40);
	return Buffer.concat([header, data]);
}

function ttsReply(...parts: Buffer[]): Response {
	return new Response([...parts.map((data) => JSON.stringify({ code: 0, data: data.toString('base64') })), '{"code":20000000}'].join('\n'));
}

void test('Agent Plan TTS sends the chosen audio format, sampling rate, speed and volume', async () => {
	const opus = Buffer.alloc(47);
	opus.write('OggS', 0);
	opus[26] = 1;
	opus[27] = 19;
	opus.write('OpusHead', 28);
	opus[36] = 1;
	opus[37] = 1;
	const pcm = Buffer.from([0, 0, 255, 255]);
	for (const [format, sampleRate, payload, rate] of [
		['ogg_opus', undefined, opus, 48_000],
		['pcm', 22_050, pcm, 22_050],
		['wav', 16_000, wave(pcm, 16_000), 16_000],
	] as const) {
		const result = await synthesizeSpeech((_input, init) => {
			const body = init?.body;
			assert.ok(typeof body === 'string');
			assert.deepEqual(JSON.parse(body), { req_params: { text: '你好', speaker: ARK_DEFAULT_VOICE, audio_params: {
				format, sample_rate: rate, speech_rate: -25, loudness_rate: 42,
			} } });
			return Promise.resolve(ttsReply(payload));
		}, 'fixture-key', { text: '你好', format, sampleRate, speechRate: -25, loudnessRate: 42 }, signal);
		assert.deepEqual(result, payload);
	}
	const noRequest = () => assert.fail('unexpected send');
	await assert.rejects(synthesizeSpeech(noRequest, 'fixture-key', { text: '你好', format: 'ogg_opus', sampleRate: 24_000 }, signal), /采样率/u);
	await assert.rejects(synthesizeSpeech(noRequest, 'fixture-key', { text: '你好', speechRate: 101 }, signal), /语速/u);
	await assert.rejects(synthesizeSpeech(() => Promise.resolve(ttsReply(mp3)), 'fixture-key', { text: '你好', format: 'ogg_opus' }, signal), /未返回完整的 OGG Opus/u);
});

void test('Agent Plan TTS keeps all WAV samples from complete segments and fixes streaming length markers', async () => {
	const first = Buffer.from([0, 0, 255, 255]);
	const last = Buffer.from([128, 128, 16, 16]);
	const sampleRate = 16_000;
	const synthesize = (...chunks: Buffer[]) => synthesizeSpeech(() => Promise.resolve(ttsReply(...chunks)), 'fixture-key',
		{ text: '你好', format: 'wav', sampleRate }, signal);
	const expected = wave(Buffer.concat([first, last]), sampleRate);
	assert.deepEqual(await synthesize(wave(first, sampleRate), wave(last, sampleRate)), expected);
	assert.deepEqual(await synthesize(wave(first, sampleRate, true), last), expected);
	await assert.rejects(synthesize(wave(first, sampleRate), wave(last, 24_000)), /未返回完整的 WAV/u);
});

function response(text?: string, final = false, utterances?: unknown[]) {
	const payload = gzipSync(JSON.stringify(text === undefined && utterances === undefined ? {} : { result: { text, utterances } }));
	const header = Buffer.from([0x11, final ? 0x93 : 0x91, 0x11, 0]);
	const prefix = Buffer.alloc(8);
	prefix.writeInt32BE(final ? -3 : 1);
	prefix.writeUInt32BE(payload.length, 4);
	return Buffer.concat([header, prefix, payload]);
}

async function server(t: TestContext) {
	const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' });
	t.after(() => new Promise<void>((resolve) => {
		for (const client of ws.clients) client.terminate();
		ws.close(() => resolve());
	}));
	await once(ws, 'listening');
	const address = ws.address();
	assert.ok(address && typeof address !== 'string');
	return { ws, local: `ws://127.0.0.1:${address.port}` };
}

void test('Agent Plan ASR uses authenticated binary frames, waits for configuration approval and returns the final transcript', async (t) => {
	const { ws, local } = await server(t);
	const data = Buffer.concat([mp3, Buffer.alloc(6400, 1)]);
	const parts: Buffer[] = [];
	const settings: unknown[] = [];
	ws.on('connection', (peer, request) => {
		assert.equal(request.headers['x-api-key'], 'fixture-key');
		assert.equal(request.headers['x-api-resource-id'], 'volc.seedasr.sauc.duration');
		assert.equal(request.headers['x-api-sequence'], '-1');
		assert.equal(request.headers['x-api-connect-id'], request.headers['x-api-request-id']);
		assert.match(String(request.headers['x-api-connect-id']), /^[\da-f-]{36}$/u);
		peer.on('message', (frame, binary) => {
			assert.ok(binary && Buffer.isBuffer(frame));
			assert.equal(frame.readUInt32BE(8), frame.length - 12);
			const payload = gunzipSync(frame.subarray(12));
			if (frame[1] === 0x11) {
				assert.equal(frame.readInt32BE(4), 1);
				settings.push(JSON.parse(payload.toString('utf8')));
				peer.send(response());
				return;
			}
			parts.push(payload);
			if (frame[1] === 0x23) {
				assert.equal(frame.readInt32BE(4), -3);
				peer.send(response('完整转写。', true));
			} else {
				assert.equal(frame[1], 0x21);
				assert.equal(frame.readInt32BE(4), 2);
				peer.send(response('初稿'));
			}
		});
	});
	let checks = 0;
	const result = await recognizeSpeech('fixture-key', { format: 'mp3', data }, signal, {
		beforeSend: () => { checks++; },
		connect: (url, options) => {
			assert.equal(url, ARK_ASR_URL);
			assert.equal(options.followRedirects, false);
			assert.equal(checks, 1);
			return new WebSocket(local, options);
		},
	});
	assert.equal(checks, 4);
	assert.deepEqual(result, { text: '完整转写。' });
	assert.deepEqual(Buffer.concat(parts), data);
	assert.deepEqual(settings, [{ audio: { format: 'mp3', codec: 'raw', rate: 16_000, bits: 16, channel: 1 },
		request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, result_type: 'full' } }]);
});

void test('Agent Plan ASR passes disabled punctuation and normalization and returns requested sentence timings', async (t) => {
	const { ws, local } = await server(t);
	ws.on('connection', (peer) => {
		peer.on('message', (frame, binary) => {
			assert.ok(binary && Buffer.isBuffer(frame));
			if (frame[1] === 0x11) {
				assert.deepEqual(JSON.parse(gunzipSync(frame.subarray(12)).toString('utf8')), {
					audio: { format: 'mp3', codec: 'raw', rate: 16_000, bits: 16, channel: 1 },
					request: { model_name: 'bigmodel', enable_itn: false, enable_punc: false, result_type: 'full', show_utterances: true },
				});
				peer.send(response());
			} else {
				assert.equal(frame[1], 0x23);
				peer.send(response('一九七零年 下一句', true, [
					{ text: ' 一九七零年 ', start_time: 0, end_time: 675, definite: true },
					{ text: '下一句', start_time: 800, end_time: 1250, definite: true },
					{ text: ' ', start_time: 1250 },
				]));
			}
		});
	});
	const result = await recognizeSpeech('fixture-key', {
		format: 'mp3', data: mp3, enablePunctuation: false, normalizeText: false, showUtterances: true,
	}, signal, { connect: (_url, options) => new WebSocket(local, options) });
	assert.deepEqual(result, { text: '一九七零年 下一句', utterances: [
		{ text: '一九七零年', startMs: 0, endMs: 675 },
		{ text: '下一句', startMs: 800, endMs: 1250 },
	] });
});

void test('Agent Plan ASR rejects early disconnects and never sends audio after permission is revoked', async (t) => {
	const { ws, local } = await server(t);
	const connect: NonNullable<NonNullable<Parameters<typeof recognizeSpeech>[3]>['connect']> = (_url, options) => new WebSocket(local, options);
	let receives = 0;
	ws.on('connection', (peer) => {
		peer.on('message', () => {
			receives++;
			peer.send(response('部分转写'));
			if (receives === 2) peer.close();
		});
	});
	await assert.rejects(recognizeSpeech('fixture-key', { format: 'mp3', data: mp3 }, signal, { connect }), /提前关闭/u);
	let checks = 0;
	await assert.rejects(recognizeSpeech('fixture-key', { format: 'mp3', data: mp3 }, signal, {
		connect, beforeSend() { if (++checks === 3) throw new Error('设置已变化'); },
	}), /设置已变化/u);
	assert.equal(receives, 3);
	checks = 0;
	await assert.rejects(recognizeSpeech('fixture-key', { format: 'mp3', data: mp3 }, signal, {
		connect, beforeSend() { if (++checks === 2) throw new Error('握手后设置变化'); },
	}), /握手后设置变化/u);
	assert.equal(receives, 3);
	await assert.rejects(recognizeSpeech('fixture-key', { format: 'wav', data: mp3 }, signal, {
		connect: () => assert.fail('unexpected connection'),
	}), /WAV 须为/u);
});

void test('Agent Plan ASR never follows a credentialed redirect and abort closes an active socket', async (t) => {
	const { ws, local } = await server(t);
	const redirect = createServer((_request, response) => {
		response.writeHead(302, { Location: local, 'X-Tt-Logid': 'fixture-key' });
		response.end();
	});
	redirect.listen(0, '127.0.0.1');
	t.after(() => new Promise<void>((resolve) => redirect.close(() => resolve())));
	await once(redirect, 'listening');
	const address = redirect.address();
	assert.ok(address && typeof address !== 'string');
	let reached = 0;
	ws.on('connection', () => { reached++; });
	await assert.rejects(recognizeSpeech('fixture-key', { format: 'mp3', data: mp3 }, signal, {
		connect: (_url, options) => new WebSocket(`ws://127.0.0.1:${address.port}`, options),
	}), { message: '方舟语音识别连接失败（HTTP 302）。' });
	assert.equal(reached, 0);

	const accepted = once(ws, 'connection');
	const controller = new AbortController();
	const pending = recognizeSpeech('fixture-key', { format: 'mp3', data: mp3 }, controller.signal, {
		connect: (_url, options) => new WebSocket(local, options),
	});
	const [peer] = await accepted as [WebSocket];
	const closed = once(peer, 'close');
	controller.abort(new Error('本地停止'));
	await assert.rejects(pending, /本地停止/u);
	await closed;
});
