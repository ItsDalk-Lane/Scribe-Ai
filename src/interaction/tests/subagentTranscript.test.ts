import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, SavedRun, SubagentNote, SubagentView } from '../../types';
import { chatTurnContent } from '../chatTurnContent';
import { questionBody, subagentChatTurns } from '../subagentTranscript';

const prefix = '【向主聊天提问】';
const agent: SubagentView = { id: 'checkin', rootTaskId: 'main-run', name: '签到', role: 'worker',
	model: { providerId: 'test', model: 'test' }, runs: [], status: 'done' };
const question: SubagentNote = { id: 'q1', from: 'checkin', to: 'root', kind: 'question', text: '统计窗口？' };
const answer: SubagentNote = { id: 'a', from: 'root', to: 'checkin', kind: 'answer', text: '09:00–12:00' };
const ask: Message = { role: 'assistant', id: 'ask', content: '已查阅工作单。', toolCalls: [
	{ id: 'q', name: 'ask_parent', input: { message: question.text } },
] };
const run = (taskId: string, instruction: string, messages: Message[]): SavedRun => ({ model: agent.model,
	request: { conversationId: 'chat', instruction, refs: [] }, finalized: true,
	state: { taskId, status: 'done', turn: 2, pendingCalls: [], messages: [{ role: 'user', content: instruction }, ...messages] } });

void test('收到答复即开启新的普通对话回合，保留两稿原文和每次问题的位置', () => {
	const draft = run('draft', '核对签到', [ask,
		{ role: 'tool', toolCallId: 'q', content: answer.text },
		{ role: 'user', local: true, id: 'subagent:a', content: answer.text,
			subagentActivity: { id: 'a', kind: 'instruction', agentId: 'root', agentName: '主聊天' } },
		{ role: 'assistant', content: '第一稿' },
	]);
	const revision = run('revision', '请修订', [{ role: 'assistant', content: '第二稿' }]);
	const { turns, pending } = subagentChatTurns({ ...agent, notes: [question, answer], runs: [draft, revision] }, prefix);
	assert.deepEqual(turns.map(({ request, execution }) => [request.instruction, chatTurnContent(execution).answer]), [
		['核对签到', '已查阅工作单。\n\n【向主聊天提问】统计窗口？'], [answer.text, '第一稿'], ['请修订', '第二稿'],
	]);
	assert.deepEqual(pending, []);
	assert.equal(draft.state.messages[1], ask);
	assert.equal(turns[0]?.execution.state?.messages[1]?.toolCalls?.[0]?.name, 'ask_parent');
});

void test('等待中的问题立即显示一次，尚未读到的答复保留为用户消息', () => {
	const draft = run('draft', '核对签到', [ask]);
	draft.state.status = 'running';
	const { turns, pending } = subagentChatTurns({ ...agent, notes: [question, answer], runs: [draft] }, prefix);
	assert.equal(chatTurnContent(turns[0]!.execution).answer, '已查阅工作单。\n\n【向主聊天提问】统计窗口？');
	assert.deepEqual(pending, [answer]);
	assert.equal(questionBody('已查阅。\n统计窗口？', question.text, prefix), '已查阅。\n\n【向主聊天提问】统计窗口？');
	assert.equal(questionBody(prefix + question.text, prefix + question.text, prefix), prefix + question.text);
});

void test('旧对话里只记录在工具结果中的答复仍在提问和交稿之间', () => {
	const draft = run('draft', '任务', [ask, { role: 'tool', toolCallId: 'q', content: answer.text },
		{ role: 'assistant', content: '根据统计窗口核算完毕。' }]);
	const { turns, pending } = subagentChatTurns({ ...agent, runs: [draft], notes: [question, answer] }, prefix);
	assert.deepEqual(turns.map(({ request, execution }) => [request.instruction, chatTurnContent(execution).answer]), [
		['任务', '已查阅工作单。\n\n【向主聊天提问】统计窗口？'], [answer.text, '根据统计窗口核算完毕。'],
	]);
	assert.deepEqual(pending, []);
});
