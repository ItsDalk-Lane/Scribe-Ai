import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import type { ModelRequest, ModelStream, NoteSelection, Task } from '../../types';
import { createContextBuilder } from '../context/contextBuilder';
import { createSessionController } from '../sessionController';
import { normalizeSettings } from '../settings/defaults';
import { createConversationStore } from '../storage/conversationStore';

const model = { providerId: 'test-provider', model: 'selection-fixture' };

void test('spill cleanup days default to 30, accept 0 and reject invalid values', () => {
	assert.equal(normalizeSettings({}).spillCleanupDays, 30);
	assert.equal(normalizeSettings({ spillCleanupDays: 0 }).spillCleanupDays, 0);
	assert.equal(normalizeSettings({ spillCleanupDays: 90 }).spillCleanupDays, 90);
	assert.equal(normalizeSettings({ spillCleanupDays: -1 }).spillCleanupDays, 30);
	assert.equal(normalizeSettings({ spillCleanupDays: 1.5 }).spillCleanupDays, 30);
});

void test('removal confirmation defaults to on and accepts an explicit off', () => {
	assert.equal(normalizeSettings({}).confirmChatRemoval, true);
	assert.equal(normalizeSettings({ confirmChatRemoval: false }).confirmChatRemoval, false);
	assert.equal(normalizeSettings({ confirmChatRemoval: 'no' as unknown as boolean }).confirmChatRemoval, true);
});

void test('log retention defaults to 30 days, accepts 0 for permanent and rejects invalid values', () => {
	assert.equal(normalizeSettings({}).logRetentionDays, 30);
	assert.equal(normalizeSettings({ logRetentionDays: 0 }).logRetentionDays, 0);
	assert.equal(normalizeSettings({ logRetentionDays: 90 }).logRetentionDays, 90);
	assert.equal(normalizeSettings({ logRetentionDays: -5 }).logRetentionDays, 30);
	assert.equal(normalizeSettings({ logRetentionDays: 1.5 }).logRetentionDays, 30);
});

function reply(content: string): ModelStream {
	const raw: AssistantMessage = {
		role: 'assistant',
		content: [{ type: 'text', text: content }],
		api: 'openai-completions',
		provider: model.providerId,
		model: model.model,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'stop',
		timestamp: Date.now(),
	};
	return {
		async *[Symbol.asyncIterator]() {
			if (content) yield { type: 'text_delta', delta: content, contentIndex: 0, partial: raw };
		},
		result: () => Promise.resolve({ raw, content, toolCalls: [], stopReason: 'end' }),
		cancel() {},
	};
}

void test('retired selection questions remain visible in saved history and cannot be sent again', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-selection-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, 'vault');
	await mkdir(cwd);
	const app = { vault: {
		adapter: { getBasePath: () => cwd },
		configDir: 'fixture-vault-config',
		getFileByPath: () => null,
	} } as unknown as App;
	const registry = createToolRegistry([readTools]);
	const sent: ModelRequest[] = [];
	const models = createModelCoordinator({ stream(request) {
		sent.push(request);
		return reply('普通聊天回复。');
	} }, createContextBuilder(registry));
	const tools = createToolCoordinator(app, createToolExecutor(registry));
	const store = createConversationStore(join(root, 'conversations'));
	const sessions = createSessionController(app, normalizeSettings(model), {
		newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools,
	}, store);
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const prior = await sessions.submit({ conversationId: id, instruction: 'EARLIER-CHAT-PROMPT', refs: [] }).result;
	assert.equal(prior.status, 'done', prior.error);

	const selection: NoteSelection = {
		path: 'legacy-selected.md',
		title: '旧选区笔记',
		text: '  旧选区正文 LEGACY-SELECTION-SNAPSHOT ⏳  ',
		lines: [1, 1],
	};
	const legacyTask: Task = {
		id: 'legacy-selection-task',
		request: { conversationId: id, instruction: 'LEGACY-SELECTION-QUESTION', refs: [], selection },
		status: 'running',
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	const queued = { id: 'legacy-selection-queued', request: legacyTask.request };
	await store.append(id, [
		{ type: 'start', task: legacyTask, model },
		{ type: 'messages', taskId: legacyTask.id, messages: [
			{ role: 'user', content: selection.text },
			{ role: 'assistant', content: 'LEGACY-SELECTION-ANSWER' },
		] },
		{ type: 'queue-add', message: queued },
	]);

	const saved = await sessions.openConversation(id);
	assert.deepEqual(saved?.runs[1]?.request.selection, selection);
	assert.equal(saved?.runs[1]?.state.messages[0]?.content, selection.text);
	assert.deepEqual(saved?.queue, [queued]);

	assert.throws(() => sessions.submit(legacyTask.request), /选区问答已停用/u);
	assert.throws(() => sessions.submitQueued(queued, {}, () => assert.fail('旧选区不能从队列发送')), /选区问答已停用/u);
	await assert.rejects(sessions.resume(id, legacyTask.id).result, /无法从此处继续任务/u);
	assert.equal(sent.length, 1);

	const followed = sessions.submit({
		conversationId: id, instruction: '现在用普通提问。', refs: [{ path: 'normal-note.md' }], chatQuotes: ['这是附上的聊天引文。'],
	});
	await assert.rejects(sessions.steer(followed.taskId, queued), /选区问答已停用/u);
	assert.equal((await followed.result).status, 'done');
	assert.equal(sent.length, 2);
	const [normal] = sent.slice(1);
	assert.equal(normal?.sessionId, id);
	assert.deepEqual(normal?.tools.map(({ name }) => name), ['Read']);
	const payload = JSON.stringify(normal);
	assert.match(payload, /EARLIER-CHAT-PROMPT/u);
	assert.match(payload, /normal-note\.md/u);
	assert.match(payload, /这是附上的聊天引文/u);
	assert.doesNotMatch(payload, /LEGACY-SELECTION|legacy-selected\.md|旧选区笔记/u);
	assert.deepEqual(await store.getQueued(id), [queued]);
});
