import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { restoreExecution } from '../../interaction/context';
import { createConversationStore } from '../../orchestration/storage/conversationStore';
import { readGeneratedPcmAsWave, resolveGeneratedMediaPath } from '../../orchestration/storage/generatedMedia';
import { isGeneratedMediaRef, scribeDataPaths } from '../../orchestration/storage/paths';
import { retainedImagePaths } from '../../orchestration/storage/retainedImages';
import { parseConversationEntry } from '../../orchestration/storage/taskStore';
import { saveGeneratedMedia } from '../../tools/support/generatedMediaFiles';
import { clearSpillFiles } from '../../tools/support/spillCleanup';
import type { GeneratedMediaRef, ToolCall } from '../../types';
import { emptyModelResponse, fakeStream, fixture, sessionsFor } from './agentFixture';

void test('生成产物随工具结果落盘并恢复为独立的本地预览引用', async (t) => {
	const { app, cwd } = await fixture(t);
	const conversationId = 'generated';
	const photo = '.scribe-ai/cache/generated/root/scribe-ai-generated-01AbCd/image.png';
	await mkdir(dirname(join(cwd, photo)), { recursive: true });
	await writeFile(join(cwd, photo), 'fixture');
	await writeFile(join(cwd, 'spoken.mp3'), 'fixture');
	const pcmBytes = Buffer.from([0, 0, 0xff, 0x7f, 0, 0x80]);
	const pcm = await saveGeneratedMedia({ cwd, configDir: app.vault.configDir, conversationId }, 'audio',
		{ extension: 'pcm', sampleRate: 32_000 }, pcmBytes, new AbortController().signal);
	assert.match(pcm.path, /\/speech\.pcm$/u);
	assert.deepEqual(await readFile(join(cwd, pcm.path)), pcmBytes);
	const generatedMedia: GeneratedMediaRef[] = [{ kind: 'image', path: photo }, { kind: 'audio', path: 'spoken.mp3' }, pcm];
	const generatedVideoJobId = 'a'.repeat(32);
	const call: ToolCall = { id: 'create-media', name: 'FixtureMedia', input: {} };
	let attempts = 0;
	const sessions = sessionsFor(app, { stream(request) {
		if (++attempts === 1) return fakeStream(emptyModelResponse('', [call]));
		assert.equal(request.images, undefined);
		return fakeStream(emptyModelResponse('已生成。'));
	} }, [() => [{
		name: call.name, description: 'Fixture', inputSchema: {}, isReadOnly: true,
		prepare(_input, ctx) {
			assert.equal(ctx.toolCallId, call.id);
			return { run: async () => ({ content: '已保存生成结果。', generatedMedia, generatedVideoJobId }) };
		},
	}]]);
	const state = await sessions.submit({ conversationId, instruction: '生成媒体', refs: [] }).result;
	assert.equal(state.status, 'done');
	const store = createConversationStore(join(cwd, 'transcripts'));
	const [saved] = (await store.load(conversationId)).runs;
	assert.ok(saved);
	const result = state.messages.find(({ toolCallId }) => toolCallId === call.id);
	assert.deepEqual(result?.generatedMedia, generatedMedia);
	assert.equal(result?.generatedVideoJobId, generatedVideoJobId);
	const restored = saved.state.messages.find(({ toolCallId }) => toolCallId === call.id);
	assert.deepEqual(restored?.generatedMedia, generatedMedia);
	assert.equal(restored?.generatedVideoJobId, generatedVideoJobId);
	const tool = restoreExecution(saved).items.find((item) => item.kind === 'tool');
	assert.deepEqual(tool?.result?.generatedMedia, generatedMedia);
	assert.equal(tool?.result?.generatedVideoJobId, generatedVideoJobId);
	const reopenedPcm = tool?.result?.generatedMedia?.find(({ path }) => path === pcm.path);
	assert.ok(reopenedPcm);
	const wave = Buffer.from(await readGeneratedPcmAsWave(cwd, app.vault.configDir, reopenedPcm));
	assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
	assert.equal(wave.readUInt32LE(4), wave.length - 8);
	assert.equal(wave.toString('ascii', 8, 16), 'WAVEfmt ');
	assert.equal(wave.readUInt16LE(22), 1);
	assert.equal(wave.readUInt32LE(24), 32_000);
	assert.equal(wave.readUInt32LE(28), 64_000);
	assert.equal(wave.readUInt16LE(34), 16);
	assert.equal(wave.toString('ascii', 36, 40), 'data');
	assert.equal(wave.readUInt32LE(40), pcmBytes.length);
	assert.deepEqual(wave.subarray(44), pcmBytes);
	assert.deepEqual(await readFile(join(cwd, pcm.path)), pcmBytes);
});

void test('生成媒体只可访问当前库中的普通附件或生成缓存', async (t) => {
	const { app, cwd, root } = await fixture(t);
	await writeFile(join(root, 'outside.png'), 'outside');
	await writeFile(join(cwd, 'inside.png'), 'inside');
	await symlink(join(root, 'outside.png'), join(cwd, 'outside-link.png'));
	await symlink(join(cwd, 'inside.png'), join(cwd, 'inside-link.png'));
	await symlink(root, join(cwd, 'linked-parent'), 'dir');
	const image = (path: string): GeneratedMediaRef => ({ kind: 'image', path });
	const resolve = (path: string) => resolveGeneratedMediaPath(cwd, app.vault.configDir, image(path));
	assert.equal(await resolve('inside.png'), join(await realpath(cwd), 'inside.png'));
	for (const path of ['https://example.test/raw.png', '/outside.png', 'x/../inside.png', '..\\outside.png', '.scribe-ai/inside.png', 'inside.svg', 'movie.mp4']) {
		assert.equal(isGeneratedMediaRef(image(path)), false, path);
		await assert.rejects(resolve(path), /媒体文件路径无效/u);
		const messages = [{ role: 'tool', toolCallId: 'returned', content: '', generatedMedia: [image(path)] }];
		assert.throws(() => parseConversationEntry(JSON.stringify({ type: 'messages', taskId: 'task', messages }), 1), /无法读取对话记录/u);
	}
	for (const path of ['outside-link.png', 'inside-link.png', 'linked-parent/outside.png']) {
		await assert.rejects(resolve(path), /媒体文件的位置已变化/u);
	}
	await assert.rejects(resolve(app.vault.configDir + '/inside.png'), /配置目录/u);
	for (const sampleRate of [undefined, NaN, 0, 49_000, 24_000.5]) {
		const missingRate = { kind: 'audio', path: 'spoken.pcm', sampleRate } as const;
		assert.equal(isGeneratedMediaRef(missingRate), false);
		await assert.rejects(readGeneratedPcmAsWave(cwd, app.vault.configDir, missingRate), /媒体文件路径无效/u);
	}
	await writeFile(join(root, 'outside.pcm'), Buffer.alloc(2));
	await symlink(join(root, 'outside.pcm'), join(cwd, 'outside-link.pcm'));
	await assert.rejects(readGeneratedPcmAsWave(cwd, app.vault.configDir, { kind: 'audio', path: 'outside-link.pcm', sampleRate: 24_000 }),
		/媒体文件的位置已变化/u);
});

void test('生成缓存随聊天和后台视频的引用保留，删除最后一条引用后清理', async (t) => {
	const { cwd } = await fixture(t);
	const { conversations, cache } = scribeDataPaths(cwd);
	const store = createConversationStore(conversations, undefined, cache);
	const base = '.scribe-ai/cache/generated/root/scribe-ai-generated-01AbCd/';
	const photo = base + 'image.png', video = base + 'video.mp4', pcm = base + 'speech.pcm', orphan = base + 'speech.mp3', pending = base + 'partial';
	const attached = 'attachment.png';
	await mkdir(dirname(join(cwd, photo)), { recursive: true, mode: 0o700 });
	const old = new Date(0);
	for (const path of [photo, video, pcm, orphan, pending, attached]) {
		const file = join(cwd, path);
		await writeFile(file, 'fixture');
		if (path !== pending) await utimes(file, old, old);
	}
	const jobId = 'a'.repeat(32);
	await store.append('generated', [
		{ type: 'start', task: { id: 'task', status: 'pending', createdAt: 1, updatedAt: 1,
			request: { conversationId: 'generated', instruction: '生成媒体', refs: [] } }, model: { providerId: 'test', model: 'test' } },
		{ type: 'messages', taskId: 'task', messages: [{ role: 'tool', toolCallId: 'media', content: '已生成。',
			generatedMedia: [{ kind: 'image', path: photo }, { kind: 'image', path: attached }, { kind: 'audio', path: pcm, sampleRate: 24_000 }],
			generatedVideoJobId: jobId }] },
		{ type: 'finish', taskId: 'task', status: 'done', turn: 1 },
	]);
	assert.ok(store.mediaVideoHistory);
	await store.mediaVideoHistory.save('generated', { id: jobId, state: 'ready', media: { kind: 'video', path: video } });
	const branch = await store.fork('generated', 'task');
	const exists = (path: string) => existsSync(join(cwd, path));
	await clearSpillFiles(cache, () => retainedImagePaths(store));
	assert.deepEqual([photo, video, pcm, orphan, pending, attached].map(exists), [true, true, true, false, true, true]);
	await store.delete('generated');
	assert.deepEqual([photo, video, pcm, pending, attached].map(exists), [true, true, true, false, true]);
	await store.delete(branch.id);
	assert.deepEqual([photo, video, pcm, attached].map(exists), [false, false, false, true]);
});
