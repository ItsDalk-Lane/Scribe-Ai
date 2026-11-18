import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type { ModelRequest, ModelStream, NoteSelection, ToolCall } from '../../types';
import { createContextBuilder } from '../context/contextBuilder';
import { createSessionController } from '../sessionController';
import { normalizeSettings } from '../settings/defaults';
import { createConversationStore } from '../storage/conversationStore';

const model = { providerId: 'test-provider', model: 'selection-fixture' };

function reply(content: string, call?: ToolCall): ModelStream {
	const raw: AssistantMessage = {
		role: 'assistant',
		content: call
			? [{ type: 'toolCall', id: call.id, name: call.name, arguments: call.input as Record<string, string> }]
			: [{ type: 'text', text: content }],
		api: 'openai-completions',
		provider: model.providerId,
		model: model.model,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: call ? 'toolUse' : 'stop',
		timestamp: Date.now(),
	};
	return {
		async *[Symbol.asyncIterator]() {
			if (content) yield { type: 'text_delta', delta: content, contentIndex: 0, partial: raw };
		},
		result: () => Promise.resolve({
			raw, content, toolCalls: call ? [call] : [], stopReason: call ? 'tool-calls' : 'end',
		}),
		cancel() {},
	};
}

void test('an attached selection sends the exact snapshot and blocks whole-note tool access', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-selection-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, 'vault');
	const directory = join(root, 'conversations');
	await mkdir(cwd);
	const selection: NoteSelection = {
		path: 'selected.md',
		title: '选区笔记',
		text: '  唐然在九点前完成核查 ⏳  ',
		lines: [1, 1],
	};
	const outside = ['LEFT-OF-SELECTION', 'RIGHT-OF-SELECTION', 'OTHER-FILE-CONTENT'];
	await writeFile(join(cwd, selection.path), outside[0] + selection.text + outside[1]);
	await writeFile(join(cwd, 'unrelated.md'), outside[2]!);
	const app = { vault: {
		adapter: { getBasePath: () => cwd },
		configDir: 'fixture-vault-config',
		getFileByPath: () => null,
	} } as unknown as App;
	let readsAttempted = 0;
	const registry = createToolRegistry([() => readTools().map((tool) => ({
		...tool,
		prepare(input, context) {
			readsAttempted++;
			return tool.prepare(input, context);
		},
	}))]);
	const sent: ModelRequest[] = [];
	const models = createModelCoordinator({ stream(request) {
		sent.push(request);
		if (sent.length === 1) return reply('EARLIER-CHAT-ANSWER');
		if (sent.length === 2) return reply('', {
			id: 'read-whole-note', name: 'Read', input: { file_path: selection.path },
		});
		return reply('已处理选区。');
	} }, createContextBuilder(registry));
	const tools = createToolCoordinator(app, createToolExecutor(registry));
	const sessions = createSessionController(app, normalizeSettings(model), {
		newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools,
	}, createConversationStore(directory));
	const id = await sessions.createConversation();
	const prior = await sessions.submit({ conversationId: id, instruction: 'EARLIER-CHAT-PROMPT', refs: [] }).result;
	assert.equal(prior.status, 'done', prior.error);
	assert.deepEqual(sent[0]?.tools.map(({ name }) => name), ['Read']);

	const instruction = '把选区改成一句交接提醒。';
	const selected = await sessions.submit({
		conversationId: id, instruction, selection, refs: [{ path: 'unrelated.md' }],
	}).result;
	assert.equal(selected.status, 'done', selected.error);
	const requests = sent.slice(1);
	assert.equal(requests.length, 2);
	const firstRequest = requests[0]!;
	assert.deepEqual(firstRequest.messages.map(({ role }) => role), ['user']);
	assert.notEqual(firstRequest.sessionId, id);
	for (const request of requests) {
		assert.deepEqual(request.tools, []);
		assert.equal(request.sessionId, firstRequest.sessionId);
		const content = request.messages.map((message) => message.content).join('\n');
		const payload = JSON.stringify(request);
		assert.ok(content.includes(instruction));
		assert.ok(content.includes(selection.text));
		assert.ok(content.includes(selection.path));
		assert.ok(content.includes(selection.title));
		for (const marker of [...outside, 'unrelated.md', 'EARLIER-CHAT-PROMPT', 'EARLIER-CHAT-ANSWER']) {
			assert.ok(!payload.includes(marker), `发现选区范围外的内容：${marker}`);
		}
	}
	assert.equal(readsAttempted, 0);
	assert.ok(selected.messages.some((message) => message.toolCallId === 'read-whole-note' && message.isError));

	sessions.dispose();
	const saved = await createConversationStore(directory).load(id);
	assert.equal(saved.runs.length, 2);
	assert.equal(saved.runs[0]?.state.messages.at(-1)?.content, 'EARLIER-CHAT-ANSWER');
	assert.deepEqual(saved.runs[1]?.request.selection, selection);
	assert.deepEqual(saved.runs[1]?.request.refs, []);
});
