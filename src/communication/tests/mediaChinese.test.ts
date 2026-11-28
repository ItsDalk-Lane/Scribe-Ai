import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { mediaFields, mediaOptions, type MediaAdapter, type MediaCall, type MediaOperation } from '../mediaApi';
import { chineseMedia } from '../mediaChinese';

function adapter(providerId: string, operation: MediaOperation, model: string): MediaAdapter {
	const item = chineseMedia.find((entry) => entry.providerId === providerId && entry.operation === operation && entry.models.includes(model));
	assert.ok(item);
	return item;
}

function context(item: MediaAdapter, model: string, fetcher: typeof fetch, extras: Partial<MediaCall> = {}): MediaCall {
	return { model, key: 'mock-subscription-key', endpoint: item.endpoint({ model }), signal: new AbortController().signal,
		prompt: '请修改提供的素材', fetch: fetcher, options: {}, ...extras };
}

const image = { bytes: Uint8Array.of(1, 2, 3), filename: 'source.png', mimeType: 'image/png' };
const wav = { ...image, filename: 'sample.wav', mimeType: 'audio/wav' };

void test('Qwen subscriptions submit an explicit original video to their own endpoint and poll just that job', async () => {
	const model = 'wan3.0-video';
	const item = adapter('qwen-token-plan-individual', 'video-edit', model);
	const sourceUrl = 'https://media.example.invalid/original.mp4';
	const calls: string[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		calls.push(request.url);
		assert.equal(request.headers.get('authorization'), 'Bearer mock-subscription-key');
		if (request.method === 'POST') {
			assert.equal(request.headers.get('x-dashscope-async'), 'enable');
			assert.deepEqual(await request.json(), {
				model, input: { prompt: '请修改提供的素材', media: [{ type: 'reference_video', url: sourceUrl }] },
				parameters: { ratio: 'adaptive', duration: -1, resolution: '720P' },
			});
			return Response.json({ output: { task_id: 'existing' } });
		}
		return Response.json({ output: { task_status: 'SUCCEEDED', video_url: 'https://media.example.invalid/edited.mp4' } });
	};
	const call = context(item, model, fetcher, { sourceUrl, options: { resolution: '720P' } });
	assert.deepEqual(await item.run(call), { id: 'existing' });
	assert.deepEqual(await item.poll?.(call, 'existing'), {
		status: 'succeeded', result: { url: 'https://media.example.invalid/edited.mp4', extension: 'mp4' },
	});
	assert.deepEqual(calls, ['https://token-plan.maas.qwencloudapi.com/api/v1/services/aigc/video-generation/video-synthesis', 'https://token-plan.maas.qwencloudapi.com/api/v1/tasks/existing']);
	assert.ok(!chineseMedia.some((data) => data.providerId === 'bailian-token-plan' && data.operation === 'video-edit'));
});

void test('HappyHorse first-frame and paid editing requests each have their own source contract and options', async () => {
	const model = 'happyhorse-1.1-i2v';
	const item = adapter('bailian-token-plan', 'video', model);
	const options = mediaOptions(mediaFields(item, model), { duration: 7, watermark: false });
	assert.throws(() => mediaOptions(mediaFields(item, model), { ratio: '16:9' }), /不支持参数/u);
	await assert.rejects(item.run(context(item, model, async () => assert.fail('request without source'))), /源图片/u);
	await item.run(context(item, model, async (input, init) => {
		const request = new Request(input, init);
		assert.equal(new URL(request.url).hostname, 'token-plan.cn-beijing.maas.aliyuncs.com');
		assert.deepEqual(await request.json(), {
			model, input: { prompt: '请修改提供的素材', media: [{ type: 'first_frame', url: 'data:image/png;base64,AQID' }] },
			parameters: { duration: 7, watermark: false },
		});
		return Response.json({ output: { task_id: 'frame-job' } });
	}, { source: image, options }));
	const editModel = 'happyhorse-1.0-video-edit';
	const edit = adapter('bailian-payg', 'video-edit', editModel);
	await edit.run(context(edit, editModel, async (input, init) => {
		const request = new Request(input, init);
		assert.equal(new URL(request.url).hostname, 'dashscope.aliyuncs.com');
		const reply = await request.json() as { input: { media: unknown[] } };
		assert.deepEqual(reply.input.media, [{ type: 'video', url: 'https://media.example.invalid/clip.mp4' }]);
		return Response.json({ output: { task_id: 'editing-job' } });
	}, { sourceUrl: 'https://media.example.invalid/clip.mp4' }));
});

void test('MiniMax uses a scoped subscription key, native speech settings and returned segment timestamps', async () => {
	const model = 'speech-2.8-hd';
	const item = adapter('minimax-m-plan-cn', 'speech-synthesis', model);
	const options = mediaOptions(mediaFields(item, model), { format: 'wav', sample_rate: 16000, speed: 1.3, vol: 0.65 });
	await assert.rejects(item.run(context(item, model, async () => assert.fail('paid key forwarded'), { key: 'sk-api-fixture' })), /订阅密钥/u);
	assert.deepEqual(await item.run(context(item, model, async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, 'https://api.minimax.cn/v1/t2a_v2');
		assert.deepEqual(await request.json(), {
			model, text: '请修改提供的素材', stream: false, output_format: 'hex',
			voice_setting: { voice_id: 'female-shaonv', speed: 1.3, vol: 0.65, pitch: 0 },
			audio_setting: { sample_rate: 16000, format: 'wav', channel: 1 },
		});
		return Response.json({ data: { audio: '010203' }, base_resp: { status_code: 0 } });
	}, { options })), { bytes: Buffer.from([1, 2, 3]), extension: 'wav' });
	const asr = adapter('minimax-cn', 'speech-recognition', 'asr-1.0');
	assert.deepEqual(await asr.run(context(asr, 'asr-1.0', async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.headers.get('language'), 'zh');
		const payload = await request.formData();
		assert.equal(payload.get('timestamp_level'), 'word');
		assert.equal((payload.get('file') as File).name, 'sample.wav');
		return Response.json({ text: '你好', segments: [{ text: '你好', start: 0.12, end: 1.31 }] });
	}, { source: wav, options: { timestamp_level: 'word', language: 'zh' } })), { text: '你好\n\n[0.12s – 1.31s] 你好' });
});

void test('MiMo clones an explicit sample and Ant Ling assembles complete streaming audio', async () => {
	const model = 'mimo-v2.5-tts-voiceclone';
	const item = adapter('xiaomi-token-plan-sgp', 'speech-synthesis', model);
	assert.deepEqual(mediaFields(item, model).map(({ key }) => key), ['format']);
	await item.run(context(item, model, async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions');
		assert.deepEqual(await request.json(), {
			model, messages: [{ role: 'assistant', content: '请修改提供的素材' }],
			audio: { format: 'wav', voice: 'data:audio/wav;base64,AQID' }, stream: false,
		});
		return Response.json({ choices: [{ message: { audio: { data: 'AQID' } } }] });
	}, { source: wav }));
	const tts = adapter('ant-ling', 'speech-synthesis', 'Ming-3.0-tts-0.5B');
	assert.deepEqual(await tts.run(context(tts, 'Ming-3.0-tts-0.5B', async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, 'https://api.ant-ling.com/v1/audio/speech');
		assert.deepEqual(await request.json(), { model: 'Ming-3.0-tts-0.5B', input: '请修改提供的素材', response_format: 'pcm', sample_rate: 16000, stream_format: 'sse' });
		return new Response('data: {"type":"speech.audio.delta","audio":"AQID"}\n\ndata: {"type":"speech.audio.done"}\n\n');
	}, { options: { sample_rate: 16000 } })), { bytes: Buffer.from([1, 2, 3]), extension: 'pcm', sampleRate: 16000 });
});

void test('Z.AI paid video and recognition remain distinct from the coding connection', async () => {
	const item = adapter('zai-payg-cn', 'video', 'cogvideox-3');
	const call = context(item, 'cogvideox-3', async (input, init) => {
		const request = new Request(input, init);
		if (request.method === 'POST') {
			assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/videos/generations');
			const body = await request.json() as { image_url: string[] };
			assert.deepEqual(body.image_url, ['data:image/png;base64,AQID']);
			return Response.json({ id: 'zhipu-job', task_status: 'PROCESSING' });
		}
		assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/async-result/zhipu-job');
		return Response.json({ task_status: 'SUCCESS', video_result: [{ url: 'https://media.example.invalid/clip.mp4' }] });
	}, { source: image });
	assert.deepEqual(await item.run(call), { id: 'zhipu-job' });
	assert.deepEqual(await item.poll?.(call, 'zhipu-job'), { status: 'succeeded', result: { url: 'https://media.example.invalid/clip.mp4', extension: 'mp4' } });
	assert.ok(!chineseMedia.some((data) => data.providerId === 'zai-coding-cn' || data.providerId === 'zai'));
});

void test('DeepSeek uses the standalone speech APIs without sending local selection IDs in the request', async () => {
	const tts = adapter('deepseek', 'speech-synthesis', 'deepseek-tts');
	const pcm = await tts.run(context(tts, 'deepseek-tts', async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, 'https://api.deepseek.com/v1/tools/tts');
		assert.equal(request.headers.get('authorization'), 'Bearer mock-subscription-key');
		assert.deepEqual(await request.json(), { text: '请修改提供的素材', format: 'pcm', voice_id: 'tide', filter_markdown: false });
		return new Response(Uint8Array.of(1, 2, 3, 4));
	}, { options: { format: 'pcm', voice_id: 'tide', filter_markdown: false } }));
	assert.deepEqual(pcm, { bytes: Buffer.from([1, 2, 3, 4]), extension: 'pcm', sampleRate: 24000 });
	const asr = adapter('deepseek', 'speech-recognition', 'deepseek-asr');
	assert.equal(mediaFields(asr, 'deepseek-asr').length, 0);
	assert.deepEqual(await asr.run(context(asr, 'deepseek-asr', async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, 'https://api.deepseek.com/v1/tools/asr');
		const form = await request.formData();
		const fields: string[] = [];
		form.forEach((_, key) => fields.push(key));
		assert.deepEqual(fields, ['file']);
		assert.equal((form.get('file') as File).name, wav.filename);
		return Response.json({ text: '已识别', duration_ms: 1000 });
	}, { source: wav })), { text: '已识别' });
});
