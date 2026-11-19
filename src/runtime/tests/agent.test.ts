import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import { createModelService } from '../../communication/providers';
import { restoreExecution } from '../../interaction/context';
import { createContextBuilder } from '../../orchestration/context/contextBuilder';
import { createSessionController } from '../../orchestration/sessionController';
import { normalizeSettings } from '../../orchestration/settings/defaults';
import { createConversationStore } from '../../orchestration/storage/conversationStore';
import { createToolLayer, createToolRegistry } from '../../tools';
import { createToolExecutor } from '../../tools/executor';
import { readTools } from '../../tools/readTools';
import { writeTools } from '../../tools/writeTools';
import { RetryableModelError } from '../../types';
import type {
	CredentialStore, ModelRequest, ModelResponse, ModelService, ModelStream,
	RunObserver, RuntimeLayer, ToolCall, ToolModule, Transport,
} from '../../types';
import { createAgentLoop } from '../agentLoop';
import { bindAgent } from '../createAgent';
import { createModelCoordinator } from '../modelCoordinator';
import { explicitNoteTargets } from '../noteTargets';
import { createRunState } from '../runState';
import { createToolCoordinator } from '../toolCoordinator';

function testApp(cwd: string): App {
	return { vault: {
		adapter: {
			getBasePath: () => cwd,
			async process(path: string, update: (content: string) => string) {
				const file = join(cwd, path);
				await writeFile(file, update(await readFile(file, 'utf8')));
			},
		},
		configDir: 'fixture-vault-config',
		getFileByPath: () => null,
		create: (path: string, content: string) => writeFile(join(cwd, path), content, { flag: 'wx' }),
	} } as unknown as App;
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), 'scribe-agent-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, 'vault');
	await mkdir(cwd);
	return { root, cwd, app: testApp(cwd) };
}

function emptyModelResponse(content: string, toolCalls: ToolCall[] = [], stopReason?: ModelResponse['stopReason']): ModelResponse {
	const raw: AssistantMessage = {
		role: 'assistant', content: [{ type: 'text', text: content }], api: 'openai-completions',
		provider: 'fake', model: 'fake',
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: toolCalls.length ? 'toolUse' : 'stop', timestamp: Date.now(),
	};
	return { raw, content, toolCalls, stopReason: stopReason ?? (toolCalls.length ? 'tool-calls' : 'end') };
}

function fakeStream(response: ModelResponse, signal?: AbortSignal): ModelStream {
	return {
		async *[Symbol.asyncIterator]() {
			await Promise.resolve();
			signal?.throwIfAborted();
			yield { type: 'text_delta', delta: response.content, contentIndex: 0, partial: response.raw };
		},
		result: () => Promise.resolve(response),
		cancel() {},
	};
}

function sessionsFor(app: App, service: Pick<ModelService, 'stream' | 'contextLimits'>, modules: ToolModule[], settings = normalizeSettings(null)) {
	settings.providerId = 'test-model-service';
	settings.model = 'test-model';
	const registry = createToolRegistry(modules);
	const models = createModelCoordinator(service, createContextBuilder(registry));
	const tools = createToolCoordinator(app, createToolExecutor(registry));
	const runtime: RuntimeLayer = { newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools };
	const adapter = app.vault.adapter as import('obsidian').FileSystemAdapter;
	return createSessionController(app, settings, runtime, createConversationStore(join(adapter.getBasePath(), 'transcripts')));
}

void test('thinking arrives before the reply completes and keeps its id and duration after reopening', async (t) => {
	const { app } = await fixture(t);
	const response = emptyModelResponse('回答');
	response.raw.content.unshift({ type: 'thinking', thinking: '整理线索' });
	const { raw } = response;
	let finished = false;
	let notifyCheckpoint!: () => void;
	let releaseStream!: () => void;
	const checkpoint = new Promise<void>((resolve) => { notifyCheckpoint = resolve; });
	const waiting = new Promise<void>((resolve) => { releaseStream = resolve; });
	const sessions = sessionsFor(app, {
		contextLimits: () => ({ contextWindow: 128_000, maxTokens: 8192 }),
		stream: () => ({
			async *[Symbol.asyncIterator]() {
				yield { type: 'thinking_start', contentIndex: 0, partial: raw };
				yield { type: 'thinking_delta', contentIndex: 0, partial: raw, delta: '整理' };
				yield { type: 'thinking_delta', contentIndex: 0, partial: raw, delta: '线索' };
				yield { type: 'thinking_end', contentIndex: 0, partial: raw, content: '整理线索' };
				await waiting;
				yield { type: 'text_delta', contentIndex: 1, partial: raw, delta: '回答' };
			},
			result: async () => { finished = true; return response; },
			cancel() {},
		}),
	}, []);
	const deltas: string[] = [];
	let thoughtDuration = -1;
	const handle = sessions.submit({ conversationId: 'thinking', instruction: '梳理线索', refs: [] }, {
		onEvent(event) {
			if (event.type !== 'thinking-delta' && event.type !== 'thinking-end' && event.type !== 'text-delta') return;
			assert.equal(finished, false);
			assert.equal(event.messageId, `assistant:${handle.taskId}:1`);
			assert.equal(event.contentIndex, event.type === 'text-delta' ? 1 : 0);
			if (event.type === 'thinking-end') {
				thoughtDuration = event.durationMs;
				notifyCheckpoint();
			}
			deltas.push(event.type === 'thinking-end' ? 'end' : event.text);
		},
	});
	try {
		assert.ok(await Promise.race([checkpoint.then(() => true), handle.result.then(() => false)]));
		const inProgress = (await sessions.openConversation('thinking'))?.runs[0]?.state.messages.at(-1);
		assert.equal(inProgress?.id, `assistant:${handle.taskId}:1`);
		assert.equal(inProgress.incomplete, true);
		assert.equal(inProgress.thinkingBlocks?.[0]?.thinking, '整理线索');
	} finally {
		releaseStream();
	}
	assert.equal((await handle.result).status, 'done');
	assert.deepEqual(deltas, ['整理', '线索', 'end', '回答']);
	assert.ok(thoughtDuration >= 0);
	const savedRun = (await sessions.openConversation('thinking'))?.runs[0]?.state;
	assert.ok(savedRun?.createdAt && savedRun.finishedAt && savedRun.finishedAt >= savedRun.createdAt);
	const messages = savedRun.messages.filter(({ role }) => role === 'assistant');
	assert.equal(messages?.length, 1);
	const message = messages[0];
	assert.equal(message?.id, `assistant:${handle.taskId}:1`);
	assert.ok(message.metrics && message.metrics.firstDeltaMs !== undefined && message.metrics.decodeMs !== undefined);
	assert.equal(message.metrics.modelMs, message.metrics.firstDeltaMs + message.metrics.decodeMs);
	assert.equal(message.metrics.contextWindow, 128_000);
	assert.ok(message.metrics.endedAt <= savedRun.finishedAt);
	assert.deepEqual(message?.rawAssistant?.content[0], { type: 'thinking', thinking: '整理线索', durationMs: thoughtDuration });
});

void test('a provider that marks its thinking as redacted at the end never streams that block', async (t) => {
	const { app } = await fixture(t);
	const response = emptyModelResponse('可以显示的回答');
	response.raw.api = 'pi-messages';
	const thought = { type: 'thinking' as const, thinking: '隐藏的内容', redacted: false };
	response.raw.content.unshift(thought);
	const sessions = sessionsFor(app, {
		stream: () => ({
			async *[Symbol.asyncIterator]() {
				yield { type: 'thinking_delta', contentIndex: 0, partial: response.raw, delta: thought.thinking };
				thought.redacted = true;
				yield { type: 'thinking_end', contentIndex: 0, partial: response.raw, content: thought.thinking };
			},
			result: async () => response,
			cancel() {},
		}),
	}, []);
	const handle = sessions.submit({ conversationId: 'redacted-thinking', instruction: '梳理线索', refs: [] }, {
		onEvent(event) { assert.notEqual(event.type, 'thinking-delta'); },
	});
	assert.equal((await handle.result).status, 'done');
});

void test('stopping before the answer saves visible thinking without retaining an unfinished raw response', async (t) => {
	const { app } = await fixture(t);
	const response = emptyModelResponse('');
	response.raw.content = [{ type: 'thinking', thinking: '已经显示的思考' }];
	const sessions = sessionsFor(app, {
		stream: () => ({
			async *[Symbol.asyncIterator]() {
				yield { type: 'thinking_delta', contentIndex: 0, partial: response.raw, delta: '已经显示的思考' };
			},
			result: async () => response,
			cancel() {},
		}),
	}, []);
	const handle = sessions.submit({ conversationId: 'stopped-thinking', instruction: '梳理线索', refs: [] }, {
		onEvent(event) { if (event.type === 'thinking-delta') void sessions.cancel(handle.taskId); },
	});
	assert.equal((await handle.result).status, 'cancelled');
	const message = (await sessions.openConversation('stopped-thinking'))?.runs[0]?.state.messages.at(-1);
	assert.equal(message?.id, `assistant:${handle.taskId}:1`);
	assert.equal(message?.incomplete, true);
	assert.equal(message?.rawAssistant, undefined);
	assert.equal(message?.thinkingBlocks?.[0]?.thinking, '已经显示的思考');
});

void test('tools keep going past 12 rounds and 8 calls and return errors to the model', async (t) => {
	const { app } = await fixture(t);
	const seen: ModelRequest[] = [];
	const run: ToolModule = () => [{
		name: 'Echo', description: 'test', inputSchema: {}, isReadOnly: true,
		prepare: (input) => ({ run: () => String(input) }),
	}];
	let text = '';
	const sessions = sessionsFor(app, {
		stream(request) {
			seen.push(request);
			const turn = seen.length;
			const calls = turn <= 15 ? Array.from({ length: 10 }, (_, i): ToolCall => ({
				id: `${turn}-${i}`, name: i ? 'Echo' : 'Missing', input: i ? { turn, i } : i,
			})) : [];
			return fakeStream(emptyModelResponse(calls.length ? '' : '完成', calls), request.signal);
		},
	}, [run]);
	const result = await sessions.submit({ conversationId: 'one', instruction: 'do work', refs: [] }, {
		onEvent(event) { if (event.type === 'text-delta') text += event.text; },
	}).result;
	assert.equal(result.status, 'partial', result.error);
	assert.equal(result.turn, 16);
	assert.equal(text, '完成');
	assert.equal(result.messages.filter(({ role }) => role === 'tool').length, 150);
	assert.equal(seen.at(-1)?.messages.at(-1)?.toolCallId, '15-9');
	assert.equal(seen.at(-1)?.messages.at(-10)?.isError, true);
});

void test('a failed note write overrides the model claim and only the missing note is written on follow-up', async (t) => {
	const { app, cwd } = await fixture(t);
	const a = { id: 'write-a', name: 'Write', input: { file_path: 'A.md', content: '甲' } };
	const b = { id: 'write-b', name: 'Write', input: { file_path: 'B.md', content: '乙' } };
	const writes: string[] = [];
	let failB = true;
	Object.assign(app.vault, {
		async create(path: string, content: string) {
			if (path === 'B.md' && failB) throw new Error('模拟磁盘写入失败。');
			await writeFile(join(cwd, path), content, { flag: 'wx' });
			writes.push(path);
		},
	});
	const replies = [
		emptyModelResponse('', [a, b]), emptyModelResponse('两篇笔记全部完成。'),
		emptyModelResponse('', [b]), emptyModelResponse('第二篇已写入。'),
	];
	const sessions = sessionsFor(app, {
		stream: (request) => fakeStream(replies.shift()!, request.signal),
	}, [writeTools]);
	const conversationId = 'note-changes';
	const observer = { approve: async () => true };
	const first = await sessions.submit({ conversationId, instruction: '创建两篇笔记。', refs: [] }, observer).result;
	assert.equal(first.status, 'partial');
	assert.equal(first.messages.at(-1)?.content, 'A.md 已完成\nB.md 未完成（模拟磁盘写入失败。）');
	assert.deepEqual(writes, ['A.md']);
	await assert.rejects(readFile(join(cwd, 'B.md')), { code: 'ENOENT' });

	failB = false;
	const retry = await sessions.submit({ conversationId, instruction: '只补写第二篇。', refs: [] }, observer).result;
	assert.equal(retry.status, 'file-changes-done');
	assert.deepEqual(writes, ['A.md', 'B.md']);
	assert.equal(await readFile(join(cwd, 'A.md'), 'utf8'), '甲');
	assert.equal(await readFile(join(cwd, 'B.md'), 'utf8'), '乙');
	const saved = await sessions.openConversation(conversationId);
	assert.deepEqual(saved?.runs.map(({ state }) => state.status), ['partial', 'file-changes-done']);
});

void test('a successful retry resolves the same note operation before the task ends', async (t) => {
	const { app, cwd } = await fixture(t);
	const call = { id: 'first-write', name: 'Write', input: { file_path: 'B.md', content: '乙' } };
	let attempts = 0;
	Object.assign(app.vault, {
		async create(path: string, content: string) {
			if (++attempts === 1) throw new Error('暂时无法写入。');
			await writeFile(join(cwd, path), content, { flag: 'wx' });
		},
	});
	const replies = [
		emptyModelResponse('', [call]),
		emptyModelResponse('', [{ ...call, id: 'retry-write', input: { file_path: join(cwd, 'B.md'), content: '修正稿' } }]),
		emptyModelResponse('B.md 已写入。'),
	];
	const sessions = sessionsFor(app, { stream: (request) => fakeStream(replies.shift()!, request.signal) }, [writeTools]);
	const result = await sessions.submit({ conversationId: 'retry', instruction: '创建 B.md。', refs: [] }, {
		approve: async () => true,
	}).result;
	assert.equal(result.status, 'file-changes-done');
	assert.equal(result.messages.at(-1)?.content, 'B.md 已写入。');
	assert.equal(attempts, 2);
	assert.equal(await readFile(join(cwd, 'B.md'), 'utf8'), '修正稿');
});

void test('a failed verification prevents a completed status after writing a note', async (t) => {
	const { app, cwd } = await fixture(t);
	const replies = [
		emptyModelResponse('', [{ id: 'draft', name: 'Write', input: { file_path: '草稿.md', content: '草稿正文' } }]),
		emptyModelResponse('', [{ id: 'verify', name: 'Read', input: { file_path: '参考笔记.md' } }]),
		emptyModelResponse('全部完成。'),
	];
	const sessions = sessionsFor(app, { stream: (request) => fakeStream(replies.shift()!, request.signal) }, [readTools, writeTools]);
	const result = await sessions.submit({ conversationId: 'write-verify', instruction: '创建草稿并核对参考笔记。', refs: [] }, {
		approve: async () => true,
	}).result;
	assert.equal(await readFile(join(cwd, '草稿.md'), 'utf8'), '草稿正文');
	assert.equal(result.status, 'partial');
	assert.match(result.messages.at(-1)?.content ?? '', /Read 参考笔记\.md 未完成/);
	assert.doesNotMatch(result.messages.at(-1)?.content ?? '', /全部完成/);
});

for (const recheck of [false, true]) {
	void test(`an interrupted verification remains tracked after pausing a resumed task and is ${recheck ? 'cleared by rechecking' : 'reported as incomplete'}`, async (t) => {
		const { app, cwd } = await fixture(t);
		const file = '核对用临时草稿.md';
		const write = { id: 'draft', name: 'Write', input: { file_path: file, content: '待核对正文' } };
		const read = { id: 'verify', name: 'Read', input: { file_path: file } };
		const modules = [readTools, writeTools];
		const conversationId = 'resume-verification';
		const first = sessionsFor(app, { stream: (request) => fakeStream(emptyModelResponse('', [write, read]), request.signal) }, modules);
		const initial = first.submit({ conversationId, instruction: '创建临时草稿并读回核对。', refs: [] }, {
			approve: async () => true,
			onEvent(event) { if (event.type === 'tool-end' && event.call.id === write.id) first.pause(initial.taskId); },
		});
		assert.equal((await initial.result).status, 'interrupted');
		assert.deepEqual((await first.openConversation(conversationId))?.runs[0]?.state.pendingCalls, [read]);

		const second = sessionsFor(app, { stream: () => { throw new Error('暂停后不应发送请求'); } }, modules);
		const interrupted = second.resume(conversationId, initial.taskId, {
			onEvent(event) { if (event.type === 'turn-start') second.pause(initial.taskId); },
		});
		assert.equal((await interrupted.result).status, 'interrupted');
		assert.ok((await second.openConversation(conversationId))?.runs[0]?.state.messages.some(({ skipped, toolCallId }) => skipped && toolCallId === read.id));

		const replies = [emptyModelResponse('已完成。')];
		if (recheck) replies.unshift(emptyModelResponse('', [{ ...read, id: 'verify-again', input: { file_path: join(cwd, file), offset: 1 } }]));
		const third = sessionsFor(app, { stream: (request) => fakeStream(replies.shift()!, request.signal) }, modules);
		const completed = await third.resume(conversationId, initial.taskId).result;
		assert.equal(completed.status, recheck ? 'file-changes-done' : 'partial');
		assert.equal(await readFile(join(cwd, file), 'utf8'), write.input.content);
		if (recheck) assert.match(completed.messages.find(({ toolCallId }) => toolCallId === 'verify-again')?.content ?? '', /待核对正文/);
		else assert.match(completed.messages.at(-1)?.content ?? '', /Read 核对用临时草稿\.md 未完成（退出前尚未执行此步骤。）/);
	});
}

void test('a whole-file overwrite waits for all pages of the current file to reach the model', async (t) => {
	const { app, cwd } = await fixture(t);
	const file_path = '临时覆盖.md';
	const absolute = join(cwd, file_path);
	await writeFile(absolute, '第一页\n第二页\n第三页');
	const read = (id: string, offset: number) => ({ id, name: 'Read', input: { file_path, offset, limit: 1 } });
	const overwrite = (id: string, content: string) => ({ id, name: 'Write', input: { file_path, content } });
	const replies = [
		emptyModelResponse('', [read('middle', 2)]),
		emptyModelResponse('', [
			overwrite('partial-read', '不能覆盖'),
			{ id: 'full-edit', name: 'Edit', input: { file_path, old_string: '第一页\n第二页\n第三页', new_string: '也不能整篇替换' } },
		]),
		emptyModelResponse('', [read('last', 3), read('first', 1), overwrite('unsent-pages', '不能覆盖')]),
		emptyModelResponse('', [overwrite('full-read', '确认的新正文')]),
		emptyModelResponse('', [overwrite('stale-read', '不能覆盖刚保存的版本')]),
		emptyModelResponse('已处理。'),
	];
	const approvals: string[] = [];
	const sessions = sessionsFor(app, { stream: (request) => fakeStream(replies.shift()!, request.signal) }, [readTools, writeTools]);
	const result = await sessions.submit({ conversationId: 'overwrite-pages', instruction: '整理临时笔记。', refs: [] }, {
		async approve(preview) { approvals.push(preview.after!); return true; },
	}).result;
	const errors = new Map(result.messages.filter(({ role, toolName }) => role === 'tool' && toolName === 'Write')
		.map(({ toolCallId, isError }) => [toolCallId, isError]));
	assert.deepEqual([...errors], [['partial-read', true], ['unsent-pages', true], ['full-read', false], ['stale-read', true]]);
	assert.match(result.messages.find(({ toolCallId }) => toolCallId === 'full-edit')?.content ?? '', /读取同一版本的全部内容/);
	assert.deepEqual(approvals, ['确认的新正文']);
	assert.equal(await readFile(absolute, 'utf8'), '确认的新正文');
});

void test('a Read result shortened to fit the model window cannot authorize an overwrite', async (t) => {
	const { app, cwd } = await fixture(t);
	const file_path = '临时长笔记.md';
	const original = `${'x'.repeat(20_000)}\n最后一行`;
	await writeFile(join(cwd, file_path), original);
	const replies = [
		emptyModelResponse('', [{ id: 'read', name: 'Read', input: { file_path } }]),
		emptyModelResponse('', [{ id: 'write', name: 'Write', input: { file_path, content: '不能覆盖' } }]),
		emptyModelResponse('已处理。'),
	];
	const requests: ModelRequest[] = [];
	const sessions = sessionsFor(app, {
		contextLimits: () => ({ contextWindow: 8_000, maxTokens: 800 }),
		stream(request) {
			requests.push(request);
			return fakeStream(replies.shift()!, request.signal);
		},
	}, [readTools, writeTools]);
	let approvals = 0;
	const result = await sessions.submit({ conversationId: 'overwrite-window', instruction: '整理临时长笔记。', refs: [] }, {
		async approve() { approvals++; return true; },
	}).result;
	assert.match(result.messages.find(({ toolCallId }) => toolCallId === 'read')?.content ?? '', /最后一行/);
	assert.match(requests[1]?.messages.find(({ toolCallId }) => toolCallId === 'read')?.content ?? '', /工具结果已缩短/);
	assert.match(result.messages.find(({ toolCallId }) => toolCallId === 'write')?.content ?? '', /读取同一版本的全部内容/);
	assert.equal(approvals, 0);
	assert.equal(await readFile(join(cwd, file_path), 'utf8'), original);
});

for (const retry of [true, false]) {
	void test(retry ? 'an edit with corrected source text is complete' : 'an independent failed edit stays visible after another edit succeeds', async (t) => {
		const { app, cwd } = await fixture(t);
		const path = '草稿.md';
		await writeFile(join(cwd, path), '现用标题\n正文');
		const replies = [
			emptyModelResponse('', [{ id: 'read', name: 'Read', input: { file_path: path } }]),
			emptyModelResponse('', [{ id: 'first-edit', name: 'Edit', input: {
				file_path: path, old_string: '找不到的原文', new_string: retry ? '最终标题' : '新正文',
			} }]),
			emptyModelResponse('', [{ id: 'second-edit', name: 'Edit', input: {
				file_path: path, old_string: '现用标题', new_string: '最终标题',
			} }]),
			emptyModelResponse('修改完成。'),
		];
		const sessions = sessionsFor(app, { stream: (request) => fakeStream(replies.shift()!, request.signal) }, [readTools, writeTools]);
		const result = await sessions.submit({ conversationId: 'edit-status', instruction: '修改临时草稿。', refs: [] }, {
			approve: async () => true,
		}).result;
		assert.equal(await readFile(join(cwd, path), 'utf8'), '最终标题\n正文');
		assert.equal(result.status, retry ? 'file-changes-done' : 'partial');
		assert.deepEqual(result.messages.filter(({ role }) => role === 'tool').map(({ isError }) => isError), [false, true, false]);
		if (!retry) assert.match(result.messages.at(-1)?.content ?? '', /草稿\.md 仍有修改未完成/);
	});
}

void test('explicit write targets exclude source notes and conditional choices', () => {
	const cwd = process.cwd();
	const instruction = '请读取 `来源.md`。请创建两篇笔记：`A one.md`和[[项目/B.md]]。不要修改 C.md。写入 D.md 或 E.md。';
	assert.deepEqual([...explicitNoteTargets(instruction, cwd)], [
		[join(cwd, 'A one.md'), 'A one.md'], [join(cwd, '项目/B.md'), '项目/B.md'],
	]);
	assert.equal(explicitNoteTargets('请解释命令的示例：\n```\n创建 A.md 和 B.md\n```', cwd).size, 0);
	assert.equal(explicitNoteTargets(`创建 ${'A.md和'.repeat(500)}只选其一`, cwd).size, 0);
});

for (const repair of [true, false]) {
	void test(`a named note omitted by the model is ${repair ? 'written without rewriting other notes' : 'reported as unfinished after one check'}`, async (t) => {
		const { app, cwd } = await fixture(t);
		const a = { id: 'first', name: 'Write', input: { file_path: 'A.md', content: '甲' } };
		const b = { id: 'remaining', name: 'Write', input: { file_path: 'B.md', content: '乙' } };
		const writes: string[] = [];
		Object.assign(app.vault, {
			async create(path: string, content: string) {
				await writeFile(join(cwd, path), content, { flag: 'wx' });
				writes.push(path);
			},
		});
		const earlyEnd = emptyModelResponse('两篇都成功。');
		const replies = [emptyModelResponse('', [a]), earlyEnd];
		if (repair) replies.push(emptyModelResponse('', [{ ...a, id: 'unneeded-repeat' }, b]));
		replies.push(earlyEnd);
		const requests: ModelRequest[] = [];
		const sessions = sessionsFor(app, {
			stream(request) {
				requests.push(request);
				return fakeStream(replies.shift()!, request.signal);
			},
		}, [writeTools]);
		const approved: string[] = [];
		const result = await sessions.submit({ conversationId: 'omitted-note', instruction: '请创建 A.md 和 B.md。', refs: [] }, {
			async approve(preview) { approved.push(preview.target); return true; },
		}).result;
		assert.deepEqual(approved, repair ? ['A.md', 'B.md'] : ['A.md']);
		assert.deepEqual(writes, approved);
		assert.match(requests[2]?.messages.at(-1)?.content ?? '', /从未尝试写入：B\.md/);
		assert.ok(result.messages.some(({ content }) => content.includes('还未写入 B.md')));
		assert.equal(result.status, repair ? 'file-changes-done' : 'partial');
		assert.equal(replies.length, 0);
		if (!repair) assert.match(result.messages.at(-1)?.content ?? '', /B\.md 未完成（尚未尝试写入）/);
	});
}

void test('a model disconnection restarts only the incomplete model turn and preserves an earlier write', async (t) => {
	const { app, cwd } = await fixture(t);
	const a = { id: 'write-first', name: 'Write', input: { file_path: 'A.md', content: '甲' } };
	const b = { id: 'write-second', name: 'Write', input: { file_path: 'B.md', content: '乙' } };
	const writes: string[] = [];
	Object.assign(app.vault, {
		async create(path: string, content: string) {
			await writeFile(join(cwd, path), content, { flag: 'wx' });
			writes.push(path);
		},
	});
	const requests: ModelRequest[] = [];
	const sessions = sessionsFor(app, {
		stream(request) {
			requests.push(request);
			switch (requests.length) {
				case 1: return fakeStream(emptyModelResponse('', [a]), request.signal);
				case 2: {
					const response = emptyModelResponse('断开的半句', [b]);
					const partial = response.raw;
					return {
						...fakeStream(response, request.signal),
						async *[Symbol.asyncIterator]() {
							yield { type: 'text_delta', partial, contentIndex: 0, delta: '断开的半句' };
							yield { type: 'thinking_delta', partial, contentIndex: 1, delta: '随后出现的思考' };
							yield { type: 'thinking_end', partial, contentIndex: 1, content: '随后出现的思考' };
							yield { type: 'text_delta', partial, contentIndex: 2, delta: '断线前最后一段' };
						},
						result: () => Promise.reject(new RetryableModelError('socket hang up')),
					};
				}
				case 3: return fakeStream(emptyModelResponse('', [b]), request.signal);
				case 4: return fakeStream(emptyModelResponse('两篇都写好了。'), request.signal);
				default: throw new Error('多余的模型请求');
			}
		},
	}, [writeTools]);
	const reconnects: string[] = [];
	let disconnectedReplyId: string | undefined;
	const result = await sessions.submit({ conversationId: 'disconnected-write', instruction: '依次创建两篇笔记。', refs: [] }, {
		approve: async () => true,
		onEvent(event) {
			if (event.type === 'text-delta' && event.text === '断开的半句') disconnectedReplyId = event.messageId;
			if (event.type === 'model-retry') {
				assert.equal(event.waiting, false);
				reconnects.push(event.messageId);
				assert.deepEqual(writes, ['A.md']);
			}
		},
	}).result;
	assert.ok(disconnectedReplyId);
	assert.deepEqual(reconnects, [disconnectedReplyId]);
	assert.ok(result.messages.some(({ id }) => id === `${disconnectedReplyId}:retry:1`));
	assert.equal(result.turn, 3);
	assert.deepEqual(requests[1]?.messages, requests[2]?.messages);
	assert.equal(requests[2]?.messages.at(-1)?.toolCallId, a.id);
	assert.equal(requests[2]?.messages.at(-1)?.isError, false);
	assert.deepEqual(writes, ['A.md', 'B.md']);
	assert.equal(result.status, 'file-changes-done');
	assert.ok(result.messages.every(({ content }) => !content.includes('断开的半句')));
	const saved = await sessions.openConversation('disconnected-write');
	assert.equal(saved?.runs.length, 1);
	const savedRun = saved.runs[0]!;
	assert.equal(savedRun.state.status, 'file-changes-done');
	assert.ok(savedRun.state.messages.every(({ id }) => id !== disconnectedReplyId));
	assert.deepEqual(restoreExecution(savedRun).items.flatMap((row) => (
		(row.kind === 'text' || row.kind === 'thinking') && row.messageId === disconnectedReplyId ? [row.content] : []
	)), ['断开的半句', '随后出现的思考', '断线前最后一段']);
});

void test('stopping during reconnect cancels the pending model request', async (t) => {
	const { app } = await fixture(t);
	let requests = 0;
	const sessions = sessionsFor(app, {
		stream(request) {
			requests++;
			return {
				...fakeStream(emptyModelResponse('不完整回复'), request.signal),
				result: () => Promise.reject(new RetryableModelError('connection interrupted')),
			};
		},
	}, []);
	const run = sessions.submit({ conversationId: 'cancel-reconnect', instruction: '连接测试。', refs: [] }, {
		onEvent(event) { if (event.type === 'model-retry') void sessions.cancel(run.taskId); },
	});
	assert.equal((await run.result).status, 'cancelled');
	assert.equal(requests, 1);
	assert.equal((await sessions.openConversation('cancel-reconnect'))?.runs[0]?.partial, undefined);
});

void test('repeated tool requests stop before the fourth unchanged operation', async (t) => {
	const { app } = await fixture(t);
	let requests = 0;
	let executions = 0;
	const sessions = sessionsFor(app, {
		stream(request) {
			const id = `repeat-${++requests}`;
			assert.ok(requests <= 4);
			const input = requests % 2 ? { a: 1, b: { c: 2, d: 3 } } : { b: { d: 3, c: 2 }, a: 1 };
			return fakeStream(emptyModelResponse('', [{ id, name: 'ReadStatus', input }]), request.signal);
		},
	}, [() => [{
		name: 'ReadStatus', description: 'test', inputSchema: {}, isReadOnly: true,
		prepare: () => ({ run: () => { executions++; return 'unchanged'; } }),
	}]]);
	const result = await sessions.submit({ conversationId: 'repeat', instruction: 'check status', refs: [] }).result;
	assert.equal(result.status, 'limit');
	assert.match(result.error ?? '', /停止重复操作/);
	assert.equal(requests, 4);
	assert.equal(executions, 3);
	assert.deepEqual(result.pendingCalls, []);
	const saved = await sessions.openConversation('repeat');
	assert.deepEqual(saved?.runs[0]?.state.messages.filter(({ role }) => role === 'tool')
		.map(({ toolCallId, isError }) => [toolCallId, isError]), [
		['repeat-1', false], ['repeat-2', false], ['repeat-3', false], ['repeat-4', true],
	]);
});

void test('a new tool result allows another check after earlier identical results', async (t) => {
	const { app } = await fixture(t);
	let turn = 0;
	let changed = false;
	const inputs = ['check', 'check', 'check', 'change', 'check'];
	const results: string[] = [];
	const sessions = sessionsFor(app, {
		stream(request) {
			const input = inputs[turn++];
			return fakeStream(emptyModelResponse(input ? '' : 'done', input ? [{ id: `${turn}`, name: 'Status', input }] : []), request.signal);
		},
	}, [() => [{
		name: 'Status', description: 'test', inputSchema: {}, isReadOnly: true,
		prepare: (input) => ({
			run() {
				if (input === 'change') changed = true;
				const output = changed ? 'after' : 'before';
				results.push(output);
				return output;
			},
		}),
	}]]);
	const result = await sessions.submit({ conversationId: 'fresh-result', instruction: 'work', refs: [] }).result;
	assert.equal(result.status, 'done', result.error);
	assert.deepEqual(results, ['before', 'before', 'before', 'after', 'after']);
});

void test('continually changing tool requests cannot bypass the task round limit', async (t) => {
	const { app } = await fixture(t);
	let requests = 0;
	let executions = 0;
	const sessions = sessionsFor(app, {
		stream(request) {
			requests++;
			assert.ok(requests <= 32);
			return fakeStream(emptyModelResponse('', [{ id: `${requests}`, name: 'Echo', input: requests }]), request.signal);
		},
	}, [() => [{
		name: 'Echo', description: 'test', inputSchema: {}, isReadOnly: true,
		prepare: (input) => ({ run: () => { executions++; return String(input); } }),
	}]]);
	const result = await sessions.submit({ conversationId: 'round-limit', instruction: 'work', refs: [] }).result;
	assert.equal(result.status, 'limit');
	assert.match(result.error ?? '', /运行上限/);
	assert.equal(requests, 32);
	assert.equal(executions, 31);
	assert.equal(result.messages.at(-1)?.isError, true);
});

void test('a real provider adapter resends the assistant call with the matching file result', async (t) => {
	const { app, cwd } = await fixture(t);
	await writeFile(join(cwd, 'fact.md'), 'The vault codename is orange-butterfly-197.\n');
	const bodies: Array<{ messages: Array<{ role: string; content?: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }> }> = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		bodies.push(await req.json() as typeof bodies[number]);
		const first = bodies.length === 1;
		const chunks = first ? [
			{ delta: { role: 'assistant', tool_calls: [{
				index: 0, id: 'call_fact', type: 'function', function: { name: 'Read', arguments: '{"file_path":"fact.md"}' },
			}] }, finish_reason: null },
			{ delta: {}, finish_reason: 'tool_calls' },
		] : [
			{ delta: { role: 'assistant', content: 'orange-butterfly-197' }, finish_reason: null },
			{ delta: {}, finish_reason: 'stop' },
		];
		const data = chunks.map((choice) => `data: ${JSON.stringify({
			id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, ...choice }],
		})}\n\n`).join('');
		return new Response(`${data}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
	};
	const transport: Transport = { fetch: fakeFetch, configure() {}, logs: () => [], onStatus: () => () => {} };
	const credentials: CredentialStore = {
		read: async () => ({ type: 'api_key', key: 'test-key' }),
		list: async () => [], modify: async () => undefined, delete: async () => {},
	};
	const model = createModelService(credentials, transport, {
		customProviders: () => [{
			id: 'test-model-service', label: 'test service', baseUrl: 'http://127.0.0.1:1/v1',
			protocol: 'openai-completions', models: ['test-model'],
		}],
	});
	const sessions = sessionsFor(app, model, [readTools]);
	const result = await sessions.submit({
		conversationId: 'wire', instruction: 'What is the vault codename?', refs: [{ path: 'fact.md' }],
	}).result;
	assert.equal(result.status, 'done', result.error);
	assert.equal(bodies.length, 2);
	assert.doesNotMatch(JSON.stringify(bodies[0]), /orange-butterfly-197/);
	assert.equal(bodies[1]?.messages.find(({ role }) => role === 'assistant')?.tool_calls?.[0]?.id, 'call_fact');
	const resultMessage = bodies[1]?.messages.find(({ role }) => role === 'tool');
	assert.equal(resultMessage?.tool_call_id, 'call_fact');
	assert.match(resultMessage?.content ?? '', /orange-butterfly-197/);
	assert.equal(result.messages.at(-1)?.content, 'orange-butterfly-197');
});

void test('cancel during an approval settles before the approval responds', async (t) => {
	const { app } = await fixture(t);
	let runs = 0;
	let requests = 0;
	let approvals = 0;
	const needsApproval: ToolModule = () => [{
		name: 'Change', description: 'test', inputSchema: {}, isReadOnly: false,
		prepare: () => ({
			approval: { title: 'Modify', target: 'test' },
			run: () => { runs++; return 'changed'; },
		}),
	}];
	const sessions = sessionsFor(app, {
		stream(request) {
			requests++;
			return fakeStream(emptyModelResponse('', [1, 2].map((i) => ({ id: String(i), name: 'Change', input: {} }))), request.signal);
		},
	}, [needsApproval]);
	const observer: RunObserver = {
		approve: async () => {
			approvals++;
			await sessions.cancel(handle.taskId);
			return new Promise(() => {});
		},
	};
	const handle = sessions.submit({ conversationId: 'approval', instruction: 'change', refs: [] }, observer);
	const result = await handle.result;
	assert.equal(result.status, 'cancelled');
	assert.equal(requests, 1);
	assert.equal(approvals, 1);
	assert.equal(runs, 0);
	assert.equal(result.pendingCalls.length, 0);
	assert.deepEqual(result.messages.filter(({ role }) => role === 'tool').map(({ toolCallId, isError }) => [toolCallId, isError]),
		[['1', true], ['2', true]]);
});

void test('stopping a model stream prevents tool execution and further requests', async (t) => {
	const { app } = await fixture(t);
	let requests = 0;
	const sessions = sessionsFor(app, {
		stream(request) {
			requests++;
			return fakeStream(emptyModelResponse('working', [{ id: 'never', name: 'Read', input: {} }]), request.signal);
		},
	}, [readTools]);
	const handle = sessions.submit({ conversationId: 'stop', instruction: 'work', refs: [] }, {
		onEvent(event) {
			assert.notEqual(event.type, 'tool-start');
			if (event.type === 'text-delta') void sessions.cancel(handle.taskId);
		},
	});
	const result = await handle.result;
	assert.equal(result.status, 'cancelled');
	assert.equal(requests, 1);
});

void test('a truncated answer resumes from saved text without replaying tools', async (t) => {
	const { app } = await fixture(t);
	const requests: ModelRequest[] = [];
	let executions = 0;
	const sessions = sessionsFor(app, {
		stream(request) {
			requests.push(request);
			const replies = [
				emptyModelResponse('', [{ id: 'completed', name: 'ReadStatus', input: {} }]),
				emptyModelResponse('开头', [{ id: 'incomplete', name: 'ReadStatus', input: {} }], 'limit'),
				emptyModelResponse('和结尾。'),
			];
			return fakeStream(replies[requests.length - 1]!, request.signal);
		},
	}, [() => [{
		name: 'ReadStatus', description: 'test', inputSchema: {}, isReadOnly: true,
		prepare: () => ({ run: () => { executions++; return 'original result'; } }),
	}]]);
	const result = await sessions.submit({ conversationId: 'continuation', instruction: 'work', refs: [] }).result;
	assert.equal(result.status, 'done', result.error);
	assert.equal(requests.length, 3);
	assert.equal(executions, 1);
	const resumed = requests[2]?.messages ?? [];
	assert.equal(resumed.find(({ role }) => role === 'tool')?.toolCallId, 'completed');
	assert.equal(resumed.at(-2)?.content, '开头');
	assert.deepEqual(resumed.at(-2)?.toolCalls, []);
	assert.match(resumed.at(-1)?.content ?? '', /从截断处继续/);
	const saved = await sessions.openConversation('continuation');
	const messages = saved?.runs[0]?.state.messages ?? [];
	assert.equal(messages.filter(({ role }) => role === 'user').length, 1);
	assert.equal(messages.filter(({ role }) => role === 'assistant').map(({ content }) => content).join(''), '开头和结尾。');
	assert.ok(messages.find(({ role }) => role === 'tool')?.toolDurationMs !== undefined);
	assert.equal(messages.find(({ content }) => content === '开头')?.truncated, true);
});

void test('continuations that restart a cutoff line save each completed line once', async (t) => {
	const { app } = await fixture(t);
	const requests: ModelRequest[] = [];
	const fragments = [
		'053 | 山风过松林\n054 | 山风过',
		'054 | 山风过松林\n055 | 山风过松林\n108',
		'\n108 | 山风过松林\n109 | 山风过松林',
	];
	const sessions = sessionsFor(app, {
		stream(request) {
			requests.push(request);
			const reason = requests.length < fragments.length ? 'limit' : 'end';
			return fakeStream(emptyModelResponse(fragments[requests.length - 1]!, [], reason), request.signal);
		},
	}, []);
	const result = await sessions.submit({ conversationId: 'continuation-overlap', instruction: 'work', refs: [] }).result;
	assert.equal(result.status, 'done', result.error);
	assert.equal(requests.length, 3);
	assert.equal(requests[2]?.messages.at(-2)?.content, '松林\n055 | 山风过松林\n108');
	const saved = await sessions.openConversation('continuation-overlap');
	const answers = saved?.runs[0]?.state.messages.filter(({ role }) => role === 'assistant') ?? [];
	assert.deepEqual(answers.map(({ content }) => content).join('').split('\n'),
		['053', '054', '055', '108', '109'].map((number) => `${number} | 山风过松林`));
	assert.equal(answers.at(-1)?.rawAssistant, undefined);
});

void test('pausing just after truncation resumes without repeating the saved answer', async (t) => {
	const { app } = await fixture(t);
	const savedText = Array.from({ length: 10 }, (_, index) => `已经保存的第 ${index + 1} 行`).join('\n');
	const remainder = '\n从截断处继续的结尾。';
	const requests: ModelRequest[] = [];
	const sessions = sessionsFor(app, {
		stream(request) {
			requests.push(request);
			return requests.length === 1
				? fakeStream(emptyModelResponse(savedText, [], 'limit'), request.signal)
				: fakeStream(emptyModelResponse(savedText + remainder), request.signal);
		},
	}, []);
	const conversationId = 'paused-after-truncation';
	const run = sessions.submit({ conversationId, instruction: '请耐心讲解。', refs: [] }, {
		onEvent(event) {
			if (event.type === 'state' && event.state.messages.at(-1)?.truncated) sessions.pause(event.state.taskId);
		},
	});
	assert.equal((await run.result).status, 'interrupted');
	assert.equal(requests.length, 1);
	const continued = await sessions.resume(conversationId, run.taskId).result;
	assert.equal(continued.status, 'done');
	assert.match(requests[1]?.messages.at(-1)?.content ?? '', /从已经保存的文字末尾接着写/);
	const opened = await sessions.openConversation(conversationId);
	const stored = opened?.runs[0]?.state.messages.filter(({ role }) => role === 'assistant');
	assert.deepEqual(stored?.map(({ content }) => content), [savedText, remainder]);
});

void test('repeated output truncation stops after two continuations and preserves the partial answer', async (t) => {
	const { app } = await fixture(t);
	let requests = 0;
	const sessions = sessionsFor(app, {
		stream: ({ signal }) => fakeStream(emptyModelResponse(`partial ${++requests}`, [{ id: 'partial', name: 'Read', input: {} }], 'limit'), signal),
	}, [readTools]);
	const result = await sessions.submit({ conversationId: 'limit', instruction: 'work', refs: [] }, {
		onEvent(event) { assert.notEqual(event.type, 'tool-start'); },
	}).result;
	assert.equal(result.status, 'limit');
	assert.equal(requests, 3);
	assert.equal(result.messages.at(-1)?.content, 'partial 3');
	assert.deepEqual(result.pendingCalls, []);
});

void test('outside material is available only through the current task attachments', async (t) => {
	const { root, cwd, app } = await fixture(t);
	const folder = join(root, 'outside folder');
	const path = join(folder, 'fact.md');
	await mkdir(folder);
	await writeFile(path, '临时库外资料');
	await writeFile(join(cwd, '本地.md'), '临时库内资料');
	let turn = 0;
	const service = { stream: (request: ModelRequest) => fakeStream(++turn % 2 ? emptyModelResponse('', [
		{ id: `outside-${turn}`, name: 'Read', input: { file_path: path } },
		{ id: `inside-${turn}`, name: 'Read', input: { file_path: '本地.md' } },
	]) : emptyModelResponse('读完了。'), request.signal) };
	const sessions = sessionsFor(app, service, [readTools]);
	const request = { conversationId: 'scope', instruction: `库外目录 "${folder}" 是示例。`, refs: [] };
	const denied = await sessions.submit(request).result;
	const attached = await sessions.submit({ ...request, refs: [{ path: folder, kind: 'folder' }] }).result;
	const next = await sessions.submit({ ...request, instruction: '再核对一下。' }).result;
	for (const run of [denied, next]) {
		assert.deepEqual(run.messages.filter(({ role }) => role === 'tool').map(({ isError }) => isError), [true, false]);
	}
	assert.ok(attached.messages.some(({ role, content }) => role === 'tool' && content.includes('临时库外资料')));
	const saved = await sessions.openConversation('scope');
	assert.deepEqual(saved?.runs.map(({ request }) => request.refs), [[], [{ path: folder, kind: 'folder', addedExternal: true }], []]);
	assert.equal(createToolLayer().registry.find('Bash'), undefined);
	assert.equal(createToolLayer().registry.find('PowerShell'), undefined);
});

void test('the model tool switch blocks execution before approval and is rechecked after approval', async (t) => {
	const { app, cwd } = await fixture(t);
	const settings = normalizeSettings(null);
	const model = { capabilities: { tools: false } };
	settings.modelOverrides = { 'test-model-service': { 'test-model': model } };
	await writeFile(join(cwd, '来源.md'), '仅供工具开关测试');
	const read = { id: 'read', name: 'Read', input: { file_path: '来源.md' } };
	const call = { id: 'write', name: 'Write', input: { file_path: '开关验证.md', content: '临时笔记' } };
	let requests: ModelRequest[] = [];
	const sessions = sessionsFor(app, { stream(request) {
		requests.push(request);
		return fakeStream(requests.length === 1 ? emptyModelResponse('', [call, read]) : emptyModelResponse('模型已结束。'), request.signal);
	} }, [readTools, writeTools], settings);
	const submit = { conversationId: 'tool-switch', instruction: '创建临时笔记。', refs: [] };
	const disabled = await sessions.submit(submit, { approve: async () => { assert.fail('关闭时不应发起批准'); } }).result;
	assert.deepEqual(requests.map(({ tools }) => tools), [[], []]);
	assert.equal(disabled.status, 'failed');
	assert.deepEqual(disabled.messages.filter(({ role }) => role === 'tool').map(({ isError }) => isError), [true, true]);
	assert.doesNotMatch(JSON.stringify(requests), /仅供工具开关测试/);
	await assert.rejects(readFile(join(cwd, call.input.file_path)), { code: 'ENOENT' });

	requests = [];
	model.capabilities.tools = true;
	let approvals = 0;
	const duringApproval = await sessions.submit(submit, { approve: async () => {
		approvals++;
		model.capabilities.tools = false;
		return true;
	} }).result;
	assert.equal(approvals, 1);
	assert.match(duringApproval.messages.find(({ role }) => role === 'tool')?.content ?? '', /未授权使用工具/);
	await assert.rejects(readFile(join(cwd, call.input.file_path)), { code: 'ENOENT' });

	requests = [];
	model.capabilities.tools = true;
	const enabled = await sessions.submit(submit, { approve: async () => true }).result;
	assert.equal(enabled.status, 'file-changes-done');
	assert.equal(await readFile(join(cwd, call.input.file_path), 'utf8'), '临时笔记');
});
