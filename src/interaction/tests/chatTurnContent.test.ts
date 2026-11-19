import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, RunStatus } from '../../types';
import { parseConversationEntry, replayConversation } from '../../orchestration/storage/taskStore';
import { createTask } from '../../orchestration/taskManager';
import { conversationMetrics, messageTime } from '../chatMetrics';
import { chatTurnContent, chatTurnPreview } from '../chatTurnContent';
import { emptyExecution, restoreExecution, updateExecution } from '../context';

const read = { id: 'reused', name: 'Read', input: { file_path: '示例.md' } };
const grep = { id: 'reused', name: 'Grep', input: { pattern: '示例' } };
const queued = { id: 'not-started', name: 'Read', input: {} };

function state(messages: Message[], status: RunStatus = 'done', turn = 1) {
	return { taskId: 'task', turn, messages, pendingCalls: [], status };
}
function saved(messages: Message[], status?: RunStatus) {
	return {
		request: { conversationId: 'conversation', instruction: '查看示例', refs: [] },
		model: { providerId: 'test', model: 'test' },
		state: state(messages, status),
	};
}

const metadata = {
	role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'test',
	stopReason: 'stop', timestamp: 1_700_000_000_000, durationMs: 1_200,
	usage: { input: 54, output: 18, cacheRead: 0, cacheWrite: 0, totalTokens: 72,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} as const;

void test('round and conversation metrics use measured timings and provider token reports', () => {
	const output: Message = { role: 'assistant', content: 'First', toolCalls: [read], usage: {
		input: 100, cacheRead: 300, cacheWrite: 50, output: 25, totalTokens: 999,
		cost: { ...metadata.usage.cost, total: 1, totalFromProvider: true },
	}, metrics: { endedAt: 5000, modelMs: 2500, firstDeltaMs: 500, decodeMs: 2000, contextWindow: 1000 } };
	const next: Message = { role: 'assistant', content: 'Second', truncated: true, usage: {
		input: 200, cacheRead: 200, cacheWrite: 1, output: 50, totalTokens: 999,
		cost: { ...metadata.usage.cost, total: 8 },
	}, metrics: { endedAt: 8000, modelMs: 2500, firstDeltaMs: 1000, decodeMs: 1500, contextWindow: 1000 } };
	const first = state([output, { role: 'tool', content: 'result', toolCallId: read.id, toolDurationMs: 137 }]);
	const second = { ...state([next]), taskId: 'second' };
	const metrics = conversationMetrics([first, second]);
	assert.deepEqual(metrics, {
		rounds: 2, count: 2, modelMs: 5000, toolMs: 137, lagMs: 750, speed: 75000 / 3500,
		usage: { input: 300, cacheRead: 500, cacheWrite: 51, output: 75, total: 926,
			hit: 500 / 851, cost: 1, missing: false },
		context: { prompt: 401, capacity: 1000, remaining: 599, percent: 41 },
	});
	const noUsage: Message = { ...next, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: metadata.usage.cost } };
	assert.equal(conversationMetrics([state([noUsage])]).usage, undefined);
	const missing = conversationMetrics([first, { ...second, messages: [noUsage] }]);
	assert.equal(missing.usage?.total, 475);
	assert.equal(missing.usage.missing, true);
	assert.equal(missing.context, undefined);
	assert.equal(missing.speed, undefined);
	assert.equal(conversationMetrics([state([{ ...output, metrics: undefined }])]).speed, undefined);
});

void test('turn navigation previews the displayed prompt and last reply without exposing other activity', () => {
	const execution = restoreExecution(saved([
		{ role: 'user', content: '按当前  指令\n检查。' },
		{ role: 'assistant', content: '先读取。', toolCalls: [read] },
		{ role: 'tool', toolCallId: read.id, content: '工具全文' },
		{ role: 'assistant', content: '最终  答复。' },
	]));
	const withRetry = {
		...execution,
		items: [...execution.items, { kind: 'text' as const, id: 'retry', messageId: 'retry', content: '断流段落', abandoned: true }],
	};
	assert.deepEqual(chatTurnPreview(withRetry), { prompt: '按当前 指令 检查。', reply: '最终 答复。' });
	assert.equal(chatTurnPreview(withRetry, '片'.repeat(319) + '📝剩余正文').prompt, '片'.repeat(319) + '…');
});

void test('restores ordered legacy replies and tools while pairing reused call ids by message', () => {
	const run = saved([
		{ role: 'assistant', content: '正在补做。\n\n' },
		{ role: 'assistant', content: '先读取。', toolCalls: [read] },
		{ role: 'tool', content: '文件正文', toolCallId: read.id },
		{ role: 'assistant', content: '', toolCalls: [grep, queued] },
		{ role: 'tool', content: '搜索失败', toolCallId: grep.id, isError: true },
		{ role: 'assistant', content: '# 总结\n\n', incomplete: true },
		{ role: 'assistant', content: '- 已保留原文' },
	]);
	const result = chatTurnContent(restoreExecution(run));
	assert.equal(result.user, '查看示例');
	assert.deepEqual(result.rows.map(({ kind }) => kind), ['text', 'text', 'tool', 'tool']);
	const tools = result.rows.filter((row) => row.kind === 'tool');
	assert.notEqual(tools[0]?.id, tools[1]?.id);
	assert.deepEqual(tools.map(({ result }) => [result?.content, result?.isError]), [['文件正文', false], ['搜索失败', true]]);
	assert.equal(result.answer, '# 总结\n\n- 已保留原文');
	assert.equal(messageTime(result.answerMessage), undefined);
});

void test('keeps the interrupted tool visible without exposing an unstarted sibling', () => {
	const run = saved([{ role: 'assistant', content: '', toolCalls: [read, queued] }], 'interrupted');
	const restarted = restoreExecution({ ...run, step: { phase: 'approval', turn: 1, call: read } });
	assert.deepEqual(restarted.items.map(({ kind }) => kind), ['tool', 'notice']);
	assert.equal(restarted.items[0]?.kind === 'tool' && restarted.items[0].call, read);
});

void test('keeps the recorded order of older mixed replies and hides redacted reasoning', () => {
	const rawAssistant = {
		...metadata,
		content: [
			{ type: 'text', text: '先看原文。' },
			{ type: 'thinking', thinking: '需要读取。' },
			{ type: 'thinking', thinking: '不可展示', redacted: true },
			{ type: 'toolCall', id: read.id, name: read.name, arguments: read.input },
			{ type: 'text', text: '接着总结。' },
		],
	} satisfies NonNullable<Message['rawAssistant']>;
	const result = chatTurnContent(restoreExecution(saved([
		{ role: 'assistant', content: '先看原文。接着总结。', toolCalls: [read], rawAssistant },
		{ role: 'tool', content: '文件正文', toolCallId: read.id },
	])));
	assert.deepEqual(result.rows.map(({ kind }) => kind), ['text', 'thinking', 'tool', 'text']);
	assert.equal(result.answer, '');
});

void test('live thoughts, tools and text keep their ids when committed and reopened', () => {
	const firstId = 'assistant:task:1';
	const secondId = 'assistant:task:2';
	let execution = updateExecution(emptyExecution, { type: 'state', state: state([], 'running') });
	execution = updateExecution(execution, { type: 'thinking-delta', messageId: firstId, contentIndex: 0, text: '分析' });
	execution = updateExecution(execution, { type: 'thinking-end', messageId: firstId, contentIndex: 0, durationMs: 2000 });
	const first: Message = {
		id: firstId, role: 'assistant', content: '', toolCalls: [read],
		rawAssistant: { ...metadata, content: [{ type: 'thinking', thinking: '分析', durationMs: 2000 }] },
	};
	execution = updateExecution(execution, { type: 'state', state: state([first], 'running') });
	execution = updateExecution(execution, { type: 'tool-start', call: read });
	const readId = execution.items.at(-1)?.id;
	const result = { callId: read.id, content: '文件正文', isError: false };
	execution = updateExecution(execution, { type: 'tool-end', call: read, result });
	assert.equal(execution.items.at(-1)?.id, readId);
	assert.equal(execution.items.length, 2);
	const readResult: Message = { role: 'tool', toolCallId: read.id, content: result.content };
	execution = updateExecution(execution, { type: 'turn-start', turn: 2 });
	execution = updateExecution(execution, { type: 'text-delta', messageId: secondId, contentIndex: 0, text: '接着查找。' });
	const second: Message = { id: secondId, role: 'assistant', content: '接着查找。', toolCalls: [grep, queued] };
	const messages = [first, readResult, second];
	execution = updateExecution(execution, { type: 'state', state: state(messages, 'running', 2) });
	execution = updateExecution(execution, { type: 'tool-start', call: grep });
	assert.deepEqual(chatTurnContent(execution).rows.map(({ kind }) => kind), ['thinking', 'tool', 'text', 'tool']);
	const liveIds = execution.items.map(({ id }) => id);
	messages.push({ role: 'tool', toolCallId: grep.id, content: '找到了' });
	const run = saved(messages);
	execution = updateExecution(execution, { type: 'state', state: run.state });
	assert.deepEqual(execution.items.map(({ id }) => id), liveIds);
	assert.deepEqual(restoreExecution(run).items.map(({ id }) => id), liveIds);
});

void test('a retry or interrupted run turns its notice muted after the corresponding success', () => {
	const failedId = 'assistant:task:1';
	const retryId = failedId + ':retry:1';
	let execution = updateExecution(emptyExecution, { type: 'state', state: state([], 'running') });
	execution = updateExecution(execution, { type: 'thinking-delta', messageId: failedId, contentIndex: 0, text: '第一次' });
	execution = updateExecution(execution, { type: 'text-delta', messageId: failedId, contentIndex: 1, text: '断开的半句' });
	execution = updateExecution(execution, { type: 'model-retry', waiting: false, messageId: failedId });
	execution = updateExecution(execution, { type: 'thinking-delta', messageId: retryId, contentIndex: 0, text: '第二次' });
	execution = updateExecution(execution, { type: 'state', state: state([], 'interrupted') });
	const final: Message = {
		id: retryId, role: 'assistant', content: '已恢复。', thinkingBlocks: [{ type: 'thinking', contentIndex: 0, thinking: '第二次' }], textIndex: 1,
	};
	execution = updateExecution(execution, { type: 'state', state: { ...state([final]), resumed: true } });
	const notices = execution.items.filter((row) => row.kind === 'notice');
	assert.deepEqual(notices.map(({ code, tone, resolved }) => [code, tone, resolved]), [
		['reconnect', 'info', true], ['interrupted', 'info', true],
	]);
	assert.deepEqual(execution.items.filter((row) => row.kind === 'thinking').map(({ content }) => content), ['第一次', '第二次']);
	assert.equal(chatTurnContent(execution).answer, '已恢复。');
});

void test('a reopened partial message keeps thought and text in their original order', () => {
	const result = chatTurnContent(restoreExecution(saved([{
		role: 'assistant', id: 'assistant:task:1', content: '先写的文字', incomplete: true, textIndex: 0,
		thinkingBlocks: [{ type: 'thinking', thinking: '后来的思考', contentIndex: 1, durationMs: 500 }],
	}], 'interrupted')));
	assert.deepEqual(result.rows.map(({ kind }) => kind), ['text', 'thinking', 'notice']);
	assert.equal(result.answer, '');
});

void test('only the confirmed reply leaves the timeline, including its saved continuation fragments', () => {
	const first: Message = { role: 'assistant', content: '这是回', truncated: true, id: 'assistant:task:1' };
	const second: Message = { role: 'assistant', content: '答。', id: 'assistant:task:2', thinkingBlocks: [
		{ type: 'thinking', contentIndex: 0, thinking: '接着回答。' },
	], textIndex: 1 };
	let execution = updateExecution(emptyExecution, { type: 'state', state: state([first], 'running') });
	execution = updateExecution(execution, { type: 'text-delta', messageId: second.id!, contentIndex: 1, text: second.content });
	assert.equal(chatTurnContent(execution).answer, '');
	assert.deepEqual(chatTurnContent(execution).rows.map(({ kind }) => kind), ['text', 'text']);
	for (const status of ['awaiting-approval', 'partial', 'failed', 'cancelled', 'interrupted', 'limit'] as const) {
		const failed = updateExecution(execution, { type: 'state', state: state([first, second], status, 2) });
		assert.equal(chatTurnContent(failed).answer, '', status);
		assert.equal(chatTurnContent(failed).copyText, '这是回答。', status);
		assert.equal(chatTurnContent(failed).showCompletion, false, status);
		assert.equal(chatTurnContent(failed).rows.filter(({ kind }) => kind === 'text').length, 2, status);
	}
	const done = updateExecution(execution, { type: 'state', state: state([first, second], 'done', 2) });
	const result = chatTurnContent(done);
	assert.equal(result.answer, '这是回答。');
	assert.equal(result.answerMessage, second);
	assert.deepEqual(result.rows.map(({ kind }) => kind), ['thinking']);
	assert.equal(chatTurnPreview(done).reply, '这是回答。');
	const legacy = restoreExecution(saved([{ ...first, truncated: undefined, toolCalls: [] }, second]));
	assert.equal(chatTurnContent(legacy).answer, '这是回答。');
});

void test('restores retries at their original position and keeps a notice-only failure flat', () => {
	const retryId = 'assistant:task:2';
	const run = saved([
		{ role: 'assistant', content: '先读取。', toolCalls: [read] },
		{ role: 'tool', content: '读完。', toolCallId: read.id },
		{ role: 'assistant', content: '已完成。', id: retryId + ':retry:1' },
	]);
	const result = chatTurnContent(restoreExecution({
		...run, retries: [
			{ beforeMessage: 2, event: { type: 'model-retry', waiting: true, messageId: retryId } },
			{ beforeMessage: 2, event: { type: 'model-retry', waiting: false, messageId: retryId } },
		],
	}));
	assert.equal(result.answer, '已完成。');
	assert.deepEqual(result.rows.map(({ kind }) => kind), ['text', 'tool', 'notice']);
	assert.deepEqual(result.rows.at(-1), { kind: 'notice', id: `retry:${retryId}`, code: 'reconnect', tone: 'info',
		messageId: retryId, resolved: true });
	const failed = chatTurnContent(restoreExecution(saved([], 'failed')));
	assert.equal(failed.answer, '');
	assert.deepEqual(failed.rows.map(({ kind }) => kind), ['notice']);
});

void test('merges an older reasoning checkpoint into the retry and preserves displayed order', async () => {
	const { request, model } = saved([]);
	const task = createTask(request);
	const messageId = `assistant:${task.id}:1`;
	const records = [
		{ type: 'start', task, model },
		{ type: 'messages', taskId: task.id, messages: [{ role: 'assistant', id: messageId, content: '', incomplete: true,
			thinkingBlocks: [{ type: 'thinking', contentIndex: 1, thinking: '后来的思考', durationMs: 10 }] }] },
		{ type: 'retry', taskId: task.id, retry: { beforeMessage: 0, event: { type: 'model-retry', messageId, waiting: false },
			draft: { content: '先输出的文字', textIndex: 0 } } },
	];
	const snapshot = await replayConversation(request.conversationId,
		records.map((entry, index) => parseConversationEntry(JSON.stringify(entry), index + 1)));
	const run = snapshot.runs[0]!;
	assert.equal(run.state.messages.length, 0);
	const { rows } = chatTurnContent(restoreExecution(run));
	assert.deepEqual(rows.map(({ kind }) => kind), ['text', 'thinking', 'notice', 'notice']);
});

void test('marks equivalent successful tool retries as resolved and indicates empty completions', () => {
	const first = { id: 'first', name: 'Edit', input: { target: 'a.md', options: { from: 'old', to: 'new' } } };
	const second = { id: 'second', name: 'Edit', input: { options: { to: 'new', from: 'old' }, target: 'a.md' } };
	const result = restoreExecution(saved([
		{ role: 'assistant', content: '', toolCalls: [first] },
		{ role: 'tool', content: '失败', toolCallId: first.id, isError: true },
		{ role: 'assistant', content: '', toolCalls: [second] },
		{ role: 'tool', content: '成功', toolCallId: second.id },
		{ role: 'assistant', content: '  ' },
	], 'file-changes-done'));
	assert.equal(result.items.some((row) => row.kind === 'tool' && row.call.id === first.id && row.resolved), true);
	assert.equal(chatTurnContent(result).showCompletion, true);
});
