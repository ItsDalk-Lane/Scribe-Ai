import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ARK_ASR_URL, ARK_TTS_URL } from '../../communication/arkSpeech';
import type { recognizeSpeech } from '../../communication/arkSpeech';
import { ARK_IMAGE_URL, ARK_VIDEO_URL } from '../../communication/arkVisual';
import { createContextBuilder } from '../../orchestration/context/contextBuilder';
import { createMediaVideoJobs } from '../../orchestration/mediaVideoJobs';
import { createRunContext } from '../../orchestration/runContext';
import { DEFAULT_SETTINGS } from '../../orchestration/settings/defaults';
import { AGENT_PLAN_PROVIDER_ID, resolveSpeechRecognitionOptions, resolveSpeechSynthesisOptions } from '../../orchestration/settings/mediaSettings';
import { createConversationStore } from '../../orchestration/storage/conversationStore';
import { isGeneratedMediaCachePath, scribeDataPaths } from '../../orchestration/storage/paths';
import { createTask } from '../../orchestration/taskManager';
import { TOOL_NOT_APPROVED, type NoteRef, type ToolContext } from '../../types';
import { createToolRegistry } from '..';
import { createToolExecutor } from '../executor';
import { arkPlanConnection, createMediaTools } from '../external/mediaTools';

const key = 'fixture-media-plan-key';
const credentialId = 'fixture-agent-plan';
const conversationId = 'media-fixture';
const imageModel = 'doubao-seedream-5.0-flash';
const videoModel = 'doubao-seedance-2.5-flash';
const voice = 'zh_female_gaolengyujie_uranus_bigtts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0xc4, 0x10, 0x20, 0x30, 0x40]);

async function fixture(t: TestContext, speech: { output?: Buffer; recognize?: typeof recognizeSpeech } = {},
	refreshRadiusLogin?: (credentials: Map<string, string>) => Promise<void>) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), 'scribe-media-tools-')));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.communication.credentialIds[AGENT_PLAN_PROVIDER_ID] = credentialId;
	settings.providerModels[AGENT_PLAN_PROVIDER_ID] = ['doubao-seedream-5.5', imageModel, 'doubao-seedance-2.5', videoModel,
		'doubao-seed-tts-2.0', 'doubao-seed-asr-2.0'];
	settings.media = { models: { image: imageModel, video: videoModel }, speechDirectory: '素材/配音' };
	settings.modelOverrides[AGENT_PLAN_PROVIDER_ID] = {
		'doubao-seedream-5.5': { imageDefaults: { format: 'jpeg' } },
		[imageModel]: { imageDefaults: { size: '1.5K', background: 'opaque', format: 'png' } },
		'doubao-seedance-2.5': { videoDefaults: { resolution: '4k', duration: 12 } },
		[videoModel]: { videoDefaults: { resolution: '720p', duration: 7, ratio: '9:16' } },
		'doubao-seed-tts-2.0': { voice },
	};
	const credentials = new Map([[credentialId, key]]);
	const app = { vault: { configDir: 'vault-configuration' }, secretStorage: { getSecret: (id: string) => credentials.get(id) ?? null } } as ToolContext['app'];
	const paths = scribeDataPaths(cwd);
	const conversations = createConversationStore(paths.conversations, undefined, paths.cache);
	assert.ok(conversations.mediaVideoHistory);
	const videos = createMediaVideoJobs({ history: conversations.mediaVideoHistory, cwd, configDir: app.vault.configDir,
		connection: () => arkPlanConnection(settings, app.secretStorage), fetcher: () => assert.fail('unexpected video request') });
	t.after(() => videos.dispose());
	const transport: { requests: Request[]; beforeSend?: () => void } = { requests: [] };
	const mediaTools = createMediaTools({ settings, secrets: app.secretStorage, conversations, videos,
		recognize: speech.recognize,
		refreshRadiusLogin: refreshRadiusLogin && (() => refreshRadiusLogin(credentials)),
		async fetcher(input, init, confirm) {
			const request = new Request(input, init);
			assert.ok(confirm);
			transport.beforeSend?.();
			await confirm(new URL(request.url));
			transport.requests.push(request);
			if (request.url === ARK_IMAGE_URL) return Response.json({ data: [{ b64_json: png.toString('base64') }], usage: { completion_tokens: 321 } });
			if (request.url === ARK_IMAGE_URL.replace('/plan/', '/')) return Response.json({ data: [{ b64_json: png.toString('base64') }] });
			if (request.url === 'https://radius.pi.dev/v1/image') return Response.json({ output: [{ type: 'image', data: png.toString('base64') }] });
			if (request.url === ARK_TTS_URL) return new Response(`${JSON.stringify({ code: 0, data: (speech.output ?? mp3).toString('base64') })}\n{"code":20000000}\n`);
			return assert.fail('unexpected request address');
		},
	});
	const registry = createToolRegistry([mediaTools]);
	const executor = createToolExecutor(registry, paths.cache);
	const model = { providerId: 'fixture', model: 'fixture' };
	const createRun = (refs: NoteRef[] = [], toolsEnabled = true) => createRunContext(createTask({ conversationId, instruction: '生成媒体', refs }),
		{ cwd, signal: new AbortController().signal, model, observer: {} }, app.vault.configDir, () => toolsEnabled, false, 'ask');
	const execute = async (name: string, input: unknown, approve?: ToolContext['approve'], refs?: NoteRef[]) =>
		executor.execute({ id: 'fixture-call', name, input }, { ...await createRun(refs), app, approve });
	return { cwd, settings, credentials, transport, registry, createRun, execute };
}

void test('Radius image uses the linked login, refreshes expiry, and stops after a credential change at approval', async (t) => {
	const login = (access: string, expires: number) => JSON.stringify({ type: 'oauth', access, refresh: 'test-refresh', expires });
	let refreshes = 0;
	const { settings, credentials, transport, execute } = await fixture(t, {}, (credentials) => {
		refreshes++;
		credentials.set('radius-login', login('fresh-token', Date.now() + 60_000));
		return Promise.resolve();
	});
	const model = 'gemini-nano-banana-2.1';
	settings.providerModels.radius = [model];
	settings.communication.credentialIds.radius = 'radius-login';
	settings.media!.selections = { image: { providerId: 'radius', model } };
	credentials.set('radius-login', login('expired-token', 1));
	const input = { prompt: '生成一张明亮的风景照' };
	const changed = await execute('GenerateImage', input, async () => {
		credentials.set('radius-login', login('changed-token', Date.now() + 60_000));
		return true;
	});
	assert.match(changed.content, /设置或聊天权限已变更/u);
	assert.equal(transport.requests.length, 0);
	const result = await execute('GenerateImage', input, async () => true);
	assert.equal(result.isError, false, result.content);
	assert.equal(refreshes, 1);
	assert.equal(transport.requests[0]?.headers.get('Authorization'), 'Bearer changed-token');
});

void test('the linked Agent Plan key enables explicitly added media models and preserves chat tools and attachment permissions', async (t) => {
	const { cwd, settings, credentials, transport, registry, createRun, execute } = await fixture(t);
	delete settings.media;
	const context = createContextBuilder(registry);
	const request = async (toolsEnabled = true) => context.build(await createRun([], toolsEnabled), [], 100_000);
	const added = settings.providerModels[AGENT_PLAN_PROVIDER_ID]!;
	settings.providerModels[AGENT_PLAN_PROVIDER_ID] = ['ark-code-latest'];
	assert.deepEqual((await request()).tools, []);
	settings.providerModels[AGENT_PLAN_PROVIDER_ID] = ['doubao-seed-tts-2.0'];
	assert.deepEqual((await request()).tools.map(({ name }) => name), ['Speech']);
	assert.match((await execute('Speech', { action: 'recognize', audioPath: 'test.mp3' })).content, /对应的语音模型/u);
	settings.providerModels[AGENT_PLAN_PROVIDER_ID] = added;
	assert.deepEqual((await request()).tools.map(({ name }) => name), ['GenerateImage', 'GenerateVideo', 'EditImage', 'EditVideo', 'Speech']);
	assert.deepEqual((await request(false)).tools, []);
	const speech = (await request()).tools.find(({ name }) => name === 'Speech');
	assert.ok(speech);
	assert.deepEqual((speech.inputSchema.properties as { action?: { enum?: string[] } }).action?.enum, ['synthesize', 'recognize']);
	const audioPath = '测试音频.mp3';
	await writeFile(join(cwd, audioPath), mp3);
	const input = { action: 'recognize', audioPath };
	assert.match((await execute('Speech', input, () => assert.fail('unexpected approval'))).content,
		/明确附加/u);
	const denied = await execute('Speech', input, async (approval) => {
		assert.equal(approval.kind, 'media');
		assert.equal(approval.target, ARK_ASR_URL);
		assert.deepEqual(JSON.parse(approval.after!), { model: 'doubao-seed-asr-2.0', audioPath, format: 'mp3', bytes: mp3.length,
			...resolveSpeechRecognitionOptions() });
		return false;
	}, [{ path: audioPath, kind: 'file' }]);
	assert.deepEqual(denied, { callId: 'fixture-call', isError: true, content: TOOL_NOT_APPROVED });
	credentials.delete(credentialId);
	assert.deepEqual((await request()).tools, []);
	assert.match((await execute('Speech', { action: 'recognize' })).content, /工具不可用/u);
	assert.equal(transport.requests.length, 0);
});

void test('media selection binds the provider, operation-specific defaults, and attachment approval to the dispatched request', async (t) => {
	const { cwd, settings, credentials, transport, execute } = await fixture(t);
	const model = 'doubao-seedream-5-5-261028';
	const providerId = 'volcengine-doubao';
	settings.providerModels[providerId] = [model];
	settings.communication.credentialIds[providerId] = 'paid-key';
	credentials.set('paid-key', 'fixture-paid-secret');
	settings.media!.selections = { 'image-edit': { providerId, model } };
	settings.modelOverrides[providerId] = { [model]: {
		mediaOptions: { image: { size: '1K' }, 'image-edit': { size: '2K', output_format: 'png' } },
	} };
	const path = 'edit-source.png';
	await writeFile(join(cwd, path), png);
	const refs: NoteRef[] = [{ path, kind: 'file' }];
	const input = { prompt: '把背景改为白色', sourcePath: path };
	const wrong = await execute('EditImage', { ...input, parameters: { generate_audio: true } }, undefined, refs);
	assert.equal(wrong.isError, true);
	assert.match(wrong.content, /不支持参数/u);
	assert.equal(transport.requests.length, 0);
	const revoked = await execute('EditImage', input, async () => {
		settings.modelOverrides[providerId]![model]!.mediaOptions!['image-edit']!.size = '1.5K';
		return true;
	}, refs);
	assert.equal(revoked.isError, true);
	assert.equal(transport.requests.length, 0);
	const performed = await execute('EditImage', input, async (approval) => {
		assert.equal(approval.target, ARK_IMAGE_URL.replace('/plan/', '/'));
		assert.doesNotMatch(approval.after!, /fixture-paid-secret|base64/u);
		return true;
	}, refs);
	assert.equal(performed.isError, false);
	const request = transport.requests[0];
	assert.equal(request?.headers.get('authorization'), 'Bearer fixture-paid-secret');
	assert.deepEqual(await request?.json(), { model, prompt: input.prompt, response_format: 'b64_json', size: '1.5K', output_format: 'png',
		image: `data:image/png;base64,${png.toString('base64')}` });
	assert.deepEqual(await readFile(join(cwd, performed.generatedMedia![0]!.path)), png);
});

void test('image tool verifies approval and the latest settings and sends the approved prompt, options and attached reference', async (t) => {
	const { cwd, settings, credentials, transport, execute } = await fixture(t);
	const path = '参考图.png';
	await writeFile(join(cwd, path), png);
	const refs: NoteRef[] = [{ path, kind: 'file' }];
	const input = { prompt: '用参考图的用色生成封面', referenceImage: path, size: '2048x1024', background: 'transparent', intent: '生成封面' };
	const denied = await execute('GenerateImage', input, async (approval) => {
		assert.equal(approval.kind, 'media');
		assert.equal(approval.target, ARK_IMAGE_URL);
		assert.deepEqual(JSON.parse(approval.after!), { model: imageModel, prompt: input.prompt,
			size: '2048x1024', background: 'transparent', format: 'png', referenceImage: path, directory: '聊天媒体缓存' });
		assert.doesNotMatch(JSON.stringify(approval), /base64|fixture-media-plan-key/u);
		return false;
	}, refs);
	assert.deepEqual(denied, { callId: 'fixture-call', isError: true, content: TOOL_NOT_APPROVED });
	assert.equal(transport.requests.length, 0);

	const changed = await execute('GenerateImage', input, async () => {
		settings.modelOverrides[AGENT_PLAN_PROVIDER_ID]![imageModel]!.imageDefaults!.size = '2K';
		return true;
	}, refs);
	assert.ok(changed.isError);
	assert.match(changed.content, /配置或聊天权限已变化/u);
	assert.equal(transport.requests.length, 0);

	const replaced = await execute('GenerateImage', input, async () => {
		await writeFile(join(cwd, path), Buffer.concat([png, Buffer.from([1])]));
		return true;
	}, refs);
	assert.ok(replaced.isError);
	assert.match(replaced.content, /素材已变化/u);
	assert.equal(transport.requests.length, 0);
	await writeFile(join(cwd, path), png);

	transport.beforeSend = () => { credentials.set(credentialId, 'rotated-fixture-key'); };
	const rotated = await execute('GenerateImage', input, async () => true, refs);
	assert.ok(rotated.isError);
	assert.match(rotated.content, /配置或聊天权限已变化/u);
	assert.equal(transport.requests.length, 0);
	delete transport.beforeSend;
	credentials.set(credentialId, key);

	const result = await execute('GenerateImage', input, async () => true, refs);
	assert.equal(result.isError, false);
	assert.equal(transport.requests.length, 1);
	const [request] = transport.requests;
	assert.ok(request);
	assert.equal(request.method, 'POST');
	assert.equal(request.redirect, 'error');
	assert.equal(request.headers.get('Authorization'), `Bearer ${key}`);
	assert.deepEqual(await request.json(), { model: imageModel, prompt: input.prompt, response_format: 'b64_json',
		size: '2048x1024', background: 'transparent', output_format: 'png', image: `data:image/png;base64,${png.toString('base64')}` });
	assert.match(result.content, /321 token/u);
	assert.equal(result.imageRefs, undefined);
	const [output] = result.generatedMedia ?? [];
	assert.ok(output?.kind === 'image' && isGeneratedMediaCachePath(output.path, conversationId));
	assert.deepEqual(await readFile(join(cwd, output.path)), png);
});

void test('video approval uses the selected model defaults and keeps the approved request bound to that model', async (t) => {
	const { settings, transport, execute } = await fixture(t);
	const input = { prompt: '云缓慢掠过山脊' };
	const changed = await execute('GenerateVideo', input, async (approval) => {
		assert.equal(approval.kind, 'media');
		assert.equal(approval.target, ARK_VIDEO_URL);
		assert.deepEqual(JSON.parse(approval.after!), { model: videoModel, prompt: input.prompt, resolution: '720p', duration: 7, ratio: '9:16',
			directory: '聊天媒体缓存' });
		settings.media!.models!.video = 'doubao-seedance-2.5';
		return true;
	});
	assert.ok(changed.isError);
	assert.match(changed.content, /配置或聊天权限已变化/u);
	assert.equal(transport.requests.length, 0);
});

void test('speech synthesis writes the MP3 only to the configured vault directory and returns a playable reference', async (t) => {
	const { cwd, transport, execute } = await fixture(t);
	const text = '现在播放林间提示。';
	const result = await execute('Speech', { action: 'synthesize', text, intent: '生成朗读' }, async (approval) => {
		assert.equal(approval.kind, 'media');
		assert.equal(approval.target, ARK_TTS_URL);
		assert.deepEqual(JSON.parse(approval.after!), { model: 'doubao-seed-tts-2.0', text, voice, ...resolveSpeechSynthesisOptions(), directory: '素材/配音' });
		return true;
	});
	assert.equal(result.isError, false);
	assert.equal(transport.requests.length, 1);
	const [request] = transport.requests;
	assert.ok(request);
	assert.equal(request.method, 'POST');
	assert.equal(request.headers.get('X-Api-Key'), key);
	assert.equal(request.headers.get('X-Api-Resource-Id'), 'seed-tts-2.0');
	assert.deepEqual(await request.json(), { req_params: { text, speaker: voice, audio_params: { format: 'mp3', sample_rate: 24_000 } } });
	const [output] = result.generatedMedia ?? [];
	assert.ok(output?.kind === 'audio');
	assert.match(output.path, /^素材\/配音\/speech-[\da-f-]+\.mp3$/u);
	assert.deepEqual(await readFile(join(cwd, output.path)), mp3);
	assert.deepEqual(await readdir(join(cwd, '素材', '配音')), [basename(output.path)]);
});

void test('speech tools use the saved model audio and recognition settings in approval and execution', async (t) => {
	const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
	const synthesis = { format: 'pcm', sampleRate: 16_000, speechRate: -20, loudnessRate: 35 } as const;
	const recognition = { enablePunctuation: false, normalizeText: false, showUtterances: true };
	let recognitionRequests = 0;
	const { cwd, settings, transport, execute } = await fixture(t, { output: pcm,
		async recognize(apiKey, input, _signal, options) {
			await options?.beforeSend?.();
			assert.equal(apiKey, key);
			assert.deepEqual(input, { format: 'mp3', data: mp3, ...recognition });
			recognitionRequests++;
			return { text: '甲乙', utterances: [{ text: '甲', startMs: 250, endMs: 1_100 }, { text: '乙' }] };
		},
	});
	const overrides = settings.modelOverrides[AGENT_PLAN_PROVIDER_ID]!;
	overrides['doubao-seed-tts-2.0'] = { voice, speechSynthesis: synthesis };
	overrides['doubao-seed-asr-2.0'] = { speechRecognition: recognition };
	const text = '测试音频参数。';
	const generated = await execute('Speech', { action: 'synthesize', text }, async (approval) => {
		assert.deepEqual(JSON.parse(approval.after!), { model: 'doubao-seed-tts-2.0', text, voice, ...synthesis, directory: '素材/配音' });
		return true;
	});
	assert.equal(generated.isError, false, generated.content);
	assert.deepEqual(await transport.requests[0]?.json(), { req_params: { text, speaker: voice, audio_params: {
		format: 'pcm', sample_rate: 16_000, speech_rate: -20, loudness_rate: 35,
	} } });
	const output = generated.generatedMedia?.[0];
	assert.ok(output?.kind === 'audio');
	assert.equal(output.sampleRate, 16_000);
	assert.match(output.path, /\.pcm$/u);
	assert.deepEqual(await readFile(join(cwd, output.path)), pcm);

	const audioPath = '测试音频.mp3';
	await writeFile(join(cwd, audioPath), mp3);
	const input = { action: 'recognize', audioPath };
	const refs: NoteRef[] = [{ path: audioPath, kind: 'file' }];
	const stale = await execute('Speech', input, async () => {
		overrides['doubao-seed-asr-2.0'] = { speechRecognition: { ...recognition, showUtterances: false } };
		return true;
	}, refs);
	assert.match(stale.content, /配置或聊天权限已变化/u);
	assert.equal(recognitionRequests, 0);
	overrides['doubao-seed-asr-2.0'] = { speechRecognition: recognition };
	const result = await execute('Speech', input, async (approval) => {
		assert.deepEqual(JSON.parse(approval.after!), { model: 'doubao-seed-asr-2.0', audioPath, format: 'mp3', bytes: mp3.length, ...recognition });
		return true;
	}, refs);
	assert.equal(recognitionRequests, 1);
	assert.equal(result.isError, false, result.content);
	assert.equal(result.content, '音频转写结果（资料原文）\n\n甲乙\n\n分句结果\n\n[0:00.250 – 0:01.100] 甲\n乙');
});
