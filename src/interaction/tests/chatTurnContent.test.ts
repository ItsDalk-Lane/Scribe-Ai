import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, RunState, RunStatus } from '../../types';
import { parseConversationEntry, replayConversation } from '../../orchestration/storage/taskStore';
import { createTask } from '../../orchestration/taskManager';
import { latestIncompleteReply } from '../../runtime/continuationText';
import { conversationMetrics, messageTime, runUsage } from '../chatMetrics';
import { chatTurnContent, chatTurnPreview } from '../chatTurnContent';
import { emptyExecution, restoreExecution, updateExecution } from '../context';
import { collaborationRows } from '../subagentTimeline';

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

void test('main chat shows each successful dispatch, outgoing contact and submitted draft exactly once', () => {
	const identity = { id: 'worker', name: '签到负责人' };
	const messages: Message[] = [];
	function call(name: string, input: Record<string, string>, output: unknown, isError = false) {
		const id = `call-${messages.length}`;
		messages.push({ role: 'assistant', content: '', id: `assistant-${id}`, toolCalls: [{ id, name, input }] },
			{ role: 'tool', toolCallId: id, content: typeof output === 'string' ? output : JSON.stringify(output), isError });
	}
	function received(id: string, kind: 'question' | 'result') {
		messages.push({ role: 'assistant', local: true, content: '只在子聊天展示的原文',
			subagentActivity: { id, kind, agentId: identity.id, agentName: identity.name } });
	}
	call('spawn_agent', {}, identity);
	received('question', 'question');
	call('answer_subagent', {}, { target: identity.id, name: identity.name });
	call('send_message', { target: identity.id }, '消息已保存。');
	call('wait_agent', {}, {});
	received('draft', 'result');
	call('review_subagent_result', { decision: 'revise' }, { status: 'returned', agent: identity });
	call('list_agents', {}, [identity]);
	call('list_agents', {}, [identity]);
	received('revised', 'result');
	call('review_subagent_result', { decision: 'use' }, { status: 'passed' });
	call('read_subagent_result', {}, '交稿全文');
	call('followup_task', { target: identity.id }, identity);
	call('interrupt_agent', {}, identity);
	call('close_agent', {}, identity);
	call('resume_agent', {}, identity);
	call('spawn_agent', {}, '额度用尽', true);
	messages.push({ role: 'assistant', content: '主聊天的最终汇总' });
	for (const execution of [restoreExecution(saved(messages)), updateExecution(emptyExecution, { type: 'state', state: state(messages) })]) {
		const content = chatTurnContent(execution);
		const visible = collaborationRows(content.rows);
		assert.deepEqual(visible.map((row) => row.kind === 'collaboration' ? [row.action, row.agentId] : [row.kind]), [
			['started', 'worker'], ['contacted', 'worker'], ['contacted', 'worker'], ['completed', 'worker'],
			['contacted', 'worker'], ['completed', 'worker'], ['contacted', 'worker'], ['notice'],
		]);
		assert.equal(content.answer, '主聊天的最终汇总');
		assert.ok(!JSON.stringify(visible).includes('展示的原文'));
		const warning = visible.at(-1);
		assert.equal(warning?.kind === 'notice' && warning.detail, '额度用尽');
		const failed = collaborationRows(content.rows, { revised: { id: 'revised', from: 'worker', to: 'root',
			kind: 'result', status: 'failed', text: '任务中断' } });
		assert.equal(failed.find((row) => row.id === 'subagent:revised')?.kind, 'notice');
	}
});

void test('child transcripts keep the outgoing question and the incoming reply once while hiding private tool results', () => {
	const ask = { name: 'ask_parent', id: 'ask', input: { message: '统计窗口是什么？' } };
	const wait = { name: 'wait_agent', id: 'wait', input: {} };
	const spawn = { name: 'spawn_agent', id: 'spawn', input: {} };
	const conversation = restoreExecution(saved([
		{ role: 'assistant', content: '', toolCalls: [ask] },
		{ role: 'tool', content: '09:00–12:00', toolCallId: ask.id },
		{ role: 'user', local: true, content: '09:00–12:00',
			subagentActivity: { id: 'answer', agentId: 'root', agentName: '主聊天', kind: 'instruction' } },
		{ role: 'assistant', content: '', toolCalls: [spawn, wait] },
		{ role: 'tool', toolCallId: 'spawn', content: '{"id":"audit","name":"复核"}' },
		{ role: 'tool', toolCallId: 'wait', content: '内部等待结果' },
		{ role: 'assistant', content: '我自己的交付原文' },
	]));
	const content = chatTurnContent(conversation);
	const visible = collaborationRows(content.rows, undefined, 'root');
	assert.deepEqual(visible.map((row) => 'content' in row ? row.content : row.kind === 'collaboration' ? row.action : row.kind),
		['统计窗口是什么？', '09:00–12:00', 'started']);
	assert.equal(content.answer, '我自己的交付原文');
});

void test('collaboration messages stay in their receive positions beside tools and the final reply', () => {
	const spawn = { id: 'spawn', name: 'spawn_agent', input: { message: '核对初稿' } };
	const review = { id: 'review', name: 'review_subagent_result', input: { decision: 'revise' } };
	const event = (id: string, kind: NonNullable<Message['subagentActivity']>['kind'], content: string): Message => ({
		id, role: kind === 'instruction' ? 'user' : 'assistant', content, local: true,
		subagentActivity: { id, kind, agentId: 'worker', agentName: '核对助手' },
	});
	const draft = event('first', 'result', '第一份提交原文');
	const messages: Message[] = [
		{ role: 'user', content: '检查材料' },
		{ role: 'assistant', id: 'dispatch', content: '', toolCalls: [spawn, read] },
		{ role: 'tool', toolCallId: spawn.id, content: '已开始' },
		{ role: 'tool', toolCallId: read.id, content: '主聊天自己的核对' },
		draft,
	];
	const first = updateExecution(emptyExecution, { type: 'state', state: state(messages, 'running') });
	const final: Message[] = [...messages,
		{ role: 'assistant', id: 'review-step', content: '', toolCalls: [review] },
		{ role: 'tool', toolCallId: review.id, content: '已退回' },
		event('instruction', 'instruction', '请按原始数据重算'),
		event('second', 'result', '第二份提交原文'),
		{ role: 'assistant', id: 'final-answer', content: '正式答复' },
	];
	const live = updateExecution(first, { type: 'state', state: state(final) });
	for (const execution of [live, restoreExecution(saved(final))]) {
		const content = chatTurnContent(execution);
		assert.equal(content.user, '检查材料');
		assert.equal(content.answer, '正式答复');
		assert.deepEqual(content.rows.map((row) => row.kind === 'tool' ? row.call.name : row.kind === 'subagent' ? row.content : row.kind),
			['spawn_agent', 'Read', '第一份提交原文', 'review_subagent_result', '请按原始数据重算', '第二份提交原文']);
	}
});

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
	const main = { count: 2, input: 300, cacheRead: 500, cacheWrite: 51, output: 75, total: 926,
		hit: 500 / 851, cost: undefined };
	assert.deepEqual(metrics, {
		rounds: 2, count: 2, modelMs: 5000, toolMs: 137, lagMs: 750, speed: 75000 / 3500,
		usage: { ...main, byKind: { main, review: undefined, summary: undefined } },
		context: { prompt: 401, capacity: 1000, remaining: 599, percent: 40.1 },
		contextCompaction: undefined,
	});
	const noUsage: Message = { ...next, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: metadata.usage.cost } };
	assert.equal(conversationMetrics([state([noUsage])]).usage?.count, 1);
	assert.equal(conversationMetrics([state([noUsage])]).usage?.output, undefined);
	assert.equal(runUsage(state([])), undefined);
	const missing = conversationMetrics([first, { ...second, messages: [noUsage] }]);
	assert.equal(missing.usage?.total, undefined);
	assert.equal(missing.usage?.cost, undefined);
	assert.equal(missing.context, undefined);
	assert.equal(missing.speed, 12.5);
	assert.equal(conversationMetrics([first, { ...second, messages: [
		{ ...next, metrics: { ...next.metrics!, decodeMs: 0 } },
	] }]).speed, 12.5);
	assert.equal(conversationMetrics([state([noUsage])]).speed, undefined);
	assert.equal(conversationMetrics([state([{ ...output, metrics: undefined }])]).speed, undefined);
	const precise = conversationMetrics([state([{ role: 'assistant', content: 'Reply',
		reportedUsage: { prompt: 4630 }, metrics: { endedAt: 8000, modelMs: 2500, contextWindow: 1_000_000 },
	}])]);
	assert.equal(precise.context?.percent, 0.47);
});

void test('context details keep the latest compression even without provider usage', () => {
	const older: RunState = { ...state([]), contextCompaction: {
		reason: 'budget', summary: 'saved', droppedHistory: 1, droppedCurrent: 4, shortenedToolResults: 2, throughMessage: 6,
	} };
	const ongoing = updateExecution(emptyExecution, { type: 'state', state: { ...state([], 'running'), taskId: 'latest' } });
	const latest = updateExecution(ongoing, { type: 'context-compaction', compaction: {
		reason: 'overflow', summary: 'failed', droppedHistory: 3, droppedCurrent: 2, shortenedToolResults: 1,
	} });
	assert.ok(latest.state);
	const metrics = conversationMetrics([older, latest.state, { ...state([]), taskId: 'newer' }]);
	assert.equal(metrics.context, undefined);
	assert.equal(latest.items, ongoing.items);
	assert.equal(metrics.contextCompaction?.reason, 'overflow');
	assert.equal(metrics.contextCompaction?.summary, 'failed');
});

void test('subagent usage is counted once without replacing the main chat context', () => {
	const main: RunState = { ...state([{
		role: 'assistant', content: 'Main reply', reportedUsage: { prompt: 200, output: 10 },
		metrics: { endedAt: 1000, modelMs: 500, contextWindow: 1000 },
	}]), taskId: 'main' };
	const child: RunState = { ...state([{
		role: 'assistant', content: 'Child reply', reportedUsage: { prompt: 100, output: 30 },
		metrics: { endedAt: 2000, modelMs: 500, contextWindow: 2000 },
	}]), taskId: 'child' };
	const metrics = conversationMetrics([main], [child, child]);
	assert.equal(metrics.usage?.count, 2);
	assert.equal(metrics.usage?.total, 340);
	assert.deepEqual(metrics.context, { prompt: 200, capacity: 1000, remaining: 800, percent: 20 });
});

void test('a local receipt remains visible without affecting model timing, context or usage', () => {
	const receipt: Message = { role: 'assistant', content: '已收到，正在处理。', local: true };
	const reply: Message = {
		role: 'assistant', content: 'Model reply', reportedUsage: { prompt: 200, output: 10 },
		metrics: { endedAt: 1000, modelMs: 500, contextWindow: 1000 },
		usage: { ...metadata.usage, cost: { ...metadata.usage.cost, total: 0.125, totalFromProvider: true } },
	};
	const withReceipt = state([reply, receipt]);
	assert.deepEqual(runUsage(withReceipt), runUsage(state([reply])));
	assert.deepEqual(conversationMetrics([withReceipt]), conversationMetrics([state([reply])]));
	assert.equal(runUsage(state([receipt])), undefined);
	assert.equal(messageTime({ ...receipt, metrics: reply.metrics }), undefined);
	assert.equal(chatTurnContent(restoreExecution(saved([receipt]))).answer, receipt.content);
	const persisted = (message: unknown) => parseConversationEntry(JSON.stringify({ type: 'messages', taskId: 'task', messages: [message] }), 1);
	const entry = persisted(receipt);
	assert.equal(entry.type === 'messages' && entry.messages[0]?.local, true);
	assert.throws(() => persisted({ ...receipt, role: 'user' }));
	assert.throws(() => persisted({ ...receipt, usage: reply.usage }));
});

void test('usage keeps provider totals and zeros while marking missing fields across request types unknown', () => {
	const turn: RunState = { ...state([{
		role: 'assistant', content: 'Reply',
		reportedUsage: { prompt: 200, output: 10, total: 211, cacheRead: 0, cacheWrite: 0 },
		usage: { ...metadata.usage, cost: { ...metadata.usage.cost, total: 0.125, totalFromProvider: true } },
		metrics: { endedAt: 8000, modelMs: 2500, contextWindow: 1000 },
	}], 'failed'), auxiliaryUsage: [
		{ kind: 'review', reportedUsage: { input: 12, cacheRead: 0, cacheWrite: 3, output: 4 }, cost: 0 },
		{ kind: 'summary', reportedUsage: { prompt: 70, cacheRead: 1, total: 90 } },
	] };
	const usage = runUsage(turn);
	assert.equal(usage?.byKind.main?.count, 1);
	assert.equal(usage.byKind.main.total, 211);
	assert.equal(usage.byKind.review?.total, 19);
	assert.equal(usage.byKind.review.cost, 0);
	assert.equal(usage.byKind.summary?.total, 90);
	assert.equal(usage.byKind.summary.input, undefined);
	assert.equal(usage.count, 3);
	assert.equal(usage.total, 320);
	assert.equal(usage.cacheRead, 1);
	assert.equal(usage.cacheWrite, undefined);
	assert.equal(usage.cost, undefined);
	const metrics = conversationMetrics([turn]);
	assert.deepEqual(metrics.usage, usage);
	assert.equal(metrics.count, 1);
	assert.equal(metrics.context?.prompt, 200);
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

void test('turn navigation previews returned results while keeping the receipt in the turn', () => {
	const receipt: Message = { role: 'assistant', content: '已收到材料。', local: true };
	const report = { content: '## 预算与报销\n\n预算结果。', sentAt: 5_000 };
	const execution = restoreExecution(saved([receipt]));
	assert.equal(chatTurnContent(execution).answer, receipt.content);
	assert.equal(chatTurnContent(execution).copyText, receipt.content);
	assert.deepEqual(chatTurnPreview(execution, '核对资料。', report), { prompt: '核对资料。', reply: '## 预算与报销 预算结果。' });
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

void test('a steering instruction within a continued reply preserves the original chat turn and its full answer', () => {
	const prompt: Message = { role: 'user', content: '查看示例' };
	const first: Message = { role: 'assistant', id: 'assistant:task:1', content: '第一段。', truncated: true };
	const instruction: Message = { role: 'user', id: 'steer:queue-id', content: '再补一句。' };
	const last: Message = { role: 'assistant', id: 'assistant:task:2', content: '第二段。' };
	assert.equal(latestIncompleteReply([prompt, first, instruction]), '第一段。');
	assert.equal(latestIncompleteReply([prompt, first, instruction, { ...last, incomplete: true }]), '第一段。第二段。');
	assert.equal(latestIncompleteReply([prompt, first, instruction, last]), undefined);
	const run = saved([prompt, first, instruction, last]);
	const reopened = restoreExecution(run);
	assert.equal(chatTurnContent(reopened).answer, '第一段。第二段。');
	assert.deepEqual(chatTurnPreview(reopened, run.request.instruction), { prompt: '查看示例', reply: '第一段。第二段。' });
});

void test('reopening a chat shows the explicit skill source for a queued interruption', () => {
	const mentions = [{ name: 'review', id: 'copy', sourceLabel: '本人', start: 0, end: 7 }];
	const turn = saved([
		{ role: 'user', content: '先看笔记' },
		{ role: 'user', id: 'steer:queued', content: '$review 帮我检查\n\n引用上下文', skillInputLength: 12, skillMentions: mentions },
		{ role: 'assistant', content: '检查完毕' },
	]);
	const rows = chatTurnContent(restoreExecution(turn)).rows;
	assert.deepEqual(rows, [{ kind: 'skill-steering', id: 'steer:queued', content: '$review 帮我检查', mentions }]);
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

void test('shows tool records without adding a reply or a completion notice when model text is blank', () => {
	const first = { id: 'first', name: 'Edit', input: { target: 'a.md', options: { from: 'old', to: 'new' } } };
	const second = { id: 'second', name: 'Edit', input: { options: { to: 'new', from: 'old' }, target: 'a.md' } };
	const messages: Message[] = [
		{ role: 'assistant', content: '', toolCalls: [first] },
		{ role: 'tool', content: '失败', toolCallId: first.id, isError: true },
		{ role: 'assistant', content: '', toolCalls: [second] },
		{ role: 'tool', content: '成功', toolCallId: second.id },
		{ role: 'assistant', content: '' },
	];
	for (const status of ['done', 'file-changes-done', 'partial'] as const) {
		const result = restoreExecution(saved(messages, status));
		assert.equal(result.items.some((row) => row.kind === 'tool' && row.call.id === first.id && row.resolved), true, status);
		const { answer, copyText, rows } = chatTurnContent(result);
		assert.equal(answer.trim(), '', status);
		assert.equal(copyText.trim(), '', status);
		assert.ok(rows.length > 0 && rows.every(({ kind }) => kind === 'tool' || kind === 'tool-group'), status);
	}
});
