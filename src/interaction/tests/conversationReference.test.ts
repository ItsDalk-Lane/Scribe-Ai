import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import type { Message, SavedRun } from '../../types';
import { conversationReference, conversationReferenceTitle } from '../conversationReference';

const run = (instruction: string, messages: Message[]): SavedRun => ({
	request: { conversationId: 'chat', instruction, refs: [] }, model: { providerId: 'test', model: 'test' },
	state: { taskId: 'task', status: 'done', turn: 1, pendingCalls: [], messages },
});

void test('历史对话引用包含可见的问答，跳过工具结果、嵌套引文和未完成的文字', () => {
	const quote = conversationReference('学习计划\n第一周', [run('请安排复习。', [
		{ role: 'user', content: '请安排复习。\n\n本次任务的资料引用：["hidden"]' },
		{ role: 'tool', content: '工具返回的材料' },
		{ role: 'assistant', content: '还在打字', incomplete: true },
		{ role: 'assistant', content: '内部消息', local: true },
		{ role: 'user', id: 'steer:one', content: '周五有空。\n\n聊天中选中的引文（仅供参考）\n["嵌套内容"]' },
		{ role: 'assistant', content: '周五安排一小时。\n<!-- scribe-goal-complete: 记录标记 -->' },
	])]);
	assert.equal(quote, '# 历史对话 · 学习计划 第一周\n\n用户：请安排复习。\n\n用户：周五有空。\n\n助手：周五安排一小时。');
	assert.equal(conversationReferenceTitle(quote), '学习计划 第一周');
	assert.equal(conversationReferenceTitle('这是手动引用的文字'), undefined);
	assert.equal(conversationReference('空对话', []), undefined);
});

void test('超长历史保留最新文字并提示省略，不在多字节字符中间切断', () => {
	const quote = conversationReference('学习计划', [run('最早的提问', [
		{ role: 'assistant', content: '答'.repeat(8_000) },
	]), run('最近的提问', [{ role: 'assistant', content: '📚'.repeat(8_000) + '最新答复' }])]);
	assert.ok(quote);
	assert.ok(Buffer.byteLength(quote) <= 8_000);
	assert.match(quote, /仅保留最近的部分对话/u);
	assert.match(quote, /📚最新答复$/u);
	assert.doesNotMatch(quote, /最早的提问|\uFFFD|[\uD800-\uDFFF]/u);
});
