import assert from 'node:assert/strict';
import { structuredOutputTool, structuredOutputToolName } from '../../tools/structuredOutputTool';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import { createModelService } from '../../communication/providers';
import { chatTurnContent } from '../../interaction/chatTurnContent';
import { emptyExecution, restoreExecution, updateExecution } from '../../interaction/context';
import { createContextBuilder, taskMessage } from '../../orchestration/context/contextBuilder';
import { createSkillRegistry } from '../../orchestration/context/skills';
import { createSkillRun } from '../../orchestration/context/skillRun';
import { createRunContext } from '../../orchestration/runContext';
import { createSessionController } from '../../orchestration/sessionController';
import { normalizeSettings } from '../../orchestration/settings/defaults';
import { createConversationStore } from '../../orchestration/storage/conversationStore';
import { scribeDataPaths } from '../../orchestration/storage/paths';
import { createTask } from '../../orchestration/taskManager';
import { createToolLayer, createToolRegistry } from '../../tools';
import { chatTaskTools } from '../../tools/chatTaskTools';
import { createToolExecutor } from '../../tools/executor';
import { shellTools } from '../../tools/external/shellTool';
import { readTools } from '../../tools/readTools';
import { contactSubagentTool, manageSubagentsTool, subagentTools } from '../../tools/subagentTools';
import { writeTools } from '../../tools/writeTools';
import { ContextOverflowError, RetryableModelError } from '../../types';
import type {
	CredentialStore, Message, ModelRequest, ModelResponse, ModelService, ModelStream, QueuedMessage,
	RunObserver, RuntimeLayer, SkillRegistry, SubagentNote, TaskRequest, ToolCall, ToolLayer, ToolModule, Transport,
} from '../../types';
import { createAgentLoop } from '../agentLoop';
import { mayHaveStoppedEarly } from '../continuationText';
import { bindAgent } from '../createAgent';
import { createModelCoordinator, InitialContextBudgetError } from '../modelCoordinator';
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

function sessionsFor(app: App, service: Pick<ModelService, 'stream' | 'contextLimits' | 'modelCapabilities'>, modules: ToolModule[] | ToolLayer, settings = normalizeSettings(null), skills?: SkillRegistry) {
	settings.providerId = 'test-model-service';
	settings.model = 'test-model';
	const registry = Array.isArray(modules) ? createToolRegistry(modules) : modules.registry;
	const models = createModelCoordinator(service, createContextBuilder(registry));
	const tools = createToolCoordinator(app, Array.isArray(modules) ? createToolExecutor(registry) : modules.executor);
	const runtime: RuntimeLayer = { newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools };
	const adapter = app.vault.adapter as import('obsidian').FileSystemAdapter;
	const store = createConversationStore(join(adapter.getBasePath(), 'transcripts'));
	const modelsForSession = service.modelCapabilities && {
		modelCapabilities: service.modelCapabilities,
		send: async (request: ModelRequest) => service.stream(request).result(),
	};
	return createSessionController(app, settings, runtime, store, undefined, modelsForSession,
		Array.isArray(modules) ? undefined : modules.shellJobs, skills);
}

void test('the agent feeds a Read image result into the next model request as a tool image', async (t) => {
	const { app, cwd } = await fixture(t);
	const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
	await writeFile(join(cwd, 'sample.png'), Buffer.from(data, 'base64'));
	const call: ToolCall = { id: 'view', name: 'Read', input: { file_path: 'sample.png' } };
	const requests: ModelRequest[] = [];
	const sessions = sessionsFor(app, { stream(request) {
		requests.push(request);
		return fakeStream(requests.length === 1 ? emptyModelResponse('', [call]) : emptyModelResponse('Read the picture.'));
	} }, [readTools]);
	const result = await sessions.submit({ conversationId: 'tool-image', instruction: '读取 sample.png。', refs: [] }).result;
	assert.equal(result.status, 'done');
	const followup = requests[1]!;
	const toolIndex = followup.messages.findIndex(({ role, toolCallId }) => role === 'tool' && toolCallId === call.id);
	assert.equal(followup.images?.required, false);
	assert.deepEqual((await followup.images?.load(new AbortController().signal))?.get(toolIndex), [
		{ type: 'image', data, mimeType: 'image/png' },
	]);
});

void test('a configured agent can request a fixed JSON schema for exactly its next model response', async (t) => {
	const { app } = await fixture(t);
	const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
	const call: ToolCall = { id: 'schema', name: structuredOutputToolName, input: { schema } };
	const sent: ModelRequest[] = [];
	let enabled = true;
	const sessions = sessionsFor(app, {
		modelCapabilities: () => ({ structuredOutput: enabled }),
		stream(request) {
			sent.push(request);
			return fakeStream(sent.length === 1 || sent.length === 4
				? emptyModelResponse('', [call]) : emptyModelResponse('{"ok":true}'));
		},
	}, [structuredOutputTool]);
	const request = { conversationId: 'schema-capability', instruction: '整理成固定的 JSON 格式。', refs: [] };
	const first = await sessions.submit(request).result;
	assert.equal(first.status, 'done');
	assert.equal(sent.length, 2);
	assert.equal(sent[0]?.responseSchema, undefined);
	assert.equal('allowNativeWebSearch' in sent[0]!, false);
	assert.deepEqual(sent[0]?.tools.map(({ name }) => name), [structuredOutputToolName]);
	assert.deepEqual(sent[1]?.responseSchema, schema);
	assert.deepEqual(sent[1]?.tools, []);
	assert.equal(sent[1]?.messages.find(({ role }) => role === 'tool')?.isError, false);

	const ordinary = await sessions.submit({ ...request, instruction: '接着解释。' }).result;
	assert.equal(ordinary.status, 'done');
	assert.equal(sent[2]?.responseSchema, undefined);
	enabled = false;
	const withoutCapability = await sessions.submit({ ...request, instruction: '再核对一下。' }).result;
	assert.equal(withoutCapability.status, 'done');
	assert.deepEqual(sent[3]?.tools, []);
	assert.equal(sent[4]?.responseSchema, undefined);
	assert.equal(sent[4]?.messages.filter(({ toolCallId }) => toolCallId === call.id).at(-1)?.isError, true);
});

void test('steering reaches the next natural model request, keeps its paired tool result and commits after success', async (t) => {
	const { root, cwd, app } = await fixture(t);
	const request = { conversationId: 'steering', instruction: '请继续任务', refs: [] };
	const external = join(root, 'external.md');
	await Promise.all([writeFile(external, '库外资料'), writeFile(join(cwd, 'Vault.md'), '库内资料')]);
	const ctx = await createRunContext(createTask({ ...request, refs: [{ path: 'Vault.md', lines: [2, 3] }] }), {
		cwd, model: { providerId: 'fake', model: 'fake' }, signal: new AbortController().signal, observer: {},
	}, app.vault.configDir);
	const queued: QueuedMessage[] = [
		{ id: 'one', request: { ...request, instruction: '第一条补充', refs: [{ path: 'Vault.md', lines: [2, 2] }] } },
		{ id: 'two', request: { ...request, instruction: '第二条补充', chatQuotes: ['引用原文'] } },
		{ id: 'three', request: { ...request, instruction: '第三条补充' } },
		{ id: 'external', request: { ...request, instruction: '库外补充', refs: [{ path: external }] } },
		{ id: 'lines', request: { ...request, instruction: '整篇笔记', refs: [{ path: 'Vault.md' }] } },
	];
	const denied = ['external', 'lines'];
	if (process.platform !== 'win32') {
		await symlink(external, join(cwd, 'Linked.md'));
		queued.push({ id: 'link', request: { ...request, instruction: '链接附件', refs: [{ path: 'Linked.md' }] } });
		denied.push('link');
	}
	const sent: ModelRequest[] = [];
	const rejected: string[] = [];
	const received: string[] = [];
	const call: ToolCall = { id: 'work', name: 'Echo', input: {} };
	const context = createContextBuilder(createToolRegistry([]));
	ctx.takeSteering = () => sent.length ? queued.filter(({ id }) => !received.includes(`steer:${id}`) && !rejected.includes(id)) : [];
	ctx.rejectSteering = (ids) => rejected.push(...ids);
	ctx.record = async (event) => {
		if (event.type !== 'state') return;
		for (const { id } of event.state.messages) {
			if (id?.startsWith('steer:') && !received.includes(id)) received.push(id);
		}
	};
	const models = createModelCoordinator({
		contextLimits: () => ({ contextWindow: 8_000, maxTokens: 800 }),
		stream(input) {
			sent.push(input);
			assert.deepEqual(received, []);
			return fakeStream(sent.length === 1 ? emptyModelResponse('', [call]) : emptyModelResponse('已完成'), input.signal);
		},
	}, context);
	const loop = createAgentLoop(models, {
		async *runCalls() {
			yield { call, result: { callId: call.id, isError: false, content: '结果起点 ' + '结果'.repeat(15_000) } };
		},
	});
	const result = await loop.run(ctx, createRunState(ctx));
	assert.equal(result.turn, 2);
	assert.equal(sent.length, 2);
	assert.deepEqual(rejected, denied);
	assert.deepEqual(received, ['steer:one', 'steer:two', 'steer:three']);
	assert.deepEqual(sent[1]?.messages.map(({ role }) => role), ['user', 'assistant', 'tool', 'user', 'user', 'user']);
	assert.match(sent[1]?.messages[2]?.content ?? '', /^结果起点 [\s\S]+已缩短/);
	assert.match(sent[1]?.messages[3]?.content ?? '', /第一条补充[\s\S]+Vault\.md/);
	assert.match(sent[1]?.messages[4]?.content ?? '', /第二条补充[\s\S]+引用原文/);
	assert.equal(sent[1]?.messages[5]?.content, '第三条补充');
	assert.equal(result.messages.at(-1)?.content, '已完成');
});

for (const oversized of [false, true]) {
	void test(oversized ? 'oversized late steering keeps the previous reply without rerunning its request'
		: 'steering received during the final model request is delivered before ending the turn', async (t) => {
		const { cwd, app } = await fixture(t);
		const request = { conversationId: 'last-steering', instruction: '请回答', refs: [] };
		const ctx = await createRunContext(createTask(request), {
			cwd, model: { providerId: 'fake', model: 'fake' }, signal: new AbortController().signal, observer: {},
		}, app.vault.configDir);
		let pending: QueuedMessage | undefined;
		const rejected: string[] = [];
		ctx.takeSteering = () => pending ? [pending] : [];
		ctx.rejectSteering = (ids) => rejected.push(...ids);
		ctx.record = async (event) => {
			if (event.type === 'state' && event.state.messages.some(({ id }) => id === 'steer:late')) pending = undefined;
		};
		let requests = 0;
		const loop = createAgentLoop({
			async nextTurn(state) {
				if (++requests === 1) {
					pending = { id: 'late', request: { ...request, instruction: '再问一件事' } };
					return emptyModelResponse('第一条回复');
				}
				assert.equal(state.messages.at(-2)?.content, '第一条回复');
				assert.equal(state.messages.at(-1)?.id, 'steer:late');
				if (oversized) throw new InitialContextBudgetError('插话过长');
				return emptyModelResponse('补充回复');
			},
		}, { async *runCalls() {} });
		const result = await loop.run(ctx, createRunState(ctx));
		assert.equal(result.status, 'done');
		assert.equal(requests, 2);
		assert.equal(result.messages.at(-1)?.content, oversized ? '第一条回复' : '补充回复');
		assert.deepEqual(rejected, oversized ? ['late'] : []);
		assert.equal(result.messages.some(({ id }) => id === 'steer:late'), !oversized);
	});
}

void test('stopping while a steering model request is running leaves the message uncommitted', async (t) => {
	const { cwd, app } = await fixture(t);
	const request = { conversationId: 'stopped-steering', instruction: '请回答', refs: [] };
	const controller = new AbortController();
	const ctx = await createRunContext(createTask(request), {
		cwd, model: { providerId: 'fake', model: 'fake' }, signal: controller.signal, observer: {},
	}, app.vault.configDir);
	ctx.takeSteering = () => [{ id: 'stopped', request: { ...request, instruction: '补充问题' } }];
	ctx.record = async (event) => {
		if (event.type === 'state') assert.ok(!event.state.messages.some(({ id }) => id === 'steer:stopped'));
	};
	const loop = createAgentLoop({
		async nextTurn(state) {
			assert.equal(state.messages.at(-1)?.id, 'steer:stopped');
			controller.abort();
			return emptyModelResponse('停止前未处理完');
		},
	}, { async *runCalls() {} });
	const result = await loop.run(ctx, createRunState(ctx));
	assert.equal(result.status, 'cancelled');
	assert.ok(!result.messages.some(({ id }) => id === 'steer:stopped'));
});

void test('collaboration answers questions between tools and waits without exposing an early final reply', async (t) => {
	const { cwd, app } = await fixture(t);
	const replies: string[] = [];
	const ctx = await createRunContext(createTask({ conversationId: 'collaboration', instruction: '完成核对', refs: [] }), {
		cwd, model: { providerId: 'fake', model: 'fake' }, signal: new AbortController().signal,
		observer: { onEvent: (event) => { if (event.type === 'text-delta') replies.push(event.text); } },
	}, app.vault.configDir);
	const question: SubagentNote = { id: 'question', from: 'child', to: 'root', kind: 'question', text: '使用哪个版本？' };
	const result: SubagentNote = { id: 'result', from: 'child', to: 'root', kind: 'result', text: '新版的结果', path: 'subagent-result:result' };
	let inbox: SubagentNote[] = [];
	let blocking = true;
	let waits = 0;
	ctx.inbox = () => inbox;
	ctx.collaboration = {
		pending: () => ({ blocking, questions: inbox.includes(question), actionable: inbox.length > 0 }),
		waitForProgress: async () => { waits++; inbox = [result]; },
	};
	const first = { id: 'first', name: 'Write', input: {} };
	const second = { id: 'second', name: 'Write', input: {} };
	const answer = { id: 'answer', name: 'contact_subagent', input: { action: 'answer' } };
	const review = { id: 'review', name: 'review_subagent_result', input: {} };
	const context = createContextBuilder(createToolRegistry([]));
	const executed: string[] = [];
	const loop = createAgentLoop({
		async nextTurn(state, current) {
			switch (state.turn) {
				case 1: return emptyModelResponse('', [first, second]);
				case 2:
					assert.deepEqual(current.inbox?.(), [question]);
					return emptyModelResponse('', [answer]);
				case 3:
					current.observer.onEvent?.({ type: 'text-delta', text: '提前结尾', contentIndex: 0, messageId: 'preview' });
					return emptyModelResponse('提前结尾');
				case 4: {
					assert.deepEqual(current.inbox?.(), [result]);
					const request = await context.build(current, state.messages, 32_000);
					assert.equal(request.messages.some(({ subagentActivity }) => subagentActivity !== undefined), false);
					assert.doesNotMatch(request.system ?? '', /subagent-result:result/u);
					assert.ok(request.messages.some(({ role, content }) => role === 'user' && content.includes('subagent-result:result')));
					return emptyModelResponse('', [review]);
				}
				default: return emptyModelResponse('核对完成');
			}
		},
	}, {
		async *runCalls(state, _ctx, _approve, skip) {
			for (const call of state.pendingCalls) {
				const reason = await skip?.(call);
				if (!reason) {
					executed.push(call.id);
					if (call.id === first.id) inbox = [question];
					if (call.id === answer.id) inbox = [];
					if (call.id === review.id) { inbox = []; blocking = false; }
				}
				yield { call, result: { callId: call.id, isError: Boolean(reason), content: reason ?? '完成' }, skipped: Boolean(reason) };
			}
		},
	});
	const completed = await loop.run(ctx, createRunState(ctx));
	assert.equal(completed.status, 'done');
	assert.deepEqual(executed, [first.id, answer.id, review.id]);
	assert.equal(completed.messages.find(({ toolCallId }) => toolCallId === second.id)?.skipped, true);
	assert.equal(waits, 1);
	assert.deepEqual(replies, []);
	assert.deepEqual(completed.messages.flatMap(({ subagentActivity }) => subagentActivity ? [subagentActivity.id] : []),
		[question.id, result.id]);
	assert.equal(completed.messages.some(({ content }) => content === '提前结尾'), false);
	assert.equal(completed.messages.at(-1)?.content, '核对完成');
});

void test('oversized steering retries the original turn only when no provider request has been sent', async (t) => {
	const { cwd, app } = await fixture(t);
	const request = { conversationId: 'steering-budget', instruction: '请回答', refs: [] };
	const context = createContextBuilder(createToolRegistry([]));
	for (const dispatched of [false, true]) {
		const ctx = await createRunContext(createTask(request), {
			cwd, model: { providerId: 'fake', model: 'fake' }, signal: new AbortController().signal, observer: {},
		}, app.vault.configDir);
		const instruction = 'X'.repeat(dispatched ? 3_000 : 30_000);
		const sent: ModelRequest[] = [];
		const rejected: string[] = [];
		ctx.takeSteering = () => rejected.length ? [] : [{ id: 'oversized', request: { ...request, instruction } }];
		ctx.rejectSteering = (ids) => rejected.push(...ids);
		const models = createModelCoordinator({
			contextLimits: () => ({ contextWindow: 4_000, maxTokens: 500 }),
			stream(input) {
				sent.push(input);
				if (!dispatched) return fakeStream(emptyModelResponse('继续完成原任务'), input.signal);
				return {
					async *[Symbol.asyncIterator]() {},
					result: () => Promise.reject(new ContextOverflowError('Input too long')),
					cancel() {},
				};
			},
		}, context);
		const loop = createAgentLoop(models, { async *runCalls() {} });
		const result = await loop.run(ctx, createRunState(ctx));
		assert.equal(result.turn, 1);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.messages.some(({ id }) => id === 'steer:oversized'), dispatched);
		assert.ok(!result.messages.some(({ id }) => id === 'steer:oversized'));
		assert.deepEqual(rejected, dispatched ? [] : ['oversized']);
		assert.equal(result.status, dispatched ? 'failed' : 'done');
	}
});

void test('thinking arrives before the reply completes and keeps its id and duration after reopening', async (t) => {
	const { app } = await fixture(t);
	const response = emptyModelResponse('回答');
	const thinking = '## 正在整理线索\n具体分析';
	response.raw.content.unshift({ type: 'thinking', thinking });
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
				yield { type: 'thinking_delta', contentIndex: 0, partial: raw, delta: '## 正在整理线索\n' };
				yield { type: 'thinking_delta', contentIndex: 0, partial: raw, delta: '具体分析' };
				yield { type: 'thinking_end', contentIndex: 0, partial: raw, content: thinking };
				await waiting;
				yield { type: 'text_delta', contentIndex: 1, partial: raw, delta: '回答' };
			},
			result: async () => { finished = true; return response; },
			cancel() {},
		}),
	}, []);
	const deltas: string[] = [];
	const intents: string[] = [];
	let thoughtDuration = -1;
	const handle = sessions.submit({ conversationId: 'thinking', instruction: '梳理线索', refs: [] }, {
		onEvent(event) {
			if (event.type === 'model-intent') intents.push(event.intent);
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
		assert.deepEqual(intents, ['正在整理线索']);
		const inProgress = (await sessions.openConversation('thinking'))?.runs[0]?.state.messages.at(-1);
		assert.equal(inProgress?.id, `assistant:${handle.taskId}:1`);
		assert.equal(inProgress.incomplete, true);
		assert.equal(inProgress.thinkingBlocks?.[0]?.thinking, thinking);
	} finally {
		releaseStream();
	}
	assert.equal((await handle.result).status, 'done');
	assert.deepEqual(deltas, ['## 正在整理线索\n', '具体分析', 'end', '回答']);
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
	assert.deepEqual(message?.rawAssistant?.content[0], { type: 'thinking', thinking, durationMs: thoughtDuration });
});

void test('a direct reply streams its Chinese intent separately and saves only the reply text', async (t) => {
	const { app } = await fixture(t);
	const chunks = ['<scribe-', 'intent>正在比较两种写法。</scribe-intent>\r', '\n', '第一种更简洁。'];
	const response = emptyModelResponse(chunks.join(''));
	const events: string[] = [];
	let execution = emptyExecution;
	const sessions = sessionsFor(app, {
		stream: (request) => ({
			async *[Symbol.asyncIterator]() {
				assert.match(request.system ?? '', /<scribe-intent>/u);
				for (const delta of chunks) yield { type: 'text_delta', contentIndex: 0, partial: response.raw, delta };
			},
			result: async () => response,
			cancel() {},
		}),
	}, []);
	const result = await sessions.submit({ conversationId: 'reply-intent', instruction: '比较两种写法', refs: [] }, {
		onEvent(event) {
			execution = updateExecution(execution, event);
			if (event.type === 'model-intent') events.push(event.intent);
			if (event.type === 'text-delta') {
				assert.equal(execution.modelIntent, '正在比较两种写法');
				events.push(event.text);
			}
		},
	}).result;
	assert.equal(result.status, 'done', result.error);
	assert.deepEqual(events, ['正在比较两种写法', '第一种更简洁。']);
	const saved = (await sessions.openConversation('reply-intent'))?.runs[0];
	assert.ok(saved);
	assert.equal(saved.state.messages.at(-1)?.content, '第一种更简洁。');
	assert.deepEqual(restoreExecution(saved).items.flatMap((item) => item.kind === 'text' ? [item.content] : []), ['第一种更简洁。']);
});

void test('a provider that marks its thinking as redacted at the end never streams that block', async (t) => {
	const { app } = await fixture(t);
	const response = emptyModelResponse('可以显示的回答');
	response.raw.api = 'pi-messages';
	const thought = { type: 'thinking' as const, thinking: '## 隐藏的内容\n', redacted: false };
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
		onEvent(event) {
			assert.notEqual(event.type, 'thinking-delta');
			assert.notEqual(event.type, 'model-intent');
		},
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
				id: `${turn}-${i}`, name: i ? 'Echo' : 'Missing', input: i ? { turn, index: i } : i,
			})) : [];
			return fakeStream(emptyModelResponse(calls.length ? '' : '完成', calls), request.signal);
		},
	}, [run]);
	const result = await sessions.submit({ conversationId: 'one', instruction: 'do work', refs: [] }, {
		onEvent(event) { if (event.type === 'text-delta') text += event.text; },
	}).result;
	assert.equal(result.status, 'done', result.error);
	assert.equal(result.turn, 16);
	assert.equal(text, '完成');
	assert.equal(result.messages.at(-1)?.content, text);
	assert.equal(result.messages.filter(({ role }) => role === 'tool').length, 150);
	assert.equal(seen.at(-1)?.messages.at(-1)?.toolCallId, '15-9');
	assert.equal(seen.at(-1)?.messages.at(-10)?.isError, true);
});

const chatTools = createToolLayer().registry;
void test('a failed shell attempt keeps its error without replacing the final reply after a retry', { skip: !chatTools.find('Bash') }, async (t) => {
	const { app, cwd } = await fixture(t);
	const command = "printf '%s' '核对完成'";
	const replies = [
		emptyModelResponse('', [{ id: 'bad-cwd', name: 'Bash', input: { command, cwd: false } }]),
		emptyModelResponse('', [{ id: 'retry', name: 'Bash', input: { command, cwd: '' } }]),
		emptyModelResponse('命令已运行，返回「核对完成」。'),
	];
	const sessions = sessionsFor(app, { stream: (request) => fakeStream(replies.shift()!, request.signal) }, [() => chatTools.all()]);
	const conversationId = 'shell-retry';
	let approvals = 0;
	const result = await sessions.submit({ conversationId, instruction: '运行测试命令并报告结果。', refs: [] }, {
		async approve(preview) {
			assert.equal(preview.target, await realpath(cwd));
			approvals++;
			return true;
		},
	}).result;
	assert.equal(approvals, 1);
	assert.equal(result.status, 'done', result.error);
	const tools = result.messages.filter(({ role }) => role === 'tool');
	assert.deepEqual(tools.map(({ isError }) => isError), [true, false]);
	assert.match(tools[0]?.content ?? '', /参数 cwd/u);
	assert.match(tools[1]?.content ?? '', /核对完成/u);
	const saved = (await sessions.openConversation(conversationId))?.runs[0];
	assert.ok(saved);
	const restored = chatTurnContent(restoreExecution(saved));
	assert.equal(restored.answer, '命令已运行，返回「核对完成」。');
	assert.ok(!restored.rows.some((row) => row.kind === 'notice'));
});

void test('a failed note write reaches the model and a later request can finish the missing note', async (t) => {
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
	const finalText = 'A.md 已写入。B.md 写入失败。';
	const replies = [
		emptyModelResponse('', [a, b]), emptyModelResponse(finalText),
		emptyModelResponse('', [b]), emptyModelResponse('第二篇已写入。'),
	];
	const requests: ModelRequest[] = [];
	const sessions = sessionsFor(app, {
		stream(request) {
			requests.push(request);
			return fakeStream(replies.shift()!, request.signal);
		},
	}, [writeTools]);
	const conversationId = 'note-changes';
	const observer = { approve: async () => true };
	const first = await sessions.submit({ conversationId, instruction: '创建两篇笔记。', refs: [] }, observer).result;
	assert.equal(first.status, 'done');
	assert.equal(first.messages.at(-1)?.content, finalText);
	const error = requests[1]?.messages.find(({ toolCallId }) => toolCallId === b.id);
	assert.equal(error?.isError, true);
	assert.match(error?.content ?? '', /模拟磁盘写入失败/u);
	assert.deepEqual(writes, ['A.md']);
	await assert.rejects(readFile(join(cwd, 'B.md')), { code: 'ENOENT' });

	failB = false;
	const retry = await sessions.submit({ conversationId, instruction: '只补写第二篇。', refs: [] }, observer).result;
	assert.equal(retry.status, 'done');
	assert.deepEqual(writes, ['A.md', 'B.md']);
	assert.equal(await readFile(join(cwd, 'A.md'), 'utf8'), '甲');
	assert.equal(await readFile(join(cwd, 'B.md'), 'utf8'), '乙');
	const saved = await sessions.openConversation(conversationId);
	assert.ok(saved);
	assert.deepEqual(saved.runs.map(({ state }) => state.status), ['done', 'done']);
	const [original] = saved.runs;
	assert.ok(original);
	assert.equal(chatTurnContent(restoreExecution(original)).answer, finalText);
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
	assert.equal(result.status, 'done');
	assert.equal(result.messages.at(-1)?.content, 'B.md 已写入。');
	assert.equal(attempts, 2);
	assert.equal(await readFile(join(cwd, 'B.md'), 'utf8'), '修正稿');
});

void test('a failed verification can end with only the tool record when the model supplies no final text', async (t) => {
	const { app, cwd } = await fixture(t);
	const replies = [
		emptyModelResponse('', [{ id: 'draft', name: 'Write', input: { file_path: '草稿.md', content: '草稿正文' } }]),
		emptyModelResponse('', [{ id: 'verify', name: 'Read', input: { file_path: '参考笔记.md' } }]),
		emptyModelResponse(''),
	];
	const sessions = sessionsFor(app, { stream: (request) => fakeStream(replies.shift()!, request.signal) }, [readTools, writeTools]);
	const result = await sessions.submit({ conversationId: 'write-verify', instruction: '创建草稿并核对参考笔记。', refs: [] }, {
		approve: async () => true,
	}).result;
	assert.equal(await readFile(join(cwd, '草稿.md'), 'utf8'), '草稿正文');
	assert.equal(result.status, 'done');
	assert.equal(result.messages.at(-1)?.content, '');
	assert.equal(result.messages.find(({ toolCallId }) => toolCallId === 'verify')?.isError, true);
	const saved = (await sessions.openConversation('write-verify'))?.runs[0];
	assert.ok(saved);
	const { answer, copyText, rows } = chatTurnContent(restoreExecution(saved));
	assert.equal(answer, '');
	assert.equal(copyText, '');
	assert.deepEqual(rows.map(({ kind }) => kind), ['tool', 'tool']);
});

void test('resuming a saved task keeps the collaboration operations scoped and skips pending legacy calls', async (t) => {
	const { app } = await fixture(t);
	const conversationId = 'resume-subagents';
	const list = { id: 'list', name: manageSubagentsTool, input: { action: 'list' } };
	const legacy = { id: 'old-follow-up', name: 'followup_task', input: { target: 'worker', message: '继续' } };
	const first = sessionsFor(app, { stream: () => fakeStream(emptyModelResponse('', [list, legacy])) }, [subagentTools]);
	t.after(() => first.dispose());
	const submitted = first.submit({ conversationId, instruction: '核对现有分工。', refs: [] }, {
		onEvent(event) { if (event.type === 'tool-end' && event.call.id === list.id) first.pause(submitted.taskId); },
	});
	assert.equal((await submitted.result).status, 'interrupted');
	assert.deepEqual((await first.openConversation(conversationId))?.runs[0]?.state.pendingCalls, [legacy]);

	const followUp = { id: 'follow-up', name: contactSubagentTool, input: { action: 'follow_up', target: 'worker', message: '继续' } };
	const reopen = { id: 'reopen', name: manageSubagentsTool, input: { action: 'reopen', target: 'worker' } };
	let resumed = false;
	const second = sessionsFor(app, { stream(request) {
		if (resumed) return fakeStream(emptyModelResponse('已核对。'));
		resumed = true;
		const options = (name: string) => (request.tools.find((tool) => tool.name === name)?.inputSchema.properties as
			{ action?: { enum: string[] } } | undefined)?.action?.enum;
		assert.deepEqual(options(contactSubagentTool), ['send', 'answer']);
		assert.deepEqual(options(manageSubagentsTool), ['list', 'interrupt', 'close']);
		assert.ok(!request.tools.some(({ name }) => name === 'spawn_agent' || name === legacy.name));
		return fakeStream(emptyModelResponse('', [followUp, reopen, { ...list, id: 'list-again' }]));
	} }, [subagentTools]);
	t.after(() => second.dispose());
	const finished = await second.resume(conversationId, submitted.taskId).result;
	assert.equal(finished.status, 'done', finished.error);
	assert.equal(finished.messages.find(({ toolCallId }) => toolCallId === legacy.id)?.skipped, true);
	for (const { id } of [followUp, reopen]) {
		assert.match(finished.messages.find(({ toolCallId }) => toolCallId === id)?.content ?? '', /无法使用/u);
	}
	assert.equal(finished.messages.find(({ toolCallId }) => toolCallId === 'list-again')?.content, '[]');
});

for (const recheck of [false, true]) {
	void test(`an interrupted verification is delivered back to the model ${recheck ? 'before checking again' : 'even when it ends without rechecking'}`, async (t) => {
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

		const finalText = recheck ? '已读回草稿并核对。' : '草稿已写入，尚未读回核对。';
		const replies = [emptyModelResponse(finalText)];
		if (recheck) replies.unshift(emptyModelResponse('', [{ ...read, id: 'verify-again', input: { file_path: join(cwd, file), offset: 1 } }]));
		const third = sessionsFor(app, { stream(request) {
			assert.ok(request.messages.some(({ toolCallId, skipped, isError }) => toolCallId === read.id && skipped && isError));
			return fakeStream(replies.shift()!, request.signal);
		} }, modules);
		const completed = await third.resume(conversationId, initial.taskId).result;
		assert.equal(completed.status, 'done');
		assert.equal(completed.messages.at(-1)?.content, finalText);
		assert.equal(await readFile(join(cwd, file), 'utf8'), write.input.content);
		if (recheck) assert.match(completed.messages.find(({ toolCallId }) => toolCallId === 'verify-again')?.content ?? '', /待核对正文/);
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
		const finalText = retry ? '标题修改完成。' : '标题已修改，正文未改动。';
		const replies = [
			emptyModelResponse('', [{ id: 'read', name: 'Read', input: { file_path: path } }]),
			emptyModelResponse('', [{ id: 'first-edit', name: 'Edit', input: {
				file_path: path, old_string: '找不到的原文', new_string: retry ? '最终标题' : '新正文',
			} }]),
			emptyModelResponse('', [{ id: 'second-edit', name: 'Edit', input: {
				file_path: path, old_string: '现用标题', new_string: '最终标题',
			} }]),
			emptyModelResponse(finalText),
		];
		const sessions = sessionsFor(app, { stream: (request) => fakeStream(replies.shift()!, request.signal) }, [readTools, writeTools]);
		const result = await sessions.submit({ conversationId: 'edit-status', instruction: '修改临时草稿。', refs: [] }, {
			approve: async () => true,
		}).result;
		assert.equal(await readFile(join(cwd, path), 'utf8'), '最终标题\n正文');
		assert.equal(result.status, 'done');
		assert.equal(result.messages.at(-1)?.content, finalText);
		assert.deepEqual(result.messages.filter(({ role }) => role === 'tool').map(({ isError }) => isError), [false, true, false]);
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

void test('a normal end preserves the model reply and does not start another request to write an omitted note', async (t) => {
	const { app, cwd } = await fixture(t);
	const a = { id: 'first', name: 'Write', input: { file_path: 'A.md', content: '甲' } };
	const finalText = 'A.md 已写入，B.md 尚未写入。';
	const replies = [emptyModelResponse('', [a]), emptyModelResponse(finalText)];
	let requests = 0;
	const sessions = sessionsFor(app, { stream(request) {
		requests++;
		return fakeStream(replies.shift()!, request.signal);
	} }, [writeTools]);
	const approved: string[] = [];
	const result = await sessions.submit({ conversationId: 'omitted-note', instruction: '请创建 A.md 和 B.md。', refs: [] }, {
		async approve(preview) { approved.push(preview.target); return true; },
	}).result;
	assert.equal(result.status, 'done');
	assert.equal(result.messages.at(-1)?.content, finalText);
	assert.equal(requests, 2);
	assert.deepEqual(approved, ['A.md']);
	assert.equal(await readFile(join(cwd, 'A.md'), 'utf8'), '甲');
	await assert.rejects(readFile(join(cwd, 'B.md')), { code: 'ENOENT' });
});

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
	assert.equal(result.status, 'done');
	assert.ok(result.messages.every(({ content }) => !content.includes('断开的半句')));
	const saved = await sessions.openConversation('disconnected-write');
	assert.equal(saved?.runs.length, 1);
	const savedRun = saved.runs[0]!;
	assert.equal(savedRun.state.status, 'done');
	assert.deepEqual(savedRun.state.auxiliaryUsage?.filter(({ kind }) => kind === 'main-attempt'), [{ kind: 'main-attempt' }]);
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
			const i = `Reading status ${requests}`;
			const input = Object.freeze(requests % 2 ? { a: 1, b: { c: 2, d: 3 }, i } : { b: { d: 3, c: 2 }, a: 1, i });
			const response = emptyModelResponse('', [{ id, name: 'ReadStatus', input }]);
			response.raw.content.push({ type: 'toolCall', id, name: 'ReadStatus', arguments: input });
			return fakeStream(response, request.signal);
		},
	}, [() => [{
		name: 'ReadStatus', description: 'test', inputSchema: {}, isReadOnly: true,
		prepare: (input) => {
			assert.deepEqual(input, { a: 1, b: { c: 2, d: 3 } });
			return { run: () => { executions++; return 'unchanged'; } };
		},
	}]]);
	const result = await sessions.submit({ conversationId: 'repeat', instruction: 'check status', refs: [] }).result;
	assert.equal(result.status, 'limit');
	assert.match(result.error ?? '', /停止重复操作/);
	assert.equal(requests, 4);
	assert.equal(executions, 3);
	assert.deepEqual(result.pendingCalls, []);
	const saved = await sessions.openConversation('repeat');
	const reply = saved?.runs[0]?.state.messages.find(({ role }) => role === 'assistant');
	assert.deepEqual(reply?.toolCalls?.[0]?.input, { a: 1, b: { c: 2, d: 3 }, i: 'Reading status 1' });
	assert.deepEqual(reply?.rawAssistant?.content.find((block) => block.type === 'toolCall')?.arguments, reply?.toolCalls?.[0]?.input);
	assert.deepEqual(saved?.runs[0]?.state.messages.filter(({ role }) => role === 'tool')
		.map(({ toolCallId, isError }) => [toolCallId, isError]), [
		['repeat-1', false], ['repeat-2', false], ['repeat-3', false], ['repeat-4', true],
	]);
});

void test('a resumed agent can reclaim a released checklist item after three identical prior receipts', async (t) => {
	const { app } = await fixture(t);
	const claim = (id: string) => ({ id, name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } });
	const calls = [
		{ id: 'create', name: 'TaskCreate', input: { subject: '核对引用', description: '检查三处出处' } },
		claim('first'), claim('second'), claim('third'), claim('reclaim'),
		{ id: 'finish', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
	];
	const open = () => sessionsFor(app, { stream(request) {
		const next = calls.shift();
		return fakeStream(next ? emptyModelResponse('', [next]) : emptyModelResponse('核对完成。'), request.signal);
	} }, [chatTaskTools]);
	const conversationId = 'checklist-reclaim';
	const sessions = open();
	const run = sessions.submit({ conversationId, instruction: '核对引用', refs: [] }, { onEvent(event) {
		if (event.type === 'state' && event.state.messages.at(-1)?.toolCallId === 'third') sessions.pause(event.state.taskId);
	} });
	assert.equal((await run.result).status, 'interrupted');
	const resumed = await open().resume(conversationId, run.taskId).result;
	assert.equal(resumed.status, 'done');
	const receipt = resumed.messages.find(({ toolCallId }) => toolCallId === 'finish');
	assert.equal(receipt?.isError, false);
	assert.match(receipt.content, /"status":"completed"/u);
	assert.ok(resumed.messages.every((message) => !message.noteChange));
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

void test('changing tool results continue beyond old turn and call caps until a final reply', async (t) => {
	const { app } = await fixture(t);
	let requests = 0;
	let executions = 0;
	const sessions = sessionsFor(app, {
		stream(request) {
			requests++;
			const calls = requests <= 34 ? Array.from({ length: 8 }, (_, index) => ({
				id: `${requests}-${index}`, name: 'Echo', input: requests * 8 + index,
			})) : [];
			return fakeStream(emptyModelResponse(calls.length ? '' : 'done', calls), request.signal);
		},
	}, [() => [{
		name: 'Echo', description: 'test', inputSchema: {}, isReadOnly: true,
		prepare: (input) => ({ run: () => { executions++; return String(input); } }),
	}]]);
	const result = await sessions.submit({ conversationId: 'round-limit', instruction: 'work', refs: [] }).result;
	assert.equal(result.status, 'done', result.error);
	assert.equal(requests, 35);
	assert.equal(executions, 272);
	assert.equal(result.messages.at(-1)?.content, 'done');
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

void test('shell output updates one live row and stopping preserves its captured ends in reopened chat', {
	skip: !shellTools().find(({ name }) => name === 'Bash')?.isAvailable?.(),
}, async (t) => {
	const { app, cwd } = await fixture(t);
	const command = [
		"printf '标准输出首行\\n'; printf '%s\\n' {1..6000}; printf '标准输出第一阶段\\n'",
		"{ printf '错误输出首行\\n'; printf '%s\\n' {1..6000}; printf '错误输出第一阶段\\n'; } >&2",
		'while [[ ! -f next-step.txt ]]; do sleep 0.05; done',
		"printf '%0800d\\n标准输出末行\\n' 0; printf '%0800d\\n停止前的诊断\\n' 0 >&2",
		'sleep 30',
	].join('; ');
	const call = { id: 'shell', name: 'Bash', input: { command } };
	const queued = { id: 'queued', name: 'Bash', input: { command: 'printf unexpected > queued.txt' } };
	const sessions = sessionsFor(app, {
		stream: ({ signal }) => fakeStream(emptyModelResponse('', [call, queued]), signal),
	}, [shellTools]);
	const conversationId = 'shell-stop';
	let live = emptyExecution;
	const run = sessions.submit({ conversationId, instruction: '运行命令', refs: [] }, {
		approve: async () => true,
		onEvent(event) { live = updateExecution(live, event); },
	});
	async function waitForOutput(stdout: string, stderr: string) {
		const deadline = Date.now() + 5_000;
		while (true) {
			const row = live.items.find((item) => item.kind === 'tool' && item.call.id === call.id);
			if (row?.kind === 'tool' && row.shellOutput?.stdout.includes(stdout) && row.shellOutput.stderr.includes(stderr)) {
				assert.equal(row.result, undefined);
				for (const stream of [row.shellOutput.stdout, row.shellOutput.stderr]) {
					assert.ok(stream.trimEnd().split('\n').length <= 3);
					assert.ok(Buffer.byteLength(stream) <= 512);
				}
				return row.id;
			}
			assert.ok(Date.now() < deadline, 'shell preview did not show both output streams');
			await delay(25);
		}
	}
	try {
		const rowId = await waitForOutput('标准输出第一阶段', '错误输出第一阶段');
		await writeFile(join(cwd, 'next-step.txt'), '');
		assert.equal(await waitForOutput('标准输出末行', '停止前的诊断'), rowId);
		assert.equal(live.items.filter((item) => item.kind === 'tool' && item.call.id === call.id).length, 1);
	} finally {
		await sessions.cancel(run.taskId);
	}
	const result = await run.result;
	assert.equal(result.status, 'cancelled');
	assert.equal(result.messages.find(({ toolCallId }) => toolCallId === queued.id)?.skipped, true);
	const saved = (await sessions.openConversation(conversationId))?.runs[0];
	assert.ok(saved);
	for (const execution of [live, restoreExecution(saved)]) {
		const row = execution.items.find((item) => item.kind === 'tool' && item.call.id === call.id);
		assert.ok(row?.kind === 'tool');
		assert.equal(row.shellOutput, undefined);
		assert.equal(row.result?.shellStatus, 'stopped');
		assert.match(row.result?.content ?? '', /标准输出首行[\s\S]*中间已截断[\s\S]*标准输出末行/);
		assert.match(row.result?.content ?? '', /错误输出首行[\s\S]*中间已截断[\s\S]*停止前的诊断/);
	}
});

void test('a background command releases the chat and only its owner can read incremental output and stop it', {
	skip: !shellTools().find(({ name }) => name === 'Bash')?.isAvailable?.(),
}, async (t) => {
	const { app, cwd } = await fixture(t);
	const layer = createToolLayer(undefined, undefined, scribeDataPaths(cwd).cache);
	const owner = 'background-owner';
	let pending: ToolCall[] = [];
	let approvals = 0;
	const sessions = sessionsFor(app, {
		stream({ signal }) {
			const calls = pending;
			pending = [];
			return fakeStream(calls.length ? emptyModelResponse('', calls) : emptyModelResponse('这轮聊天已继续。'), signal);
		},
	}, layer);
	const submit = (conversationId: string, calls: ToolCall[], allow = true) => {
		pending = calls;
		return sessions.submit({ conversationId, instruction: '处理这次后台命令。', refs: [] }, {
			approve: async (approval) => {
				approvals++;
				assert.equal(approval.kind, 'shell');
				return allow;
			},
		}, undefined, { executionMode: 'ask' }).result;
	};
	const command = [
		"printf '开始普通输出\\n'; printf '开始错误输出\\n' >&2",
		'while [[ ! -f next-step.txt ]]; do sleep 0.05; done',
		"printf '%s\\n' {1..6000}; printf '最后普通输出\\n'; { printf '%s\\n' {1..6000}; printf '最后错误输出\\n'; } >&2",
		'sleep 30',
	].join('; ');
	const start = { id: 'start', name: 'Bash', input: { command, elevated: true, run_in_background: true, timeout: 15_000 } };
	try {
		const denied = await submit(owner, [{ ...start, id: 'denied' }], false);
		assert.equal(denied.messages.find(({ toolCallId }) => toolCallId === 'denied')?.isError, true);
		assert.deepEqual(layer.shellJobs.list(owner), []);

		const started = await submit(owner, [start]);
		assert.equal(started.status, 'done', started.error);
		assert.equal(started.messages.at(-1)?.content, '这轮聊天已继续。');
		const receipt = started.messages.find(({ toolCallId }) => toolCallId === start.id)?.content ?? '';
		const id = /后台任务编号：([\w-]+)/u.exec(receipt)?.[1];
		assert.ok(id, receipt);
		assert.equal(layer.shellJobs.list(owner)[0]?.status, 'running');
		const read = { id: 'read', name: 'ShellJobOutput', input: { job_id: id } };
		const stop = { id: 'stop', name: 'ShellJobStop', input: { job_id: id } };
		const other = await submit('background-other', [read, stop]);
		const deniedOperations = other.messages.filter(({ role }) => role === 'tool');
		assert.deepEqual(deniedOperations.map(({ isError }) => isError), [true, true]);
		assert.doesNotMatch(deniedOperations.map(({ content }) => content).join('\n'), /开始普通输出|开始错误输出/);
		assert.deepEqual(layer.shellJobs.list('background-other'), []);
		assert.equal(layer.shellJobs.list(owner)[0]?.status, 'running');

		async function waitForBoth(jobId: string, stdoutMarker: string, stderrMarker: string) {
			let stdout = '';
			let stderr = '';
			const deadline = Date.now() + 3_000;
			while (!stdout.includes(stdoutMarker) || !stderr.includes(stderrMarker)) {
				const output = layer.shellJobs.read(owner, jobId);
				stdout += output?.stdout ?? '';
				stderr += output?.stderr ?? '';
				assert.ok(Date.now() < deadline, 'background output did not arrive');
				await delay(25);
			}
		}
		await waitForBoth(id, '开始普通输出', '开始错误输出');
		const first = await submit(owner, [read]);
		const firstOutput = first.messages.find(({ toolCallId }) => toolCallId === read.id)?.content ?? '';
		assert.match(firstOutput, /开始普通输出/);
		assert.match(firstOutput, /开始错误输出/);
		await writeFile(join(cwd, 'next-step.txt'), '');
		await waitForBoth(id, '最后普通输出', '最后错误输出');
		const next = await submit(owner, [{ ...read, id: 'next' }]);
		const nextOutput = next.messages.find(({ toolCallId }) => toolCallId === 'next')?.content ?? '';
		assert.match(nextOutput, /最后错误输出/);
		assert.match(nextOutput, /完整结果/);
		assert.doesNotMatch(nextOutput, /开始普通输出|开始错误输出/);

		const stopped = await submit(owner, [stop, { ...read, id: 'final', input: { job_id: id, final: true } }]);
		assert.equal(stopped.messages.find(({ toolCallId }) => toolCallId === stop.id)?.isError, false);
		assert.equal(layer.shellJobs.list(owner)[0]?.status, 'stopped');
		const final = stopped.messages.find(({ toolCallId }) => toolCallId === 'final')?.content ?? '';
		assert.match(final, /开始普通输出[\s\S]*中间已截断[\s\S]*最后普通输出/);
		assert.match(final, /开始错误输出[\s\S]*中间已截断[\s\S]*最后错误输出/);
		assert.equal(approvals, 2);
	} finally {
		sessions.dispose();
	}
});

void test('a long foreground command resumes the chat with the same process and output, then runs without a deadline', {
	skip: !shellTools().find(({ name }) => name === 'Bash')?.isAvailable?.(),
	timeout: 10_000,
}, async (t) => {
	const { app, cwd } = await fixture(t);
	const layer = createToolLayer();
	const conversationId = 'automatic-background';
	let approvals = 0;
	let requests = 0;
	let preview = { stdout: '', stderr: '' };
	const command = [
		'printf "%s\\n" "$$" >> started.txt',
		"printf '移交前的输出\\n'; printf '移交前的诊断\\n' >&2",
		'while [[ ! -f next-step.txt ]]; do sleep 0.05; done',
		'printf "%s\\n" "$$" > continued.txt',
		"printf '移交后的输出\\n'; printf '移交后的诊断\\n' >&2",
		'sleep 30',
	].join('; ');
	const call = { id: 'shell', name: 'Bash', input: { command, elevated: true, timeout: 12_000 } };
	const sessions = sessionsFor(app, {
		stream({ signal }) {
			const reply = requests++ ? emptyModelResponse('这轮聊天已继续。') : emptyModelResponse('', [call]);
			return fakeStream(reply, signal);
		},
	}, layer);
	t.after(() => sessions.dispose());
	const realDelay = delay;
	async function waitFor(check: () => boolean | Promise<boolean>, message: string) {
		const deadline = Date.now() + 3_000;
		while (!await check()) {
			assert.ok(Date.now() < deadline, message);
			await realDelay(25);
		}
	}
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const foreground = sessions.submit({ conversationId, instruction: '运行本地命令。', refs: [] }, {
		approve: async (approval) => {
			approvals++;
			assert.equal(approval.background, undefined);
			return true;
		},
		onEvent(event) {
			if (event.type === 'tool-output' && event.callId === call.id) preview = event.output;
		},
	}, undefined, { executionMode: 'ask' });
	const startedPath = join(cwd, 'started.txt');
	await waitFor(async () => Boolean(await readFile(startedPath, 'utf8').catch(() => '')), 'Bash did not start');
	let elapsed = 0;
	await waitFor(() => {
		elapsed += 250;
		assert.ok(elapsed < 10_000, 'foreground output did not arrive');
		t.mock.timers.tick(250);
		return preview.stdout.includes('移交前的输出') && preview.stderr.includes('移交前的诊断');
	}, 'Bash did not report foreground output');
	t.mock.timers.tick(9_999 - elapsed);
	assert.deepEqual(layer.shellJobs.list(conversationId), []);
	t.mock.timers.tick(1);

	const result = await foreground.result;
	assert.equal(result.status, 'done', result.error);
	assert.equal(result.messages.at(-1)?.content, '这轮聊天已继续。');
	const receipt = result.messages.find(({ toolCallId }) => toolCallId === call.id)?.content ?? '';
	const id = /后台任务编号：([\w-]+)/u.exec(receipt)?.[1];
	assert.ok(id, receipt);
	assert.equal(approvals, 1);
	assert.deepEqual(layer.shellJobs.read(conversationId, id), { stdout: '移交前的输出\n', stderr: '移交前的诊断\n' });
	await writeFile(join(cwd, 'next-step.txt'), '');
	let stdout = '';
	let stderr = '';
	await waitFor(() => {
		const output = layer.shellJobs.read(conversationId, id);
		stdout += output?.stdout ?? '';
		stderr += output?.stderr ?? '';
		return stdout.includes('移交后的输出') && stderr.includes('移交后的诊断');
	}, 'Bash did not continue in the background');
	assert.deepEqual({ stdout, stderr }, { stdout: '移交后的输出\n', stderr: '移交后的诊断\n' });
	const started = await readFile(startedPath, 'utf8');
	assert.match(started, /^\d+\n$/u);
	assert.equal(await readFile(join(cwd, 'continued.txt'), 'utf8'), started);

	t.mock.timers.tick(1_999);
	assert.equal(layer.shellJobs.get(conversationId, id)?.status, 'running');
	assert.deepEqual(layer.shellJobs.listUnread(conversationId), []);
	t.mock.timers.tick(1);
	assert.equal(layer.shellJobs.get(conversationId, id)?.status, 'running');
	await layer.shellJobs.stop(conversationId, id);
	assert.equal(layer.shellJobs.get(conversationId, id)?.status, 'stopped');
	assert.match(layer.shellJobs.get(conversationId, id)?.content ?? '', /移交前的输出[\s\S]*移交后的输出[\s\S]*移交前的诊断[\s\S]*移交后的诊断/u);
	assert.deepEqual(layer.shellJobs.listUnread(conversationId), [{ id, status: 'stopped' }]);
});

void test('background completions restore only unread notices in their chat without waking the model', {
	skip: !shellTools().find(({ name }) => name === 'Bash')?.isAvailable?.(),
	timeout: 10_000,
}, async (t) => {
	const { app, cwd } = await fixture(t);
	const directory = join(cwd, 'transcripts');
	const owner = 'saved-background-owner';
	const other = 'saved-background-other';
	const layer = createToolLayer(createConversationStore(directory).shellJobHistory);
	let pending: ToolCall[] = [];
	let approvals = 0;
	let modelRequests = 0;
	const model = {
		stream({ signal }: ModelRequest) {
			modelRequests++;
			const calls = pending;
			pending = [];
			return fakeStream(calls.length ? emptyModelResponse('', calls) : emptyModelResponse('处理完毕。'), signal);
		},
	};
	const sessions = sessionsFor(app, model, layer);
	const submit = (target: typeof sessions, conversationId: string, calls: ToolCall[]) => {
		pending = calls;
		return target.submit({ conversationId, instruction: '处理后台命令。', refs: [] }, {
			approve: async () => { approvals++; return true; },
		}, undefined, { executionMode: 'ask' }).result;
	};
	const call = (id: string, command: string): ToolCall => ({
		id, name: 'Bash', input: { command, elevated: true, run_in_background: true, timeout: 9_000 },
	});
	const read = (id: string, jobId: string): ToolCall => ({ id, name: 'ShellJobOutput', input: { job_id: jobId, final: true } });
	const unreadHistory = async (target: typeof sessions) => (await target.listConversations())
		.filter(({ unreadResult }) => unreadResult).map(({ id }) => id);
	const waitForRelease = 'while [[ ! -f finish.txt ]]; do sleep 0.05; done';
	try {
		const submitted = await submit(sessions, owner, [
			call('complete', `${waitForRelease}; printf '普通输出首行\\n'; printf '%s\\n' {1..6000}; printf '普通输出末行\\n'; printf '最终诊断\\n' >&2`),
			call('fail', `${waitForRelease}; exit 5`),
			call('keep-running', 'printf "%s\\n" "$$" >> launches.txt; printf "关闭前输出\\n"; printf "关闭前诊断\\n" >&2; sleep 30'),
		]);
		assert.equal(submitted.status, 'done', submitted.error);
		assert.equal(modelRequests, 2);
		const receiptId = (callId: string) => /后台任务编号：([\w-]+)/u.exec(
			submitted.messages.find(({ toolCallId }) => toolCallId === callId)?.content ?? '',
		)?.[1];
		const completedId = receiptId('complete');
		const failedId = receiptId('fail');
		const runningId = receiptId('keep-running');
		assert.ok(completedId && failedId && runningId);
		assert.equal(new Set([completedId, failedId, runningId]).size, 3);
		assert.deepEqual(layer.shellJobs.listUnread(owner), []);
		await writeFile(join(cwd, 'finish.txt'), '');
		let stdout = '';
		let stderr = '';
		const deadline = Date.now() + 3_000;
		while (true) {
			const output = layer.shellJobs.read(owner, runningId);
			stdout += output?.stdout ?? '';
			stderr += output?.stderr ?? '';
			if (stdout.includes('关闭前输出') && stderr.includes('关闭前诊断')
				&& layer.shellJobs.listUnread(owner).length >= 2) break;
			assert.ok(Date.now() < deadline, 'completion notices or the running command output did not arrive');
			await delay(25);
		}
		assert.equal(layer.shellJobs.get(owner, runningId)?.status, 'running');
		assert.deepEqual(layer.shellJobs.listUnread(other), []);
		await layer.shellJobs.markRead(other, completedId);
		assert.deepEqual(new Map(layer.shellJobs.listUnread(owner).map(({ id, status }) => [id, status])),
			new Map([[completedId, 'success'], [failedId, 'failed']]));
		await Promise.all([layer.shellJobs.markRead(owner, completedId), layer.shellJobs.markRead(owner, completedId)]);
		assert.deepEqual(layer.shellJobs.listUnread(owner), [{ id: failedId, status: 'failed' }]);
		assert.equal(modelRequests, 2);
		const launchPath = join(cwd, 'launches.txt');
		const launched = await readFile(launchPath, 'utf8');
		assert.match(launched, /^\d+\n$/u);
		sessions.dispose();
		await layer.shellJobs.dispose();
		if (process.platform !== 'win32') assert.throws(() => process.kill(Number(launched), 0), { code: 'ESRCH' });

		const restoredLayer = createToolLayer(createConversationStore(directory).shellJobHistory);
		const reopened = sessionsFor(app, model, restoredLayer);
		try {
			assert.equal(restoredLayer.shellJobs.hasUnread(owner), undefined);
			assert.deepEqual(await unreadHistory(reopened), [owner]);
			assert.equal((await reopened.openConversation(owner))?.id, owner);
			assert.deepEqual(await unreadHistory(reopened), [owner]);
			assert.deepEqual(restoredLayer.shellJobs.list(owner), []);
			const saved = await restoredLayer.shellJobs.listSaved(owner);
			assert.equal(saved.find(({ id }) => id === completedId)?.status, 'success');
			assert.equal(saved.find(({ id }) => id === failedId)?.status, 'failed');
			assert.equal(saved.find(({ id }) => id === runningId)?.status, 'stopped');
			assert.deepEqual(restoredLayer.shellJobs.listUnread(owner), [
				{ id: failedId, status: 'failed' }, { id: runningId, status: 'stopped' },
			]);
			await restoredLayer.shellJobs.listSaved(other);
			assert.deepEqual(restoredLayer.shellJobs.listUnread(other), []);
			await restoredLayer.shellJobs.markRead(owner, failedId);
			assert.deepEqual(restoredLayer.shellJobs.listUnread(owner), [{ id: runningId, status: 'stopped' }]);
			assert.deepEqual(await unreadHistory(reopened), [owner]);
			assert.equal(modelRequests, 2);
			const restored = await submit(reopened, owner, [read('saved-success', completedId), read('saved-stop', runningId)]);
			const toolResults = restored.messages.filter(({ role }) => role === 'tool');
			assert.deepEqual(toolResults.map(({ isError }) => isError), [false, false]);
			assert.match(toolResults[0]?.content ?? '', /成功[\s\S]*普通输出首行[\s\S]*中间已截断[\s\S]*普通输出末行[\s\S]*最终诊断/u);
			assert.match(toolResults[1]?.content ?? '', /停止[\s\S]*关闭前输出[\s\S]*关闭前诊断/u);
			const wrongChat = await submit(reopened, other, [read('denied', completedId)]);
			const rejected = wrongChat.messages.find(({ toolCallId }) => toolCallId === 'denied');
			assert.equal(rejected?.isError, true);
			assert.doesNotMatch(rejected?.content ?? '', /普通输出首行|最终诊断/u);
			assert.equal(await readFile(launchPath, 'utf8'), launched);
			assert.equal(approvals, 3);
		} finally {
			reopened.dispose();
			await restoredLayer.shellJobs.dispose();
		}

		const reopenedAgain = createToolLayer(createConversationStore(directory).shellJobHistory);
		const latest = sessionsFor(app, model, reopenedAgain);
		try {
			await reopenedAgain.shellJobs.listSaved(owner);
			assert.deepEqual(reopenedAgain.shellJobs.listUnread(owner), [{ id: runningId, status: 'stopped' }]);
			assert.deepEqual(reopenedAgain.shellJobs.list(owner), []);
			const beforeReading = modelRequests;
			const updates: (boolean | undefined)[] = [];
			const unsubscribe = reopenedAgain.shellJobs.subscribeAll(() => updates.push(reopenedAgain.shellJobs.hasUnread(owner)));
			await reopenedAgain.shellJobs.markRead(owner, runningId);
			unsubscribe();
			assert.deepEqual(updates, [false]);
			assert.deepEqual(await unreadHistory(latest), []);
			assert.equal(modelRequests, beforeReading);
		} finally {
			latest.dispose();
			await reopenedAgain.shellJobs.dispose();
		}
	} finally {
		sessions.dispose();
		await layer.shellJobs.dispose();
	}
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

void test('only the latest model text for the current user input can suggest an early stop', () => {
	const user: Message = { role: 'user', content: '请处理。' };
	const continuing: Message = { role: 'assistant', content: '接下来我会核对文件。' };
	const complete: Message = { role: 'assistant', content: '已核对文件。' };
	const tool: Message = { role: 'tool', content: '下一步需要检查：', toolCallId: 'last-tool', isError: true };
	for (const content of [
		continuing.content, '接下來我會確認。', "Now I'll check the result.", 'I can explain it with', '命令示例如下：', '```text\n示例',
	]) {
		assert.equal(mayHaveStoppedEarly([user, { role: 'assistant', content }, tool]), true, content);
	}
	for (const content of ['', '核对完毕', '请提供文件。', '需要我继续查看吗？', '```text\n示例：\n```']) {
		assert.equal(mayHaveStoppedEarly([user, { role: 'assistant', content }, tool]), false, content);
	}
	assert.equal(mayHaveStoppedEarly([user, continuing, complete, tool]), false);
	assert.equal(mayHaveStoppedEarly([user, continuing, { ...user, id: 'steer:latest' }, tool]), false);
});

for (const ending of ['recovered', 'still blank', 'has text'] as const) {
	void test(`an early-end reminder is private and sent at most once when the model ${ending}`, async (t) => {
		const { app } = await fixture(t);
		const previous = '接下来我会核对资料。';
		const final = ending === 'still blank' ? '' : '资料已核对。';
		const call = { id: 'verification', name: 'ReadStatus', input: {} };
		const replies = [emptyModelResponse(previous, [call])];
		if (ending !== 'has text') replies.push(emptyModelResponse('  '));
		replies.push(emptyModelResponse(final));
		const requests: ModelRequest[] = [];
		let executions = 0;
		const sessions = sessionsFor(app, { stream(request) {
			requests.push(request);
			const response = replies.shift();
			assert.ok(response);
			return fakeStream(response, request.signal);
		} }, [() => [{
			name: call.name, description: 'test', inputSchema: {}, isReadOnly: true,
			prepare: () => ({ run: () => { executions++; return '资料齐全'; } }),
		}]]);
		const conversationId = 'early-end';
		const instruction = '核对资料。';
		const result = await sessions.submit({ conversationId, instruction, refs: [] }, {
			onEvent(event) {
				if (event.type === 'state') assert.ok(event.state.messages.every(({ content }) => !content.includes('刚才在没有正文')));
			},
		}).result;
		assert.equal(result.status, 'done', result.error);
		assert.equal(executions, 1);
		assert.equal(requests.length, ending === 'has text' ? 2 : 3);
		assert.equal(requests[1]?.messages.at(-1)?.toolCallId, call.id);
		if (ending !== 'has text') {
			const followUp = requests[2]?.messages ?? [];
			assert.equal(followUp.at(-3)?.content, previous);
			assert.equal(followUp.at(-2)?.toolCallId, call.id);
			assert.equal(followUp.at(-1)?.role, 'user');
			assert.match(followUp.at(-1)?.content ?? '', /从停下的位置继续/u);
		}
		const saved = (await sessions.openConversation(conversationId))?.runs[0];
		assert.ok(saved);
		assert.deepEqual(saved.state.messages.filter(({ role }) => role === 'user').map(({ content }) => content), [instruction]);
		const { answer, rows } = chatTurnContent(restoreExecution(saved));
		assert.equal(answer, final);
		assert.deepEqual(rows.flatMap((row) => row.kind === 'text' ? [row.content] : []), [previous]);
		assert.ok(rows.every((row) => row.kind !== 'notice'));
	});
}

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

void test('truncated output continues beyond the old cap and stops when no new text arrives', async (t) => {
	const { app } = await fixture(t);
	let requests = 0;
	const sessions = sessionsFor(app, {
		stream: ({ signal }) => fakeStream(emptyModelResponse(++requests <= 5 ? `part ${requests}\n` : '',
			[{ id: 'partial', name: 'Read', input: {} }], 'limit'), signal),
	}, [readTools]);
	const result = await sessions.submit({ conversationId: 'limit', instruction: 'work', refs: [] }, {
		onEvent(event) { assert.notEqual(event.type, 'tool-start'); },
	}).result;
	assert.equal(result.status, 'limit');
	assert.equal(requests, 6);
	assert.equal(result.messages.at(-2)?.content, 'part 5\n');
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
	assert.equal(disabled.status, 'done');
	assert.equal(disabled.messages.at(-1)?.content, '模型已结束。');
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
	assert.equal(enabled.status, 'done');
	assert.equal(await readFile(join(cwd, call.input.file_path), 'utf8'), '临时笔记');
});

async function skillFixture(t: TestContext) {
	const { app, root, cwd } = await fixture(t);
	const shared = join(await realpath(root), 'skills');
	const settings = normalizeSettings(null);
	settings.skillSettings!.sharedDirectories = [shared];
	const registry = createSkillRegistry(app, settings, () => Promise.resolve(), { draft: async () => false, install: async () => false });
	async function draft(name: string): Promise<TaskRequest> {
		const dir = join(shared, name);
		await mkdir(dir, { recursive: true });
		const id = join(dir, 'SKILL.md');
		await writeFile(id, '---\nname: ' + name + '\ndescription: 有效技能说明\n---\n正文仅属于-' + name);
		return { conversationId: 'skill-test', instruction: '$' + name, refs: [], skillScope: [],
			skillMentions: [{ name, id, start: 0, end: name.length + 1 }] };
	}
	return { app, cwd, registry, settings, draft };
}

void test('技能撤回时，保留先前工作和已交付的插话，只退回本次未发送的失效插话', async (t) => {
	const { app, cwd, registry, settings, draft } = await skillFixture(t);
	const [request, earlier, stale] = await Promise.all([draft('primary'), draft('earlier'), draft('stale')]);
	const normal = { ...request, instruction: '补充一条普通要求', skillMentions: [] };
	const pending = new Map<string, TaskRequest>([['earlier', earlier]]);
	const rejected: string[] = [];
	const sent: ModelRequest[] = [];
	const ctx = await createRunContext(createTask(request), {
		cwd, model: { providerId: 'fake', model: 'fake' }, signal: new AbortController().signal, observer: {},
	}, app.vault.configDir);
	ctx.skillRun = createSkillRun(registry, request, 32_000, ctx.signal);
	ctx.takeSteering = () => [...pending].map(([id, input]) => ({ id, request: input }));
	ctx.rejectSteering = (ids, reason) => {
		assert.match(reason ?? '', /stale/u);
		for (const id of ids) { rejected.push(id); pending.delete(id); }
	};
	ctx.record = (event) => {
		if (event.type === 'state') for (const m of event.state.messages) {
			if (m.id?.startsWith('steer:')) pending.delete(m.id.slice(6));
		}
		return Promise.resolve();
	};
	const models = createModelCoordinator({ stream(input) {
		return {
			async *[Symbol.asyncIterator]() {
				if (sent.length && input.messages.some((m) => m.id === 'steer:stale')) settings.skillSettings!.sharedDirectories = [];
				await input.beforeSend?.('https://example.test/model');
				sent.push(input);
				yield* [];
			},
			async result() {
				if (sent.length === 1) { pending.set('stale', stale); pending.set('valid', normal); }
				return emptyModelResponse(sent.length === 1 ? '已保存此前工作。' : '普通要求已处理。');
			},
			cancel() {},
		};
	} }, createContextBuilder(createToolRegistry([])));
	const result = await createAgentLoop(models, { async *runCalls() {} }).run(ctx, createRunState(ctx));
	assert.equal(result.status, 'done', result.error);
	assert.deepEqual(rejected, ['stale']);
	assert.equal(sent.length, 2);
	const previous = sent[0]!.messages.map((m) => m.content).join('\n');
	assert.match(previous, /正文仅属于-primary/u);
	assert.match(previous, /正文仅属于-earlier/u);
	const latest = sent[1]!.messages.map((m) => m.content).join('\n');
	assert.doesNotMatch(latest, /正文仅属于|stale/u);
	assert.match(latest, /已保存此前工作。/u);
	assert.match(latest, /普通要求/u);
	assert.deepEqual(result.messages.flatMap((m) => m.id?.startsWith('steer:') ? [m.id] : []), ['steer:earlier', 'steer:valid']);
});

void test('模型重连前撤回已尝试发送的技能，只按新权限重发原消息', async (t) => {
	const { app, cwd, registry, settings, draft } = await skillFixture(t);
	const request = await draft('retry');
	const ctx = await createRunContext(createTask(request), {
		cwd, model: { providerId: 'fake', model: 'fake' }, signal: new AbortController().signal, observer: {},
	}, app.vault.configDir);
	ctx.skillRun = createSkillRun(registry, request, 32_000, ctx.signal);
	const sent: ModelRequest[] = [];
	const models = createModelCoordinator({ stream(input) {
		return {
			async *[Symbol.asyncIterator]() {
				await input.beforeSend?.('https://example.test/model');
				sent.push(input);
				yield* [];
			},
			async result() {
				if (sent.length === 1) { settings.skillSettings!.sharedDirectories = []; throw new RetryableModelError('连接中断'); }
				return emptyModelResponse('已继续。');
			},
			cancel() {},
		};
	} }, createContextBuilder(createToolRegistry([])));
	const state = await createAgentLoop(models, { async *runCalls() {} }).run(ctx, createRunState(ctx));
	assert.equal(state.status, 'done', state.error);
	assert.match(JSON.stringify(sent[0]?.messages), /正文仅属于-retry/u);
	assert.doesNotMatch(JSON.stringify(sent[1]?.messages), /正文仅属于-retry/u);
});

void test('待发送的队首技能已停用时，原消息仍可在队列中编辑', async (t) => {
	const { app, cwd, registry, settings, draft } = await skillFixture(t);
	const sessions = sessionsFor(app, { stream: () => assert.fail('失效技能不能发给模型') }, [], settings, registry);
	t.after(() => sessions.dispose());
	const request = await draft('queued');
	request.conversationId = await sessions.createConversation();
	const row = { id: 'queued', request };
	const store = createConversationStore(join(cwd, 'transcripts'));
	await store.enqueue(request.conversationId, row);
	settings.skillSettings!.disabledIds = [request.skillMentions![0]!.id];
	await assert.rejects(sessions.submitQueued(row, {}, () => assert.fail('未执行的消息不能离开队列')).result, /已停用/u);
	assert.deepEqual(await store.getQueued(request.conversationId), [row]);
	assert.equal((await store.load(request.conversationId)).runs.length, 0);
});

void test('恢复已完成发送的技能选择，不会改选同名来源或重复发送旧目录', async (t) => {
	const { cwd, registry, settings, draft } = await skillFixture(t);
	const request = await draft('prior');
	const first = taskMessage(request);
	const history: Message[] = [first, { role: 'assistant', content: '先前的回答', toolCalls: [{ id: 'f', name: 'list_skill_files', input: { id: request.skillMentions![0]!.id } }] },
		{ role: 'tool', content: '此前获得的私有文件名', toolName: 'list_skill_files', toolCallId: 'f' }];
	const replacement = join(await realpath(cwd), 'other');
	await mkdir(join(replacement, 'prior'), { recursive: true });
	await writeFile(join(replacement, 'prior/SKILL.md'), '---\nname: prior\ndescription: 同名新来源\n---\n新的机密正文');
	settings.skillSettings!.sharedDirectories = [replacement];
	const run = createSkillRun(registry, request, 32_000, new AbortController().signal);
	run.rememberCommitted(history);
	const result = await run.project(history, true);
	assert.equal(result.instructions, '');
	assert.doesNotMatch(JSON.stringify(result.messages), /私有文件名/u);
	const checkpoint: Message[] = [first, { role: 'user', id: 'steer:accepted', content: '已经收到的补充' }];
	const interrupted = createSkillRun(registry, request, 32_000, new AbortController().signal);
	interrupted.rememberCommitted(checkpoint);
	assert.equal((await interrupted.project(checkpoint, true)).instructions, '');
});
