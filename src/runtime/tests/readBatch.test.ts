import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createToolLayer } from '../../tools';
import { readTools } from '../../tools/readTools';
import { writeTools } from '../../tools/writeTools';
import { createConversationStore } from '../../orchestration/storage/conversationStore';
import { canResumeRun } from '../../orchestration/runResume';
import { createRunContext } from '../../orchestration/runContext';
import { createTask } from '../../orchestration/taskManager';
import { createRunState } from '../runState';
import { createToolCoordinator } from '../toolCoordinator';
import type { Message, ModelRequest, ToolCall } from '../../types';
import { emptyModelResponse, fakeStream, fixture, sessionsFor } from './agentFixture';

function read(path: string, id = path): ToolCall {
	return { id, name: 'Read', input: { file_path: path } };
}

function paired(messages: Message[]) {
	return messages.filter(({ role }) => role === 'tool').map(({ toolCallId, isError, skipped }) => [toolCallId, !!isError, !!skipped]);
}

async function notes(t: TestContext, count: number, wait: (path: string) => Promise<void>, afterRead?: (path: string) => void) {
	const { app, cwd } = await fixture(t);
	const files = Array.from({ length: count }, (_, i) => `${i}.md`);
	await Promise.all(files.map((path) => writeFile(join(cwd, path), path + '\n第二行')));
	const activity = { current: 0, peak: 0, starts: [] as string[], finishes: [] as string[] };
	Object.assign(app.vault, {
		getFileByPath: (path: string) => files.includes(path) ? { path } : null,
		async readBinary({ path }: { path: string }) {
			activity.starts.push(path);
			activity.peak = Math.max(activity.peak, ++activity.current);
			try {
				await wait(path);
				return await readFile(join(cwd, path));
			} finally {
				activity.finishes.push(path);
				activity.current--;
				afterRead?.(path);
			}
		},
		process: ({ path }: { path: string }, update: (s: string) => string) => app.vault.adapter.process(path, update),
	});
	return { app, cwd, files, activity };
}

void test('independent note reads reach the next request and the saved conversation in model order; only delivered pages authorize overwrites', { timeout: 8000 }, async (t) => {
	let readSecond!: () => void, startedThree!: () => void;
	const second = new Promise<void>((resolve) => { readSecond = resolve; });
	const group = new Promise<void>((resolve) => { startedThree = resolve; });
	let count = 0;
	const { app, cwd, files, activity } = await notes(t, 5, async (path) => {
		if (++count === 3) startedThree();
		await group;
		if (path === '0.md') await second;
	}, (path) => { if (path === '1.md') readSecond(); });
	const calls = files.map((path) => read(path));
	calls[0]!.input = { file_path: files[0], limit: 1 };
	const writes = files.slice(0, 2).map((file_path) => ({ id: 'write-' + file_path, name: 'Write', input: { file_path, content: '新正文' } }));
	const batches = [calls, writes];
	const requests: ModelRequest[] = [];
	const sessions = sessionsFor(app, { stream(request) {
		requests.push(request);
		return fakeStream(emptyModelResponse('核对', batches.shift()));
	} }, [readTools, writeTools]);
	const conversationId = 'ordered-local-reads';
	const busyTransitions: boolean[] = [];
	const result = await sessions.submit({ conversationId, instruction: '核对笔记', refs: [] }, {
		approve: async () => true,
		onWork: (_id, active) => { busyTransitions.push(active); assert.ok(active || !activity.current); },
	}).result;
	assert.equal(result.status, 'done', result.error);
	assert.equal(activity.peak, 3);
	assert.ok(activity.finishes.indexOf('1.md') < activity.finishes.indexOf('0.md'));
	assert.deepEqual(paired(requests[1]!.messages), calls.map(({ id }) => [id, false, false]));
	assert.deepEqual(paired(result.messages).slice(-2), [[writes[0]!.id, true, false], [writes[1]!.id, false, false]]);
	assert.deepEqual(paired((await sessions.openConversation(conversationId))!.runs[0]!.state.messages), paired(result.messages));
	assert.equal(await readFile(join(cwd, '0.md'), 'utf8'), '0.md\n第二行');
	assert.equal(await readFile(join(cwd, '1.md'), 'utf8'), '新正文');
	assert.ok(busyTransitions.includes(true) && busyTransitions.includes(false));
});

void test('mixed, duplicate and approval-requiring read batches preserve serial execution and denied actions', async (t) => {
	const { app, cwd, files, activity } = await notes(t, 2, () => delay(5));
	const outside = join(cwd, '..', 'outside.md');
	await writeFile(outside, 'Private external text.');
	const write = { id: 'write', name: 'Write', input: { file_path: 'created.md', content: '不得写入' } };
	const batches = [[read(files[0]!), write, read(files[1]!)], [read(files[0]!), read(files[1]!), read(outside)],
		[read(files[0]!), read(files[1]!), read('./0.md', 'again')]];
	for (const [i, calls] of batches.entries()) {
		let first = true;
		const sessions = sessionsFor(app, { stream() {
			const batch = first ? calls : [];
			first = false;
			return fakeStream(emptyModelResponse('核对', batch));
		} }, [readTools, writeTools]);
		const approvals: string[] = [];
		const run = await sessions.submit({ conversationId: 'mixed-batch-' + i, instruction: '核对', refs: [] }, {
			approve: async (request) => { approvals.push(request.target); return false; },
		}, undefined, i === 1 ? { executionMode: 'ask' } : undefined).result;
		assert.equal(run.status, 'done', run.error);
		assert.equal(approvals.length, i < 2 ? 1 : 0);
		assert.deepEqual(paired(run.messages), calls.map(({ id }) => [id, id === 'write' || id === outside, false]));
	}
	assert.equal(activity.peak, 1);
	await assert.rejects(readFile(join(cwd, 'created.md')), { code: 'ENOENT' });
});

void test('an interrupted parallel read batch can reopen with each id paired once and pending reads reissued serially', async (t) => {
	let pause: (() => void) | undefined;
	const { app, files, activity } = await notes(t, 4, async () => {
		if (activity.current === 2) pause?.();
		await delay(5);
	});
	const conversationId = 'paused-parallel-reads';
	const calls = files.map((path) => read(path));
	const sessions = sessionsFor(app, { stream: () => fakeStream(emptyModelResponse('', calls)) }, [readTools]);
	const handle = sessions.submit({ conversationId, instruction: '核对', refs: [] });
	pause = () => sessions.pause(handle.taskId);
	assert.equal((await handle.result).status, 'interrupted');
	assert.ok(activity.peak >= 2);
	assert.ok(!activity.starts.includes('3.md'));
	const run = (await sessions.openConversation(conversationId))!.runs[0]!;
	assert.ok(canResumeRun(run));
	assert.deepEqual(run.state.pendingCalls.map(({ id }) => id), files);
	activity.peak = 0;
	pause = undefined;
	const retry = files.map((path) => read(path, 'retry-' + path));
	let round = 0;
	const reopened = sessionsFor(app, { stream: () => fakeStream(emptyModelResponse('核对', round++ === 0 ? retry : [])) }, [readTools]);
	const result = await reopened.resume(conversationId, handle.taskId).result;
	assert.equal(result.status, 'done', result.error);
	assert.equal(activity.peak, 1);
	assert.deepEqual(paired(result.messages), [...calls.map(({ id }) => [id, true, true]), ...retry.map(({ id }) => [id, false, false])]);
});

void test('pausing after the first ordered result preserves it even while sibling reads finish', { timeout: 5000 }, async (t) => {
	let release!: () => void;
	const slow = new Promise<void>((resolve) => { release = resolve; });
	const { app, files } = await notes(t, 3, async (path) => {
		if (path !== '0.md') await slow;
	});
	const id = 'partly-delivered-read-batch';
	const sessions = sessionsFor(app, { stream: () => fakeStream(emptyModelResponse('', files.map((path) => read(path)))) }, [readTools]);
	const run = sessions.submit({ conversationId: id, instruction: '核对', refs: [] }, {
		onEvent(event) {
			if (event.type === 'tool-end' && event.call.id === '0.md') {
				sessions.pause(run.taskId);
				release();
			}
		},
	});
	assert.equal((await run.result).status, 'interrupted');
	const saved = (await sessions.openConversation(id))!.runs[0]!;
	assert.ok(canResumeRun(saved));
	assert.deepEqual(paired(saved.state.messages), [['0.md', false, false]]);
	assert.deepEqual(saved.state.pendingCalls.map(({ id }) => id), files.slice(1));
});

void test('active collaborators keep note reads serial; a new question can preempt the second file', async (t) => {
	let question = false;
	const { app, cwd, files, activity } = await notes(t, 3, async () => { question = true; });
	const ctx = await createRunContext(createTask({ conversationId: 'read-while-busy', instruction: '核对', refs: [] }), {
		cwd, model: { providerId: 'test', model: 'stub' }, signal: new AbortController().signal, observer: {},
	}, app.vault.configDir);
	ctx.collaboration = { pending: () => ({ blocking: true, actionable: question, questions: question }), waitForProgress: async () => {} };
	const coordinator = createToolCoordinator(app, createToolLayer().executor);
	const state = { ...createRunState(ctx), pendingCalls: files.map((path) => read(path)) };
	const skipped = [];
	for await (const item of coordinator.runCalls(state, ctx, undefined, () => question ? '先答复子助手。' : undefined)) {
		if (item.skipped) skipped.push(item.call.id);
	}
	assert.equal(activity.peak, 1);
	assert.deepEqual(activity.starts, files.slice(0, 1));
	assert.deepEqual(skipped, files.slice(1));
});

void test('steering after a read starts leaves later reads unstarted and the next model request contains the correction', async (t) => {
	const { app, cwd, files, activity } = await notes(t, 4, () => delay(5));
	const sessions = sessionsFor(app, { stream(request) {
		return fakeStream(request.messages.some(({ toolCallId }) => toolCallId) ? emptyModelResponse('已按新要求处理') : emptyModelResponse('', files.map((path) => read(path))));
	} }, [readTools]);
	const conversationId = await sessions.createConversation();
	const row = { id: 'change', request: { conversationId, instruction: '停下后续读取。', refs: [] } };
	const store = createConversationStore(join(cwd, 'transcripts'));
	await store.enqueue(conversationId, row);
	let delivery: Promise<void> | undefined;
	const run = sessions.submit({ conversationId, instruction: '查看笔记', refs: [] }, {
		onEvent(event) { if (event.type === 'tool-start' && event.call.id === files[0]) delivery = sessions.steer(run.taskId, row); },
	});
	const result = await run.result;
	await delivery;
	assert.equal(result.status, 'done', result.error);
	assert.deepEqual(activity.starts, files.slice(0, 1));
	assert.deepEqual(paired(result.messages), files.map((id, i) => [id, i > 0, i > 0]));
	assert.equal(result.messages.filter(({ id }) => id === 'steer:change').length, 1);
	assert.deepEqual(await store.getQueued(conversationId), []);
});

void test('six-note session benchmark records batch and response latency for sequential and bounded reads', async (t) => {
	const { app, cwd, files } = await notes(t, 6, () => delay(30));
	const layer = createToolLayer();
	const serial = { ...layer, executor: { execute: layer.executor.execute.bind(layer.executor) } };
	const text = 'abcd'.repeat(1023) + '\n';
	await Promise.all(files.map((path) => writeFile(join(cwd, path), text)));
	for (const disk of [false, true]) {
		if (disk) Object.assign(app.vault, { getFileByPath: () => null });
		const batch: number[][] = [[], []], total: number[][] = [[], []];
		for (let sample = 0; sample <= 5; sample++) {
			for (const index of sample % 2 ? [1, 0] : [0, 1]) {
				const sessions = sessionsFor(app, { stream(request) {
					return fakeStream(request.messages.some(({ role }) => role === 'tool') ? emptyModelResponse('完成') : emptyModelResponse('', files.map((path) => read(path))));
				} }, index === 0 ? serial : layer);
				let batchStart = 0, batchEnd = 0;
				const start = performance.now();
				const result = await sessions.submit({ conversationId: `read-${disk}-${sample}-${index}`, instruction: '读取六篇笔记', refs: [] }, {
					onEvent(event) {
						if (!batchStart && event.type === 'state' && event.state.pendingCalls.length === files.length) batchStart = performance.now();
						if (event.type === 'tool-end' && event.call.id === files.at(-1)) batchEnd = performance.now();
					},
				}).result;
				const finish = performance.now();
				assert.equal(result.status, 'done', result.error);
				assert.ok(batchStart && batchEnd >= batchStart);
				assert.deepEqual(paired(result.messages), files.map((id) => [id, false, false]));
				if (sample) {
					batch[index]!.push(batchEnd - batchStart);
					total[index]!.push(finish - start);
				}
			}
		}
		const median = (values: number[]) => values.sort((a, b) => a - b)[2]!.toFixed(1);
		t.diagnostic(`${disk ? 'disk' : 'vault +30 ms/read'}: serial/parallel medians for batch (ms) ${batch.map(median).join('/')}, submit to finish (ms) ${total.map(median).join('/')}`);
	}
});
