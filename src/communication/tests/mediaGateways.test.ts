import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { mediaFields, mediaOptions, type MediaAdapter, type MediaCall, type MediaOperation } from '../mediaApi';
import { gatewayMedia } from '../mediaGateways';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const mp3 = Buffer.from('4944330300000000', 'hex');
const videoUrl = 'https://output.example/video.mp4';

function adapter(providerId: string, operation: MediaOperation, model: string): MediaAdapter {
	const selected = gatewayMedia.find((row) => row.providerId === providerId && row.operation === operation && row.models.includes(model));
	assert.ok(selected);
	return selected;
}

function call(selected: MediaAdapter, model: string, execute: (request: Request) => Response | Promise<Response>,
	overrides: Partial<MediaCall> = {}): MediaCall {
	const endpoint = selected.endpoint({ model, baseUrl: overrides.baseUrl });
	return { model, endpoint, key: 'test-key', signal: new AbortController().signal, prompt: 'fixture', options: {},
		fetch: async (input, init) => {
			const request = new Request(input, init);
			assert.equal(request.headers.get('Authorization'), 'Bearer test-key');
			assert.equal(request.redirect, 'error');
			return execute(request);
		}, ...overrides };
}

void test('OpenRouter applies the form of the selected image model and polls an original video edit job', async () => {
	const imageModel = 'openai/gpt-image-2.6-flare';
	const imageEdit = adapter('openrouter', 'image-edit', imageModel);
	const options = mediaOptions(mediaFields(imageEdit, imageModel), { output_format: 'png', quality: 'high' });
	assert.throws(() => mediaOptions(mediaFields(imageEdit, 'google/gemini-3.1-flash-image'), options), /不支持/u);
	const image = await imageEdit.run(call(imageEdit, imageModel, async (request) => {
		assert.equal(request.url, 'https://openrouter.ai/api/v1/images');
		assert.deepEqual(await request.json(), { model: imageModel, prompt: 'fixture', quality: 'high', output_format: 'png',
			response_format: 'b64_json', input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } }] });
		return Response.json({ data: [{ b64_json: png.toString('base64') }] });
	}, { options, source: { bytes: png, filename: 'source.png', mimeType: 'image/png' } }));
	assert.deepEqual(image, { bytes: png, extension: 'png' });

	const videoModel = 'black-forest-labs/flux-video-edit';
	const edit = adapter('openrouter', 'video-edit', videoModel);
	const ctx = call(edit, videoModel, async (request) => {
		if (request.method === 'GET') {
			assert.equal(request.url, 'https://openrouter.ai/api/v1/videos/gen-video-1');
			return Response.json({ status: 'completed', urls: [videoUrl] });
		}
		assert.equal(request.url, 'https://openrouter.ai/api/v1/videos');
		assert.deepEqual(await request.json(), { model: videoModel, prompt: 'fixture',
			input_references: [{ type: 'video_url', video_url: { url: 'https://input.example/clip.mp4' } }] });
		return Response.json({ id: 'gen-video-1' });
	}, { sourceUrl: 'https://input.example/clip.mp4' });
	assert.deepEqual(await edit.run(ctx), { id: 'gen-video-1' });
	assert.deepEqual(await edit.poll?.(ctx, 'gen-video-1'), { status: 'succeeded', result: { url: videoUrl, extension: 'mp4' } });
	await assert.rejects(edit.poll?.(ctx, '../../unrelated') ?? Promise.resolve(), /任务编号/u);
});

void test('Vercel stores only a validated opaque video token and restores it for status queries', async () => {
	const model = 'spacexai/grok-imagine-video';
	const selected = adapter('vercel-ai-gateway', 'video-edit', model);
	const operation = { provider: 'spacexai', request: 'video_1' };
	const result = await selected.run(call(selected, model, async (request) => {
		assert.equal(request.headers.get('ai-video-model-specification-version'), '4');
		assert.equal(request.headers.get('ai-model-id'), model);
		assert.deepEqual(await request.json(), { prompt: 'fixture', n: 1,
			providerOptions: { xai: { mode: 'edit-video', videoUrl: 'https://input.example/clip.mp4' } } });
		return Response.json({ operation });
	}, { sourceUrl: 'https://input.example/clip.mp4' }));
	assert.ok('id' in result);
	assert.deepEqual(await selected.poll?.(call(selected, model, async (request) => {
		assert.equal(new URL(request.url).pathname, '/v4/ai/video-model/status');
		assert.deepEqual(await request.json(), { operation });
		return Response.json({ status: 'completed', videos: [{ type: 'url', url: videoUrl }] });
	}), result.id), { status: 'succeeded', result: { url: videoUrl, extension: 'mp4' } });
	await assert.rejects(selected.run(call(selected, model,
		() => Response.json({ operation: { source: 'https://input.example/clip.mp4' } }), { sourceUrl: 'https://input.example/clip.mp4' })), /安全保存/u);
});

void test('Vercel sets first-frame requirements and native resolution per video model', async () => {
	const model = 'spacexai/grok-imagine-video-1.5';
	const selected = adapter('vercel-ai-gateway', 'video', model);
	assert.equal(selected.requiresSource, true);
	assert.equal(selected.input, 'image');
	await assert.rejects(selected.run(call(selected, model, () => assert.fail('missing image must stop before sending'))), /附加/u);
	const result = await selected.run(call(selected, model, async (request) => {
		assert.deepEqual(await request.json(), { prompt: 'fixture', n: 1, providerOptions: { xai: { resolution: '720p' } },
			image: { type: 'file', data: png.toString('base64'), mediaType: 'image/png' } });
		return Response.json({ operation: 'video_2' });
	}, { options: { resolution: '720p' }, source: { bytes: png, filename: 'original.png', mimeType: 'image/png' } }));
	assert.ok('id' in result);
	const lite = adapter('vercel-ai-gateway', 'video', 'spacexai/grok-imagine-video-1.5-lite');
	assert.equal(lite.requiresSource, undefined);
});

void test('Cloudflare requires an official account and sends the actual original video in the native shape', async () => {
	const model = 'runwayml/aleph-2';
	const selected = adapter('cloudflare-ai-gateway', 'video-edit', model);
	assert.throws(() => selected.endpoint({ model, baseUrl: 'https://not-cloudflare.example' }), /官方账户/u);
	const accountId = 'ff'.repeat(16);
	const clip = Buffer.from('test-video');
	const result = await selected.run(call(selected, model, async (request) => {
		assert.equal(request.url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`);
		assert.equal(request.headers.get('cf-aig-gateway-id'), 'workspace');
		assert.deepEqual(await request.json(), { model, input: { prompt: 'fixture', video_uri: 'data:video/mp4;base64,' + clip.toString('base64'), seed: 19 } });
		return Response.json({ state: 'Completed', result: { video: videoUrl } });
	}, { baseUrl: `https://gateway.ai.cloudflare.com/v1/${accountId}/workspace/compat`, options: { seed: 19 },
		source: { bytes: clip, mimeType: 'video/mp4', filename: 'original.mp4' } }));
	assert.deepEqual(result, { url: videoUrl, extension: 'mp4' });
});

void test('Together uses separate binary speech output and multipart speech recognition', async () => {
	const speech = adapter('together', 'speech-synthesis', 'hexgrad/Kokoro-82M');
	const options = mediaOptions(mediaFields(speech, 'hexgrad/Kokoro-82M'), { response_format: 'mp3', voice: 'af_heart' });
	const output = await speech.run(call(speech, 'hexgrad/Kokoro-82M', async (request) => {
		assert.equal(new URL(request.url).pathname, '/v1/audio/speech');
		assert.deepEqual(await request.json(), { model: 'hexgrad/Kokoro-82M', input: 'fixture', response_format: 'mp3', voice: 'af_heart' });
		return new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } });
	}, { options }));
	assert.deepEqual(output, { bytes: mp3, extension: 'mp3' });
	const model = 'openai/whisper-large-v3';
	const transcribe = adapter('together', 'speech-recognition', model);
	const text = await transcribe.run(call(transcribe, model, async (request) => {
		const form = await request.formData();
		assert.equal(form.get('model'), model);
		assert.equal(form.get('language'), 'en');
		const file = form.get('file');
		assert.ok(file instanceof File);
		assert.equal(file.name, 'speech.mp3');
		assert.deepEqual(Buffer.from(await file.arrayBuffer()), mp3);
		return Response.json({ text: 'Hello' });
	}, { options: { language: 'en' }, source: { bytes: mp3, filename: 'speech.mp3', mimeType: 'audio/mpeg' } }));
	assert.deepEqual(text, { text: 'Hello' });
});

void test('Hugging Face status always uses its own router and refuses provider-supplied foreign URLs', async () => {
	const model = 'Wan-AI/Wan2.2-TI2V-5B';
	const selected = adapter('huggingface', 'video', model);
	const ctx = call(selected, model, async (request) => {
		assert.equal(new URL(request.url).origin, 'https://router.huggingface.co');
		assert.equal(new URL(request.url).searchParams.get('_subdomain'), 'queue');
		if (request.method === 'POST') {
			assert.deepEqual(await request.json(), { prompt: 'fixture', resolution: '580p', num_frames: 25 });
			return Response.json({ request_id: 'job-7', response_url: 'https://queue.fal.run/fal-ai/wan/requests/job-7' });
		}
		if (new URL(request.url).pathname.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
		return Response.json({ video: { url: videoUrl } });
	}, { options: { resolution: '580p', num_frames: 25 } });
	assert.deepEqual(await selected.run(ctx), { id: 'job-7' });
	assert.deepEqual(await selected.poll?.(ctx, 'job-7'), { status: 'succeeded', result: { url: videoUrl, extension: 'mp4' } });
	await assert.rejects(selected.run(call(selected, model, () =>
		Response.json({ request_id: 'job-7', response_url: 'https://foreign.example/fal-ai/wan/requests/job-7' }))), /任务地址/u);
});

void test('Radius uses the native image endpoint with the same bearer credential and sends the edit source', async () => {
	const model = 'gemini-3.1-flash-image';
	const selected = adapter('radius', 'image-edit', model);
	const result = await selected.run(call(selected, model, async (request) => {
		assert.equal(request.url, 'https://radius.pi.dev/v1/image');
		assert.deepEqual(await request.json(), { model, context: { input: [
			{ type: 'text', text: 'fixture' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
		] }, options: { size: '2K', aspectRatio: '16:9' } });
		return Response.json({ output: [{ type: 'text', text: 'Generated' }, { type: 'image', data: png.toString('base64') }] });
	}, { options: { size: '2K', aspectRatio: '16:9' }, source: { bytes: png, filename: 'source.png', mimeType: 'image/png' } }));
	assert.deepEqual(result, { bytes: png, extension: 'png' });
});

void test('Fireworks SDXL uses different requests for generation and multipart editing', async () => {
	const model = 'accounts/fireworks/models/stable-diffusion-xl-1024-v1-0';
	const generate = adapter('fireworks', 'image', model);
	const generated = await generate.run(call(generate, model, async (request) => {
		assert.equal(new URL(request.url).pathname, '/inference/v1/image_generation/' + model);
		assert.equal(request.headers.get('Accept'), 'image/png');
		assert.deepEqual(await request.json(), { prompt: 'fixture', width: 1152, height: 896, steps: 15, samples: 1 });
		return new Response(png, { headers: { 'Content-Type': 'image/png' } });
	}, { options: { size: '1152x896', steps: 15 } }));
	assert.deepEqual(generated, { bytes: png, extension: 'png' });

	const edit = adapter('fireworks', 'image-edit', model);
	const result = await edit.run(call(edit, model, async (request) => {
		assert.equal(new URL(request.url).pathname, '/inference/v1/image_generation/' + model + '/image_to_image');
		const body = await request.formData();
		assert.equal(body.get('init_image_mode'), 'IMAGE_STRENGTH');
		assert.equal(body.get('image_strength'), '0.35');
		const file = body.get('init_image');
		assert.ok(file instanceof File);
		assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
		return new Response(png, { headers: { 'Content-Type': 'image/png' } });
	}, { options: mediaOptions(mediaFields(edit, model), undefined), source: { bytes: png, filename: 'source.png', mimeType: 'image/png' } }));
	assert.deepEqual(result, { bytes: png, extension: 'png' });
});
