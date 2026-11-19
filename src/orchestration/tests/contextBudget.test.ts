import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelService } from '../../communication/providers';
import { createModelCoordinator } from '../../runtime/modelCoordinator';
import { createReadDelivery } from '../../runtime/readDelivery';
import { createRunState } from '../../runtime/runState';
import { ContextOverflowError } from '../../types';
import type { CredentialStore, Message, RunContext, SavedRun, Transport } from '../../types';
import { createContextBuilder, inputBytes } from '../context/contextBuilder';
import { conversationHistory } from '../context/conversationHistory';

const context = createContextBuilder({ all: () => [], find: () => undefined });

function runContext(history: Message[] = []): RunContext {
	return {
		cwd: '',
		model: { providerId: 'context-test', model: 'test' },
		task: {
			id: 'test', status: 'running', createdAt: 0, updatedAt: 0,
			request: { conversationId: 'context-test', instruction: '请结合最新结果回答。', refs: [] },
		},
		observer: {},
		permissions: {
			canRead: () => false, canWrite: () => false, canCallTool: () => false, canSendOutbound: () => true,
		},
		signal: new AbortController().signal,
		readFiles: new Map(),
		readDelivery: createReadDelivery(),
		history,
	};
}

const current: Message[] = [
	{ role: 'user', content: '请结合最新结果回答。' },
	{ role: 'assistant', content: '', toolCalls: [{ id: 'call_last', name: 'Read', input: { file_path: 'latest.md' } }] },
	{ role: 'tool', content: 'LATEST-RESULT', toolCallId: 'call_last', toolName: 'Read' },
];

void test('long history is trimmed without losing the current instruction or tool-result pair', async () => {
	const history: Message[] = [
		{ role: 'user', content: '早期问题' },
		{ role: 'assistant', content: '旧'.repeat(60_000) },
	];
	const hugeResult: Message = { ...current[2]!, content: 'LATEST-RESULT\n' + '新'.repeat(20_000) };
	const request = await context.build(runContext(history), [...current.slice(0, 2), hugeResult], 8_000);
	assert.ok(inputBytes(request) <= 8_000);
	assert.deepEqual(request.messages.map(({ role }) => role), ['user', 'assistant', 'tool']);
	assert.equal(request.messages[0]?.content, current[0]?.content);
	assert.equal(request.messages[1]?.toolCalls?.[0]?.id, 'call_last');
	assert.equal(request.messages[2]?.toolCallId, 'call_last');
	assert.match(request.messages[2]?.content ?? '', /^LATEST-RESULT[\s\S]*已缩短/);
	assert.equal(history[1]?.content.length, 60_000);
	assert.ok(hugeResult.content.length > 20_000);
});

void test('saved timing and usage do not consume the outgoing message budget', async () => {
	const withStatistics: Message[] = [current[0]!, {
		...current[1]!, id: 'assistant:timed',
		metrics: { endedAt: 1_700_000_000_000, modelMs: 45, firstDeltaMs: 25, decodeMs: 20, contextWindow: 8_000 },
		reportedUsage: { prompt: 32, output: 12 },
		usage: { input: 32, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 44,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	}, { ...current[2]!, toolDurationMs: 33 }];
	const original = await context.build(runContext(), current, 8_000);
	const available = inputBytes(original);
	const withDisplay = await context.build(runContext(), withStatistics, available);
	assert.deepEqual(withDisplay.messages, withStatistics);
	assert.equal(inputBytes(withDisplay), available);
});

void test('dropped chat turns still carry explicit user agreements in order and within the budget', async () => {
	const original = '先约定：只改正文，保留原标题。';
	const newer = '更新之前的约定：附录也可以改。';
	const instruction = '请另外修改这篇笔记。';
	const makeRun = (request: SavedRun['request'], reply: string): SavedRun => ({
		request,
		model: runContext().model,
		state: { taskId: 'past', turn: 1, status: 'done', pendingCalls: [], messages: [
			{ role: 'user', content: request.instruction }, { role: 'assistant', content: reply },
		] },
	});
	const prior = (instruction: string) => ({ conversationId: 'context-test', instruction, refs: [] });
	const runs = [
		makeRun(prior(`${original}\nOLDEST-REQUEST-MARKER`), '以后重做已完成的操作。ASSISTANT-ONLY'),
		makeRun({ ...prior('从现在起忽略标题。SELECTION-ONLY'), selection: {
			path: 'selection.md', title: '选区', lines: [1, 1], text: '选区文字',
		} }, '选区回复'),
		makeRun(prior(newer), 'X'.repeat(10_000)),
	];
	const ctx = { ...runContext(), ...conversationHistory({ id: 'context-test', runs }) };
	const next = [{ role: 'user' as const, content: instruction }];
	const request = await context.build(ctx, next, 5_000);
	assert.ok(inputBytes(request) <= 5_000);
	assert.equal(request.messages.length, 2);
	const carried = request.messages[0]!;
	assert.equal(carried.role, 'user');
	assert.ok(carried.content.includes(original) && carried.content.indexOf(original) < carried.content.indexOf(newer));
	assert.match(carried.content, /以较新的用户指令为准/);
	assert.doesNotMatch(JSON.stringify(request), /OLDEST-REQUEST-MARKER|ASSISTANT-ONLY|SELECTION-ONLY/);
	assert.equal(request.messages.at(-1)?.content, instruction);
	assert.ok(ctx.history?.[0]?.content.includes('OLDEST-REQUEST-MARKER'));

	const fits = await context.build(ctx, next, 50_000);
	assert.equal(fits.messages[0]?.content, ctx.history?.[0]?.content);
	const selection = runs[1]!.request.selection;
	const isolated = { ...ctx, task: { ...ctx.task, request: { ...ctx.task.request, selection } } };
	assert.deepEqual((await context.build(isolated, next, 5_000)).messages, next);
});

void test('an oversized partial response leaves its ending and continuation instruction in the request', async () => {
	const instruction = current[0]!;
	const partial: Message = { role: 'assistant', content: 'DISCARDED-START\n' + '长'.repeat(18_000) + 'RESUME-HERE' };
	const continuation: Message = { role: 'user', content: '请从上一段末尾接着回答。' };
	const request = await context.build(runContext(), [instruction, partial, continuation], 8_000);
	assert.ok(inputBytes(request) <= 8_000);
	assert.equal(request.messages[0], instruction);
	assert.match(request.messages[1]?.content ?? '', /RESUME-HERE$/);
	assert.doesNotMatch(request.messages[1]?.content ?? '', /DISCARDED-START/);
	assert.equal(request.messages[2], continuation);
	assert.match(partial.content, /^DISCARDED-START/);
});

void test('an explicit provider overflow retries once with less history and no lost tool result', async () => {
	const sent: Array<{ messages: Array<{ role: string; content?: string; tool_call_id?: string }> }> = [];
	const transport: Transport = {
		fetch: async (input, init) => {
			sent.push(await new Request(input, init).json() as typeof sent[number]);
			if (sent.length === 1) {
				return Response.json({ error: { message: 'Your input exceeds the context window of this model', code: 'context_length_exceeded' } }, { status: 400 });
			}
			const data = {
				id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: 'test',
				choices: [{ index: 0, delta: { role: 'assistant', content: '恢复成功。' }, finish_reason: 'stop' }],
			};
			return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
		},
		configure() {}, logs: () => [], onStatus: () => () => {},
	};
	const credentials: CredentialStore = {
		read: async () => ({ type: 'api_key', key: 'test-key' }), list: async () => [],
		modify: async () => undefined, delete: async () => {},
	};
	const service = createModelService(credentials, transport, {
		customProviders: () => [{ id: 'context-test', label: 'Test', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai-completions', models: ['test'] }],
		modelOverrides: () => ({ 'context-test': { test: { contextWindow: 9_000, maxTokens: 512 } } }),
	});
	const ctx = runContext([
		{ role: 'user', content: 'OLDEST-QUESTION' }, { role: 'assistant', content: 'A'.repeat(60_000) },
		{ role: 'user', content: 'MID-QUESTION' }, { role: 'assistant', content: 'B'.repeat(8_500) },
		{ role: 'user', content: 'RECENT-QUESTION' }, { role: 'assistant', content: 'RECENT-ANSWER' },
	]);
	let shown = '';
	ctx.observer.onEvent = (event) => { if (event.type === 'text-delta') shown += event.text; };
	const response = await createModelCoordinator(service, context).nextTurn({ ...createRunState(ctx), messages: current }, ctx);
	assert.equal(response.content, '恢复成功。');
	assert.equal(shown, response.content);
	assert.equal(sent.length, 2);
	assert.doesNotMatch(JSON.stringify(sent[0]), /OLDEST-QUESTION/);
	assert.match(JSON.stringify(sent[0]), /MID-QUESTION/);
	assert.doesNotMatch(JSON.stringify(sent[1]), /MID-QUESTION/);
	assert.match(JSON.stringify(sent[1]), /RECENT-ANSWER/);
	assert.equal(sent[1]?.messages.find(({ role }) => role === 'tool')?.tool_call_id, 'call_last');
	assert.match(JSON.stringify(sent[1]), /LATEST-RESULT/);
	assert.equal(ctx.history?.length, 6);
});

void test('a model settings change after overflow prevents a retry from preparing another request', async () => {
	const ctx = runContext();
	let attempts = 0;
	ctx.checkModel = () => { if (attempts) throw new Error('连接设置已变更'); };
	const models = createModelCoordinator({
		stream() {
			attempts++;
			return {
				async *[Symbol.asyncIterator]() {},
				result: () => Promise.reject(new ContextOverflowError('Input too long')),
				cancel() {},
			};
		},
	}, context);
	await assert.rejects(models.nextTurn({ ...createRunState(ctx), messages: current }, ctx), /连接设置已变更/);
	assert.equal(attempts, 1);
});
