import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, RunStatus } from '../../types';
import { chatTurnContent } from '../chatTurnContent';
import { emptyExecution, restoreExecution, updateExecution } from '../context';

const read = { id: 'reused', name: 'Read', input: { file_path: '示例.md' } };
const grep = { id: 'reused', name: 'Grep', input: { pattern: '示例' } };
const notStarted = { id: 'not-started', name: 'Read', input: {} };

function state(messages: Message[], status: RunStatus = 'done') {
	return { taskId: 'task', turn: 7, messages, pendingCalls: [], status };
}

void test('turn groups prior text and completed tools in order by call batch, not assistant round count', () => {
	const run = {
		request: { conversationId: 'conversation', instruction: '查看示例', refs: [] },
		model: { providerId: 'test', model: 'test' },
		state: state([
			{ role: 'assistant', content: '正在补做。\n\n' },
			{ role: 'assistant', content: '先读取。', toolCalls: [read] },
			{ role: 'tool', content: '文件正文', toolCallId: read.id },
			{ role: 'assistant', content: '', toolCalls: [grep, notStarted] },
			{ role: 'tool', content: '搜索失败', toolCallId: grep.id, isError: true },
			{ role: 'assistant', content: '# 总结\n\n', incomplete: true },
			{ role: 'assistant', content: '- 已保留原文' },
		]),
	};
	const result = chatTurnContent(restoreExecution(run));
	assert.equal(result.user, '查看示例');
	assert.deepEqual(result.process, [
		{ kind: 'text', content: '正在补做。\n\n先读取。' },
		{ kind: 'tool', call: read, result: { callId: read.id, content: '文件正文', isError: false } },
		{ kind: 'tool', call: grep, result: { callId: grep.id, content: '搜索失败', isError: true } },
	]);
	assert.equal(result.answer, '# 总结\n\n- 已保留原文');
	assert.equal(result.showProcessSummary, true);
	assert.equal(result.time, undefined);
});

void test('keeps the current or last interrupted tool visible without exposing unstarted sibling calls', () => {
	const snapshot = state([{ role: 'assistant', content: '', toolCalls: [read, notStarted] }], 'awaiting-approval');
	const execution = updateExecution({ ...emptyExecution, state: snapshot, turn: 7 }, { type: 'tool-start', call: read });
	assert.deepEqual(chatTurnContent(execution).process, [{ kind: 'tool', call: read }]);
	const restored = { ...emptyExecution, state: { ...snapshot, status: 'interrupted' as const } };
	const projection = chatTurnContent(restored, { phase: 'approval', turn: 7, call: read });
	assert.deepEqual(projection.process, [{ kind: 'tool', call: read }]);
	assert.equal(projection.lastCall, read);
});

void test('follows the recorded order when text, thinking, and a tool share a reply', () => {
	const rawAssistant = {
		role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'test',
		stopReason: 'toolUse', timestamp: 1_700_000_000_000,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [
			{ type: 'text', text: '先看原文。' },
			{ type: 'thinking', thinking: '需要读取。' },
			{ type: 'toolCall', id: read.id, name: read.name, arguments: read.input },
			{ type: 'text', text: '接着总结。' },
		],
	} satisfies NonNullable<Message['rawAssistant']>;
	const result = chatTurnContent({ ...emptyExecution, state: state([
		{ role: 'assistant', content: '先看原文。接着总结。', toolCalls: [read], rawAssistant },
		{ role: 'tool', content: '文件正文', toolCallId: read.id },
		{ role: 'assistant', content: '这是最终回复。' },
	]) });
	assert.deepEqual(result.process, [
		{ kind: 'text', content: '先看原文。' },
		{ kind: 'thinking', content: '需要读取。' },
		{ kind: 'tool', call: read, result: { callId: read.id, content: '文件正文', isError: false } },
		{ kind: 'text', content: '接着总结。' },
	]);
	assert.equal(result.answer, '这是最终回复。');
});

void test('keeps stopped activity inline and distinguishes skipped tools from tool failures', () => {
	const messages: Message[] = [
		{ role: 'assistant', content: '先读取。', toolCalls: [read] },
		{ role: 'tool', content: '已跳过', toolCallId: read.id, isError: true, skipped: true },
		{ role: 'assistant', content: '还没完成。' },
	];
	const interrupted = chatTurnContent({ ...emptyExecution, state: state(messages, 'interrupted') });
	assert.equal(interrupted.showProcessSummary, false);
	assert.deepEqual(interrupted.process[1], {
		kind: 'tool', call: read, result: { callId: read.id, content: '已跳过', isError: true }, skipped: true,
	});
	const finishedWithoutReply = chatTurnContent({ ...emptyExecution, state: state(messages.slice(0, -1)) });
	assert.equal(finishedWithoutReply.showProcessSummary, false);
});

void test('reply metadata comes from recorded reply and redacted reasoning is not presented', () => {
	const rawAssistant = {
		role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'test',
		stopReason: 'stop', timestamp: 1_700_000_000_000, durationMs: 1_200,
		usage: { input: 54, output: 18, cacheRead: 0, cacheWrite: 0, totalTokens: 72,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [
			{ type: 'thinking', thinking: '这一段可展示' },
			{ type: 'thinking', thinking: '不可展示', redacted: true, thinkingSignature: 'opaque' },
		],
	} satisfies NonNullable<Message['rawAssistant']>;
	const result = chatTurnContent({ ...emptyExecution, state: state([{ role: 'assistant', content: '回答', rawAssistant }]) });
	assert.deepEqual(result.process, [{ kind: 'thinking', content: '这一段可展示' }]);
	assert.equal(result.tokens, 72);
	assert.equal(result.time?.getTime(), rawAssistant.timestamp + rawAssistant.durationMs);
});
