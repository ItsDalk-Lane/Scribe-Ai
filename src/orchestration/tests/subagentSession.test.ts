import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import { createAgentLoop } from '../../runtime/agentLoop';
import { bindAgent } from '../../runtime/createAgent';
import { createModelCoordinator } from '../../runtime/modelCoordinator';
import { createRunState } from '../../runtime/runState';
import { createToolCoordinator } from '../../runtime/toolCoordinator';
import { createToolRegistry } from '../../tools';
import { createToolExecutor } from '../../tools/executor';
import { readTools } from '../../tools/readTools';
import { writeTools } from '../../tools/writeTools';
import { subagentTools } from '../../tools/subagentTools';
import type { ModelRequest, ModelStream, SubagentNote, ToolCall } from '../../types';
import { createContextBuilder } from '../context/contextBuilder';
import { createSessionController } from '../sessionController';
import { normalizeSettings } from '../settings/defaults';
import { createConversationStore } from '../storage/conversationStore';

const model = { providerId: 'test-provider', model: 'subagent-fixture' };

function reply(content: string, calls: ToolCall[] = [], gate?: Promise<void>, signal?: AbortSignal): ModelStream {
	const raw: AssistantMessage = {
		role: 'assistant',
		content: [
			...(content ? [{ type: 'text' as const, text: content }] : []),
			...calls.map((call) => ({ type: 'toolCall' as const, id: call.id, name: call.name, arguments: call.input as Record<string, string> })),
		],
		api: 'openai-completions',
		provider: model.providerId,
		model: model.model,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: calls.length ? 'toolUse' : 'stop',
		timestamp: Date.now(),
	};
	return {
		async *[Symbol.asyncIterator]() {
			await gate;
			signal?.throwIfAborted();
			if (content) yield { type: 'text_delta', delta: content, contentIndex: 0, partial: raw };
		},
		result: () => Promise.resolve({ raw, content, toolCalls: calls, stopReason: calls.length ? 'tool-calls' : 'end' }),
		cancel() {},
	};
}

function incoming(request: ModelRequest): SubagentNote[] {
	return (request.system ?? '').split('\n').flatMap((line) => {
		try {
			const note = JSON.parse(line) as Partial<SubagentNote>;
			return note?.kind && note.id ? [note as SubagentNote] : [];
		} catch {
			return [];
		}
	});
}

function acceptPending(request: ModelRequest): ToolCall[] {
	return incoming(request).filter(({ kind, review }) => kind === 'result' && review?.status === 'pending').map(({ id, status }) =>
		({ id: `review-${id}`, name: 'review_subagent_result', input: status === 'done'
			? { result_id: id, decision: 'use' }
			: { result_id: id, decision: 'blocked', reason: '任务中途停止。' } }));
}

void test('a different model service waits for consent and stopping a worker dismisses only its own request', { timeout: 5_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-subagent-route-'));
	const app = { vault: { adapter: { getBasePath: () => root }, configDir: 'fixture-vault-config', getFileByPath: () => null } } as unknown as App;
	const registry = createToolRegistry([subagentTools]);
	const foreign = { providerId: 'another-provider', model: 'alternate' };
	const authorized: string[] = [];
	const origin = (selection: typeof model) => selection.providerId === model.providerId ? 'https://main.test' : 'https://other.test';
	let rootId: string;
	const models = createModelCoordinator({
		stream(request) {
			if (request.sessionId === rootId) {
				const calls = request.messages.at(-1)?.role === 'user' ? ['A', 'B'].map((name) => ({
					id: `spawn-${name}`, name: 'spawn_agent',
					input: { message: `Check ${name}`, nickname: name, model: `${foreign.providerId}/${foreign.model}` },
				})) : acceptPending(request);
				return reply(calls.length ? '' : 'Parent finished', calls, request.beforeSend?.(`${origin(request)}/chat`));
			}
			const send = request.beforeSend?.(`${origin(request)}/chat`).then(() => {
				authorized.push(request.sessionId!);
			});
			assert.ok(send);
			return reply('Worker finished', [], send, request.signal);
		},
	}, createContextBuilder(registry));
	const tools = createToolCoordinator(app, createToolExecutor(registry));
	const runtime = { newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools };
	const settings = normalizeSettings({ ...model, providerModels: { [model.providerId]: [model.model], [foreign.providerId]: [foreign.model] } });
	const sessions = createSessionController(app, settings, runtime, createConversationStore(join(root, 'conversations')),
		undefined, { modelOrigin: origin, send: () => { throw new Error('Unexpected auxiliary request'); } });
	t.after(async () => { sessions.dispose(); await rm(root, { recursive: true, force: true }); });
	rootId = await sessions.createConversation();
	const controls = sessions.subagents!;
	const until = (condition: () => boolean) => new Promise<void>((resolve) => {
		const ready = () => {
			if (condition()) { unsubscribe(); resolve(); }
		};
		const unsubscribe = controls.subscribe(rootId, ready);
		t.after(unsubscribe);
		ready();
	});
	const main = sessions.submit({ conversationId: rootId, instruction: 'Use the alternate model to check A and B.', refs: [] });
	await until(() => controls.snapshot(rootId).requests.length === 2);
	const { requests } = controls.snapshot(rootId);
	assert.equal(authorized.length, 0);
	assert.ok(requests.every((item) => item.kind === 'send' && item.preview.address === 'https://other.test/chat'));
	await controls.stop(rootId, requests[0]!.agentId);
	assert.deepEqual(controls.snapshot(rootId).requests.map(({ id }) => id), [requests[1]!.id]);
	controls.respond(rootId, requests[1]!.id, true);
	await until(() => controls.snapshot(rootId).agents.some(({ status }) => status === 'done'));
	assert.deepEqual(authorized, [requests[1]!.agentId]);
	assert.deepEqual(controls.snapshot(rootId).agents.map(({ status }) => status).sort(), ['cancelled', 'done']);
	const run = await main.result;
	assert.equal(run.status, 'done', run.error);
});

void test('the child limit is shared and separate approvals cannot overwrite each other on the same file', { timeout: 5_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'scribe-subagent-edits-'));
	const cwd = join(directory, 'vault');
	const file = join(directory, 'outside.txt');
	await mkdir(cwd);
	await writeFile(file, 'target\nkeep');
	const app = { vault: {
		adapter: { getBasePath: () => cwd }, configDir: 'fixture-vault-config', getFileByPath: () => null,
	} } as unknown as App;
	const registry = createToolRegistry([readTools, writeTools, subagentTools]);
	const turns = new Map<string, number>();
	let rootId: string;
	const models = createModelCoordinator({ stream(request) {
		const id = request.sessionId!;
		const turn = (turns.get(id) ?? 0) + 1;
		turns.set(id, turn);
		if (id === rootId) {
			return turn === 1 ? reply('', ['one', 'two', 'three'].map((name) => ({
				id: `spawn-${name}`, name: 'spawn_agent', input: { message: name, nickname: name, agent_type: 'worker' },
			}))) : reply('Main completed its review.', acceptPending(request));
		}
		const firstUser = request.messages.find(({ role }) => role === 'user');
		const name = firstUser?.content.split('\n')[0];
		if (turn === 1) return reply('', [{ id: 'read', name: 'Read', input: { file_path: file } }]);
		if (turn === 2) return reply('', [{ id: 'edit', name: 'Edit', input: { file_path: file, old_string: 'target', new_string: name } }]);
		return reply('Reported the file result.');
	} }, createContextBuilder(registry));
	const tools = createToolCoordinator(app, createToolExecutor(registry));
	const runtime = { newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools };
	const sessions = createSessionController(app, normalizeSettings({
		...model, subagents: { mode: 'auto', maxConcurrent: 2, maxDepth: 1, roles: [] },
	}), runtime, createConversationStore(join(directory, 'conversations')));
	t.after(async () => { sessions.dispose(); await rm(directory, { recursive: true, force: true }); });
	rootId = await sessions.createConversation();
	const controls = sessions.subagents!;
	const until = (test: () => boolean) => new Promise<void>((resolve) => {
		const notify = () => {
			if (test()) { unsubscribe(); resolve(); }
		};
		const unsubscribe = controls.subscribe(rootId, notify);
		t.after(unsubscribe);
		notify();
	});
	const main = sessions.submit({ conversationId: rootId, instruction: 'Compare parallel edits.',
		refs: [{ path: file, kind: 'file' }] }, {}, undefined, { executionMode: 'ask' });
	await until(() => controls.snapshot(rootId).requests.length === 2);
	const { requests, agents } = controls.snapshot(rootId);
	assert.ok(requests.every((request) => request.kind === 'approval' && request.approval.before === 'target\nkeep'));
	const first = requests.find(({ agentId }) => agentId === agents[0]?.id)!;
	const second = requests.find(({ agentId }) => agentId !== first.agentId)!;
	controls.respond(rootId, first.id, true);
	await until(() => controls.snapshot(rootId).agents[0]!.runs[0]?.state.messages.some((message) => message.toolCallId === 'edit') === true);
	assert.deepEqual(controls.snapshot(rootId).requests.map(({ id }) => id), [second.id]);
	controls.respond(rootId, second.id, true);
	await until(() => controls.snapshot(rootId).agents[1]!.runs[0]?.state.messages.some((message) => message.toolCallId === 'edit') === true);
	assert.equal(await readFile(file, 'utf8'), 'one\nkeep');
	const blocked = controls.snapshot(rootId).agents[1]!.runs[0]?.state.messages.find((message) => message.toolCallId === 'edit');
	assert.equal(blocked?.isError, true);
	assert.match(blocked?.content ?? '', /已变化.*重新/);
	await until(() => controls.snapshot(rootId).agents.every(({ status }) => status !== 'running' && status !== 'awaiting-approval'));
	const rootRun = await main.result;
	assert.equal(rootRun.status, 'done', JSON.stringify({ error: rootRun.error,
		tools: rootRun.messages.filter(({ role }) => role === 'tool').slice(-8) }));
	assert.match(rootRun.messages.find((message) => message.toolCallId === 'spawn-three')?.content ?? '', /已达上限/);
});

for (const variant of ['accept', 'repeated-error', 'revision-limit'] as const) {
	void test(`the main agent coordinates and reviews parallel work (${variant})`, { timeout: 8_000 }, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), 'scribe-coordinated-work-'));
		const app = { vault: { adapter: { getBasePath: () => directory }, configDir: 'fixture-vault-config', getFileByPath: () => null } } as unknown as App;
		const store = createConversationStore(join(directory, 'conversations'));
		let finishIndependent = () => {};
		let startWaiting = () => {};
		let startChild = () => {};
		const independentDone = new Promise<void>((resolve) => { finishIndependent = resolve; });
		const waited = new Promise<void>((resolve) => { startWaiting = resolve; });
		const childStarted = new Promise<void>((resolve) => { startChild = resolve; });
		const actions: string[] = [];
		const registry = createToolRegistry([subagentTools, () => [{
			name: 'fixture_budget',
			description: '核算本地预算',
			inputSchema: { type: 'object' },
			isReadOnly: true,
			prepare: () => ({ async run() {
				await childStarted;
				actions.push('budget');
				finishIndependent();
				return '核对完成，预算 5050 元。';
			} }),
		}]]);
		const tool = (id: string, name: string, input = {}) => reply('', [{ id, name, input }]);
		let conversationId: string;
		let resultToRead: string | undefined;
		let nextRevision = false;
		const revision = '把台账的 170 分钟校正为 165 分钟，保留来源。';
		const draft = '初稿：台账登记 170 分钟。';
		const corrected = '修订稿：分段相加为 165 分钟，原台账登记 170 分钟。';
		const service = createModelCoordinator({ stream(request) {
			const { messages } = request;
			const last = messages.at(-1);
			const notes = incoming(request);
			if (request.sessionId !== conversationId) {
				assert.ok(request.system?.includes('用原始刷卡记录核算出勤。'));
				const revisionRequest = messages.filter(({ role, content }) => role === 'user' && content.startsWith(revision)).at(-1);
				if (revisionRequest) return reply(variant === 'accept' ? corrected
					: `仍有错误的修订稿 ${revisionRequest.content.at(-1)}。`, [], waited, request.signal);
				if (messages.some(({ toolCallId }) => toolCallId === 'question')) {
					assert.ok(messages.some(({ content }) => content.includes('09:00–12:00'))
						|| notes.some(({ text }) => text.includes('09:00–12:00')));
					actions.push('draft');
					return reply(draft);
				}
				startChild();
				return reply('', [{ id: 'question', name: 'ask_parent', input: { message: '统计窗口是哪段时间？' } }], independentDone, request.signal);
			}
			if (last?.role === 'user' && last.content === 'What is 2 plus 2?') return reply('4');
			if (last?.role === 'user') {
				assert.ok(request.tools.some(({ name }) => name === 'spawn_agent'));
				return tool('spawn', 'spawn_agent', {
					nickname: '出勤审核', system_instructions: '用原始刷卡记录核算出勤。', message: '核对出勤。仅有原台账 170 分钟。',
				});
			}
			if (last?.toolCallId === 'spawn') return tool('budget', 'fixture_budget');
			const question = notes.find(({ kind }) => kind === 'question');
			if (question) {
				actions.push('answer');
				return tool('answer', 'answer_subagent', { question_id: question.id, message: '正确窗口为 09:00–12:00。' });
			}
			const result = notes.find(({ kind, review }) => kind === 'result' && review?.status === 'pending');
			if (result) {
				if (result.text === corrected) {
					assert.ok(result.path);
					resultToRead = result.path;
					return tool('defer', 'review_subagent_result', { result_id: result.id, decision: 'defer' });
				}
				const previousReviews = messages.filter(({ toolName }) => toolName === 'review_subagent_result').length;
				const correctAgain = previousReviews + 1;
				nextRevision = true;
				return tool(`revise-${correctAgain}`, 'review_subagent_result', {
					result_id: result.id, decision: 'revise', reason: '未按实际时段重算。',
					error_key: variant === 'revision-limit' ? `issue-${correctAgain}` : 'attendance-total',
					message: revision + '修订序号 ' + correctAgain,
				});
			}
			if (last?.toolName === 'review_subagent_result' && last.content.includes('已停止')) {
				return reply('正式答复：预算 5050 元，签到未通过。请确认哪份台账是有效来源？');
			}
			if (last?.toolCallId === 'defer') {
				assert.ok(!notes.some(({ text }) => text.includes(corrected)));
				return tool('read', 'read_subagent_result', { path: resultToRead });
			}
			if (last?.toolCallId === 'read') {
				assert.match(last.content, /165 分钟/);
				return reply('正式答复：预算 5050 元，核对后的出勤为 165 分钟。');
			}
			const waits = messages.filter(({ toolName }) => toolName === 'wait_agent').length;
			return tool(`wait-${waits}`, 'wait_agent');
		} }, createContextBuilder(registry));
		const tools = createToolCoordinator(app, createToolExecutor(registry));
		const runtime = { newState: createRunState, createAgent: bindAgent(createAgentLoop(service, tools)), models: service, tools };
		const settings = normalizeSettings(model);
		const connect = () => createSessionController(app, settings, runtime, store);
		const sessions = connect();
		t.after(async () => {
			startChild(); finishIndependent(); startWaiting();
			sessions.dispose();
			await rm(directory, { recursive: true, force: true });
		});
		conversationId = await sessions.createConversation();
		const simple = await sessions.submit({ conversationId, instruction: 'What is 2 plus 2?', refs: [] }).result;
		assert.equal(simple.status, 'done', simple.error);
		assert.equal(sessions.subagents?.snapshot(conversationId).agents.length, 0);

		const main = sessions.submit({ conversationId, instruction: '先核预算，同时核对出勤，再提供汇总。', refs: [] }, {
			onEvent(event) {
				if (event.type === 'tool-start' && event.call.name === 'wait_agent'
					&& nextRevision) startWaiting();
			},
		});
		const state = await main.result;
		assert.equal(state.status, 'done', state.error);
		assert.deepEqual(actions, ['budget', 'answer', 'draft']);
		assert.match(state.messages.at(-1)?.content ?? '', /正式答复/);
		const markers = state.messages.filter(({ subagentActivity }) => subagentActivity?.kind === 'result');
		assert.equal(markers.length, variant === 'revision-limit' ? 3 : 2);
		const [first, second] = markers;
		assert.ok(first?.subagentActivity && second?.subagentActivity);
		assert.equal(first.subagentActivity.agentId, second.subagentActivity.agentId);
		const between = state.messages.slice(state.messages.indexOf(first), state.messages.indexOf(second));
		assert.ok(between.some(({ toolCallId }) => toolCallId === 'revise-1'));
		assert.ok(between.some(({ toolName }) => toolName === 'wait_agent'));
		const saved = await store.load(conversationId);
		assert.deepEqual(saved.runs.at(-1)?.state.messages.filter(({ subagentActivity }) => subagentActivity?.kind === 'result'), markers);
		const reopened = connect();
		t.after(() => reopened.dispose());
		await reopened.subagents!.load(conversationId);
		const submissions = reopened.subagents!.snapshot(conversationId).submissions;
		assert.equal(submissions?.[first.subagentActivity.id]?.text, draft);
		assert.deepEqual(submissions?.[first.subagentActivity.id]?.review, { status: 'returned', reason: '未按实际时段重算。' });
		const finalSubmission = submissions?.[markers.at(-1)!.subagentActivity!.id];
		if (variant === 'accept') {
			assert.equal(finalSubmission?.review?.status, 'passed');
			assert.equal(finalSubmission?.text, corrected);
		} else {
			assert.equal(finalSubmission?.review?.status, 'blocked');
			assert.match(finalSubmission.review.reason ?? '', variant === 'repeated-error' ? /同一个关键错误/u : /返工两次/u);
			assert.match(state.messages.at(-1)?.content ?? '', /签到未通过/u);
		}
		assert.equal(saved.runs.at(-1)?.subagentReport, undefined);
	});
}
