import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArkVideo } from '../../communication/arkVisual';
import type { MediaAdapter } from '../../communication/mediaApi';
import type { MediaJobRoute } from '../settings/mediaConnection';
import { createMediaVideoJobs } from '../mediaVideoJobs';
import { createConversationStore } from '../storage/conversationStore';
import { scribeDataPaths } from '../storage/paths';

const conversationId = 'video-chat';
const id = '1234'.repeat(8);
const provider = { key: 'fixture-key', identity: 'a'.repeat(64) };

void test('video submission surfaces a provider error identifier without the private error payload', async () => {
	const send = (code: string) => createArkVideo(async () => Response.json({ error: { code, message: 'private details' } }, { status: 404 }),
		provider.key, 'doubao-seedance-2.0', '远山', {}, undefined, new AbortController().signal);
	await assert.rejects(send('InvalidEndpointOrModel.NotFound'), { message: '方舟视频提交失败（HTTP 404，InvalidEndpointOrModel.NotFound）。' });
	await assert.rejects(send(provider.key), { message: '方舟视频提交失败（HTTP 404）。' });
});

async function videoFixture(t: { after(action: () => Promise<void>): void }) {
	const cwd = await mkdtemp(join(tmpdir(), 'scribe-video-test-'));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const open = () => createConversationStore(scribeDataPaths(cwd).conversations);
	const store = open();
	await store.append(conversationId, [{ type: 'start', task: {
		id: 'task', status: 'pending', createdAt: 1, updatedAt: 1, request: { conversationId, instruction: '生成一段视频', refs: [] },
	}, model: { providerId: 'test', model: 'test' } }]);
	const history = store.mediaVideoHistory;
	assert.ok(history);
	return { cwd, configDir: 'fixture-config', history, open, store, connection: () => provider };
}

void test('video jobs recover from the saved provider receipt and never submit again', { timeout: 8_000 }, async (t) => {
	const fixture = await videoFixture(t);
	const { cwd, configDir, connection, open } = fixture;
	let queries = 0;
	let submits = 0;
	const events = new EventEmitter();
	const queried = once(events, 'queried');
	const first = createMediaVideoJobs({ ...fixture, fetcher: async (url, init) => {
		if (init?.method === 'POST') {
			submits++;
			assert.ok(typeof init.body === 'string');
			const body = JSON.parse(init.body) as { duration: number; ratio: string };
			assert.equal(body.duration, 5);
			assert.equal(body.ratio, '16:9');
			return Response.json({ id: 'remote-original' });
		}
		assert.match(new Request(url).url, /\/remote-original$/u);
		queries++;
		events.emit('queried');
		return Response.json({ id: 'remote-original', status: 'running' });
	} });
	t.after(() => { first.dispose(); });
	const signal = AbortSignal.timeout(5_000);
	const destination = { cwd, configDir, conversationId, directory: 'media/video' };
	const submit = () => first.submit(destination, id, provider, 'doubao-seedance-2.5', '远山', { duration: 5, ratio: '16:9' }, undefined, '5 秒', signal, () => {});
	assert.equal((await submit()).remoteId, 'remote-original');
	assert.equal((await submit()).remoteId, 'remote-original');
	await queried;
	first.dispose();
	const restored = open().mediaVideoHistory;
	assert.ok(restored);
	const mp4 = Buffer.from('000000146674797069736f6d0000020069736f6d', 'hex');
	const second = createMediaVideoJobs({ cwd, configDir, history: restored, connection, fetcher: async (url, request) => {
		assert.equal(request?.method, 'GET');
		assert.match(new Request(url).url, /\/remote-original$/u);
		queries++;
		return Response.json({ id: 'remote-original', status: 'succeeded', duration: 5, content: { video_url: 'https://fixture.test/video' } });
	}, download: async (url) => {
		assert.equal(url, 'https://fixture.test/video');
		return { body: new Response(mp4).body!, limit: 1024 };
	} });
	t.after(() => { second.dispose(); });
	const done = once(events, 'ready');
	const unsubscribe = second.subscribe(conversationId, () => {
		void second.list(conversationId).then(([job]) => { if (job?.state === 'ready') events.emit('ready'); }, (error: unknown) => events.emit('error', error));
	});
	t.after(unsubscribe);
	await second.recover(conversationId);
	await done;
	const [job] = await second.list(conversationId);
	assert.equal(submits, 1);
	assert.equal(queries, 2);
	assert.equal(job?.remoteId, undefined);
	assert.equal(job?.media?.kind, 'video');
	assert.match(job.media.path, /^media\/video\/video-.*\.mp4$/u);
	assert.deepEqual(await readFile(join(cwd, job.media.path)), mp4);
});

void test('external video editing records the original route and resumes it without a second submit', { timeout: 8_000 }, async (t) => {
	const fixture = await videoFixture(t);
	const events = new EventEmitter();
	const observed = once(events, 'poll');
	const route = { providerId: 'fixture-media', model: 'video/model', operation: 'video-edit' as const };
	const endpoint = 'https://video.example/edit';
	const remoteId = 'operation/' + 'a'.repeat(256);
	let sends = 0;
	let finish = false;
	const mp4 = Buffer.from('000000146674797069736f6d0000020069736f6d', 'hex');
	const adapter: MediaAdapter = {
		...route, models: [route.model], endpoint: () => endpoint,
		async run() { assert.fail('recovery must never restart the job'); },
		async poll(call, original) {
			assert.equal(call.endpoint, endpoint);
			assert.equal(original, remoteId);
			events.emit('poll');
			return finish ? { status: 'succeeded', result: { bytes: mp4, extension: 'mp4' } } : { status: 'running' };
		},
	};
	const externalConnection = (saved: MediaJobRoute) => {
		assert.deepEqual(saved, route);
		return { ...provider, adapter, endpoint, baseUrl: undefined };
	};
	const make = (history = fixture.history) => createMediaVideoJobs({
		...fixture, history, externalConnection, fetcher: () => assert.fail('unexpected transport'),
	});
	const first = make();
	t.after(() => { first.dispose(); });
	const destination = { cwd: fixture.cwd, configDir: fixture.configDir, conversationId };
	await first.submitExternal(destination, id, provider, route, AbortSignal.timeout(5000), () => {}, 'b'.repeat(64), async () => {
		sends++;
		return remoteId;
	});
	await observed;
	first.dispose();
	const history = fixture.open().mediaVideoHistory;
	assert.ok(history);
	const [saved] = await history.list(conversationId);
	assert.equal(saved?.remoteId, remoteId);
	assert.deepEqual(saved?.route, route);
	const second = make(history);
	t.after(() => { second.dispose(); });
	const ready = once(events, 'ready');
	t.after(second.subscribe(conversationId, () => {
		void second.list(conversationId).then(([job]) => { if (job?.state === 'ready') events.emit('ready'); });
	}));
	finish = true;
	await second.recover(conversationId);
	await ready;
	assert.equal(sends, 1);
	const [job] = await second.list(conversationId);
	assert.ok(job?.media);
	assert.deepEqual(await readFile(join(fixture.cwd, job.media.path)), mp4);
});

void test('recovery reuses a video already published before its completion record', { timeout: 8_000 }, async (t) => {
	const fixture = await videoFixture(t);
	const media = { kind: 'video' as const, path: 'already-downloaded.mp4' };
	await writeFile(join(fixture.cwd, media.path), Buffer.from('000000146674797069736f6d0000020069736f6d', 'hex'));
	await fixture.history.save(conversationId, { id, state: 'downloading', remoteId: 'remote-original', credential: provider.identity, pendingMedia: media });
	const videos = createMediaVideoJobs({ ...fixture, fetcher: () => {
		assert.fail('The completed file should be kept without a second network request');
	} });
	t.after(() => { videos.dispose(); });
	const events = new EventEmitter();
	const changed = once(events, 'changed');
	t.after(videos.subscribe(conversationId, () => { events.emit('changed'); }));
	await videos.recover(conversationId);
	await changed;
	const [job] = await videos.list(conversationId);
	assert.equal(job?.state, 'ready');
	assert.deepEqual(job.media, media);
	assert.equal(job.pendingMedia, undefined);
});

void test('loss of the video submission response persists an unknown state without a paid retry', async (t) => {
	const fixture = await videoFixture(t);
	let requests = 0;
	const videos = createMediaVideoJobs({ ...fixture, fetcher: () => {
		requests++;
		return Promise.reject(new Error('connection lost'));
	} });
	t.after(() => { videos.dispose(); });
	const submit = (callId = id) => videos.submit({ cwd: fixture.cwd, configDir: fixture.configDir, conversationId }, callId, provider,
		'doubao-seedance-2.5', '远山', {}, undefined, '5 秒', AbortSignal.timeout(1_000), () => {}, 'b'.repeat(64));
	assert.equal((await submit()).state, 'unknown');
	await videos.recover(conversationId);
	assert.equal((await submit('c'.repeat(32))).id, id);
	assert.equal(requests, 1);
});
