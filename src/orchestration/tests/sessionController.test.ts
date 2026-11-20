import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import { restoreExecution } from '../../interaction/context';
import { createAgentLoop } from '../../runtime/agentLoop';
import { bindAgent } from '../../runtime/createAgent';
import { createModelCoordinator } from '../../runtime/modelCoordinator';
import { createRunState } from '../../runtime/runState';
import { createToolCoordinator } from '../../runtime/toolCoordinator';
import { createToolRegistry } from '../../tools';
import { createToolExecutor } from '../../tools/executor';
import { readTools } from '../../tools/readTools';
import { searchTools } from '../../tools/searchTools';
import { writeTools } from '../../tools/writeTools';
import { MissingConversationError } from '../../types';
import type { ModelRequest, ModelService, ModelStream, RunState, RuntimeLayer, ScribeSettings, Task, ToolCall } from '../../types';
import { createContextBuilder } from '../context/contextBuilder';
import { createSessionController } from '../sessionController';
import { normalizeSettings } from '../settings/defaults';
import { chatModelKey } from '../settings/thinking';
import { createConversationStore } from '../storage/conversationStore';

const firstModel = { providerId: 'test-provider', model: 'first-model' };
const secondModel = { providerId: 'another-provider', model: 'second-model' };
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function reply(content: string, toolCalls: ToolCall[] = []): ModelStream {
	const raw: AssistantMessage = {
		role: 'assistant',
		content: [
			...(content ? [{ type: 'text' as const, text: content }] : []),
			...toolCalls.map((call) => ({
				type: 'toolCall' as const, id: call.id, name: call.name, arguments: call.input as Record<string, string>,
			})),
		],
		api: 'openai-completions',
		provider: firstModel.providerId,
		model: firstModel.model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost },
		stopReason: toolCalls.length ? 'toolUse' : 'stop',
		timestamp: Date.now(),
	};
	return {
		async *[Symbol.asyncIterator]() {
			if (content) yield { type: 'text_delta', delta: content, contentIndex: 0, partial: raw };
		},
		result: () => Promise.resolve({ raw, content, toolCalls, stopReason: toolCalls.length ? 'tool-calls' : 'end' }),
		cancel() {},
	};
}

const shownPartial = '关于临时笔记，第一点是鸢尾花。\n';

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), 'scribe-session-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, 'vault');
	const directory = join(root, 'conversations');
	await mkdir(cwd);
	const app = { vault: {
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
	return {
		cwd,
		directory,
		connect: (stream: (request: ModelRequest) => ModelStream, model: Partial<ScribeSettings> = firstModel,
			thinkingOptions?: ModelService['thinkingOptions']) => {
			const registry = createToolRegistry([readTools, searchTools, writeTools]);
			const models = createModelCoordinator({ stream }, createContextBuilder(registry));
			const tools = createToolCoordinator(app, createToolExecutor(registry));
			const runtime: RuntimeLayer = {
				newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools,
			};
			return createSessionController(app, normalizeSettings(model), runtime, createConversationStore(directory), thinkingOptions);
		},
	};
}

void test('after reopening, the same conversation sends prior messages and tool results to the current model', async (t) => {
	const { cwd, connect } = await fixture(t);
	const fact = '银杏灯塔-733';
	await writeFile(join(cwd, 'fact.md'), fact);
	const read = { id: 'note-read', name: 'Read', input: { file_path: 'fact.md' } };
	let requests = 0;
	const before = connect(() => ++requests === 1 ? reply('', [read]) : reply(`第一轮结论是${fact}。`));
	const id = await before.createConversation();
	const start = await before.submit({ conversationId: id, instruction: '读取笔记并记住其中的地点。', refs: [{ path: 'fact.md' }],
		chatQuotes: ['来自主聊天的引文'] }).result;
	assert.equal(start.status, 'done', start.error);
	assert.equal(requests, 2);
	before.dispose();

	const sent: ModelRequest[] = [];
	const reopened = connect((request) => { sent.push(request); return reply('已接续。'); }, secondModel);
	const saved = await reopened.openConversation();
	assert.equal(saved?.id, id);
	assert.equal(saved.runs[0]?.state.status, 'done');
	assert.deepEqual(saved.runs[0]?.request.refs, [{ path: 'fact.md' }]);
	assert.deepEqual(saved.runs[0]?.request.chatQuotes, ['来自主聊天的引文']);
	assert.equal(saved.runs[0]?.state.messages[1]?.rawAssistant?.model, firstModel.model);
	assert.ok((await reopened.listConversations()).some((entry) => entry.id === id));

	const continued = await reopened.submit({ conversationId: id, instruction: '把刚才的地点写成一句话。', refs: [] }).result;
	assert.equal(continued.status, 'done', continued.error);
	const request = sent[0];
	assert.equal(request?.model, secondModel.model);
	assert.equal(request.providerId, secondModel.providerId);
	assert.equal(request.sessionId, id);
	assert.deepEqual(request.messages.map(({ role }) => role), ['user', 'assistant', 'tool', 'assistant', 'user']);
	assert.match(request.messages[0]?.content ?? '', /读取笔记/);
	assert.match(request.messages[0]?.content ?? '', /来自主聊天的引文/);
	assert.equal(request.messages[1]?.toolCalls?.[0]?.id, read.id);
	assert.equal(request.messages[2]?.toolCallId, read.id);
	assert.match(request.messages[2]?.content ?? '', /银杏灯塔-733/);
	assert.match(request.messages[3]?.content ?? '', /第一轮结论/);
	assert.equal(request.messages[4]?.content, '把刚才的地点写成一句话。');
	const resumedHistory = await reopened.openConversation(id);
	assert.equal(resumedHistory?.runs.length, 2);
	assert.equal(resumedHistory.runs[1]?.state.messages.at(-1)?.content, '已接续。');

	const newId = await reopened.createConversation();
	assert.notEqual(newId, id);
	assert.equal((await reopened.submit({ conversationId: newId, instruction: '这是一次全新的对话。', refs: [] }).result).status, 'done');
	assert.deepEqual(sent[1]?.messages.map(({ content }) => content), ['这是一次全新的对话。']);
	reopened.dispose();
});

void test('a side chat reads notes while the main chat runs, then closes without saving or writing', { timeout: 5_000 }, async (t) => {
	const { cwd, connect, directory } = await fixture(t);
	const note = join(cwd, 'fact.md');
	await writeFile(note, '临时笔记事实-733');
	const requests: ModelRequest[] = [];
	const read = { id: 'side-read', name: 'Read', input: { file_path: 'fact.md' } };
	const write = { id: 'side-write', name: 'Write', input: { file_path: 'forbidden.md', content: '不可写入' } };
	let mainStarted = () => {};
	let finishMain = () => {};
	const mainReady = new Promise<void>((resolve) => { mainStarted = resolve; });
	const mainWaiting = new Promise<void>((resolve) => { finishMain = resolve; });
	const sessions = connect((request) => {
		requests.push(request);
		const prompt = request.messages.filter(({ role }) => role === 'user').at(-1)?.content ?? '';
		if (prompt.includes('主聊天继续')) {
			mainStarted();
			const answer = reply('主聊天完成。');
			return { ...answer, async *[Symbol.asyncIterator]() { await mainWaiting; yield* answer; } };
		}
		if (prompt.includes('侧聊读取')) {
			return request.messages.some(({ toolCallId }) => toolCallId === read.id) ? reply('侧聊读完。') : reply('', [read]);
		}
		if (prompt.includes('侧聊追问') && !request.messages.some(({ toolCallId }) => toolCallId === write.id)) {
			return reply('', [write]);
		}
		return reply('收到。');
	}, { ...firstModel, providerModels: { [secondModel.providerId]: [secondModel.model] } });
	t.after(() => { finishMain(); sessions.dispose(); });
	const id = await sessions.createConversation();
	const refs = [{ path: 'fact.md' }];
	await sessions.submit({ conversationId: id, instruction: '主聊天起点', refs }).result;
	const parent = await sessions.openConversation();
	assert.ok(parent);
	const mainRequest = { conversationId: id, instruction: '主聊天继续', refs: [] };
	let live: RunState | undefined;
	const main = sessions.submit(mainRequest, { onEvent: (event) => { if (event.type === 'state') live = event.state; } });
	await mainReady;
	assert.ok(live);
	const side = sessions.createSideChat([...parent.runs, { request: mainRequest, model: firstModel, state: live }]);
	const readState = await side.submit({ instruction: '侧聊读取', model: secondModel, refs,
		chatQuotes: ['这里是所选文字'] }).result;
	assert.equal(readState.status, 'done', readState.error);
	assert.match(readState.messages.find(({ toolCallId }) => toolCallId === read.id)?.content ?? '', /临时笔记事实-733/);
	const sideRequests = requests.filter(({ sessionId }) => sessionId === side.id);
	assert.deepEqual(sideRequests[0]?.tools.map(({ name }) => name).sort(), ['Glob', 'Grep', 'Read']);
	assert.equal(sideRequests[0]?.model, secondModel.model);
	assert.match(sideRequests[0]?.messages.at(-1)?.content ?? '', /本次任务的资料引用.*fact\.md/);
	const context = sideRequests[0]?.messages.map(({ content }) => content).join('\n') ?? '';
	assert.match(sideRequests[0]?.messages.find(({ content }) => content.startsWith('主聊天起点'))?.content ?? '', /fact\.md/);
	assert.match(context, /这里是所选文字/);
	assert.match(context, /打开侧聊时，主任务仍在进行/);

	let approvals = 0;
	const follow = await side.submit({ instruction: '侧聊追问' }, { approve: async () => { approvals++; return true; } }).result;
	assert.ok(follow.messages.some(({ toolCallId, isError }) => toolCallId === write.id && isError));
	assert.equal(approvals, 0);
	await assert.rejects(access(join(cwd, 'forbidden.md')), { code: 'ENOENT' });
	assert.equal(await readFile(note, 'utf8'), '临时笔记事实-733');
	const followRequest = requests.filter(({ sessionId }) => sessionId === side.id)[2];
	assert.equal(followRequest?.model, firstModel.model);
	assert.match(followRequest?.messages.map(({ content }) => content).join('\n') ?? '', /侧聊读完/);

	const stopped = await side.submit({ instruction: '关闭侧聊' }, { onEvent: (event) => { if (event.type === 'text-delta') side.close(); } }).result;
	assert.equal(stopped.status, 'cancelled');
	assert.throws(() => side.submit({ instruction: '已关闭的侧聊不能发送' }));
	finishMain();
	assert.equal((await main.result).status, 'done');
	const saved = await sessions.openConversation();
	assert.equal(saved?.id, id);
	assert.deepEqual(saved?.runs.map(({ request }) => request.instruction), ['主聊天起点', '主聊天继续']);
	assert.deepEqual((await sessions.listConversations()).map(({ id }) => id), [id]);
	await assert.rejects(access(join(directory, `${side.id}.jsonl`)), { code: 'ENOENT' });
});

void test('a side chat can read only the external file attached to its current question', async (t) => {
	const { cwd, connect } = await fixture(t);
	const allowed = join(cwd, '..', 'allowed.md');
	const sibling = join(cwd, '..', 'sibling.md');
	await Promise.all([writeFile(allowed, '所选库外文件'), writeFile(sibling, '不应读取的文件')]);
	const calls = [allowed, sibling].map((path, index) => ({ id: `external-${index}`, name: 'Read', input: { file_path: path } }));
	const side = connect((request) => request.messages.at(-1)?.role === 'tool' ? reply('已检查。') : reply('', calls)).createSideChat([]);

	const first = await side.submit({ instruction: '读取这次的资料', refs: [{ path: allowed, kind: 'file', addedExternal: true }] }).result;
	assert.match(first.messages.find(({ toolCallId }) => toolCallId === calls[0]?.id)?.content ?? '', /所选库外文件/);
	assert.ok(first.messages.some(({ toolCallId, isError }) => toolCallId === calls[1]?.id && isError));

	const follow = await side.submit({ instruction: '再次读取同一份资料' }).result;
	assert.ok(follow.messages.filter(({ toolCallId }) => toolCallId).every(({ isError }) => isError));
	assert.equal(follow.messages.filter(({ toolCallId }) => toolCallId).length, 2);
	side.close();
});

void test('a queued turn leaves the saved queue only once the next transcript starts', async (t) => {
	const { connect, directory } = await fixture(t);
	const sessions = connect(() => reply('已回答。'));
	const store = createConversationStore(directory);
	const conversationId = await sessions.createConversation();
	const first = { id: 'queued-first', request: { conversationId, instruction: '排在最前面\n第二行', refs: [] } };
	const second = { id: 'queued-second', request: { conversationId, instruction: '稍后执行', refs: [] } };
	await store.enqueue(conversationId, first);
	await store.enqueue(conversationId, first);
	await store.enqueue(conversationId, second);
	await assert.rejects(sessions.submitQueued(second, {}, () => assert.fail('后入队的消息先执行')).result);
	assert.deepEqual(await store.getQueued(conversationId), [first, second]);

	let whenStarted: ReturnType<typeof store.load> | undefined;
	const run = sessions.submitQueued(first, {}, () => { whenStarted = store.load(conversationId); });
	assert.equal((await run.result).status, 'done');
	const saved = await whenStarted;
	assert.deepEqual(saved?.queue, [second]);
	assert.equal(saved?.runs[0]?.request.instruction, first.request.instruction);
	sessions.dispose();
});

void test('main chats run and save independently while only the foreground chat is remembered', { timeout: 5_000 }, async (t) => {
	const { connect, directory } = await fixture(t);
	const requests: ModelRequest[] = [];
	const releases = new Map<string, () => void>();
	let started = () => {};
	const bothRunning = new Promise<void>((resolve) => { started = resolve; });
	const sessions = connect((request) => {
		requests.push(request);
		const conversationId = request.sessionId;
		assert.ok(conversationId);
		const response = reply('已回答。');
		return { ...response, async *[Symbol.asyncIterator]() {
			await new Promise<void>((release) => {
				releases.set(conversationId, release);
				if (releases.size === 2) started();
			});
			yield* response;
		} };
	}, { ...firstModel, providerModels: { [firstModel.providerId]: [firstModel.model], [secondModel.providerId]: [secondModel.model] } },
	(_model, preferred) => ({ levels: ['low', 'high'], level: preferred ?? 'low' }));
	t.after(() => {
		sessions.dispose();
		for (const release of releases.values()) release();
	});
	const store = createConversationStore(directory);
	const backgroundId = await sessions.createConversation();
	const foregroundId = await sessions.createConversation();
	const foregroundRequest = { conversationId: foregroundId, instruction: '前台任务', refs: [] };
	const backgroundMessage = { id: 'background-queued', request: { conversationId: backgroundId, instruction: '后台排队任务', refs: [] } };
	await store.enqueue(backgroundId, backgroundMessage);
	const foregroundChoice = { ...firstModel, reasoning: 'high' };
	const backgroundChoice = { ...secondModel, reasoning: null };
	const foreground = sessions.submit(foregroundRequest, {}, undefined, { model: foregroundChoice });
	const background = sessions.submitQueued(backgroundMessage, {}, () => {}, { model: backgroundChoice, rememberConversation: false });
	await bothRunning;
	assert.equal(await store.lastOpened(), foregroundId);
	assert.throws(() => sessions.submit({ ...foregroundRequest, conversationId: foregroundId.toUpperCase() }), /正在运行/);
	assert.throws(() => sessions.submit({ ...foregroundRequest, conversationId: 'unconfigured-model-chat' }, {}, undefined,
		{ model: { ...firstModel, model: 'unconfigured' } }), /模型已不可用/);
	assert.ok(sessions.canSteer(foregroundId.toUpperCase(), foreground.taskId));
	assert.ok(sessions.canSteer(backgroundId, background.taskId));
	await assert.rejects(sessions.steer(foreground.taskId, backgroundMessage), /无法接受/);
	await assert.rejects(sessions.deleteConversation(backgroundId.toUpperCase()), /先停止/);
	await assert.rejects(sessions.forkConversation(backgroundId, background.taskId), /正在运行/);
	const frontRequest = requests.find(({ sessionId }) => sessionId === foregroundId);
	const backRequest = requests.find(({ sessionId }) => sessionId === backgroundId);
	assert.deepEqual([frontRequest?.providerId, frontRequest?.model, frontRequest?.reasoning],
		[foregroundChoice.providerId, foregroundChoice.model, foregroundChoice.reasoning]);
	assert.deepEqual([backRequest?.providerId, backRequest?.model, backRequest?.reasoning],
		[backgroundChoice.providerId, backgroundChoice.model, backgroundChoice.reasoning]);
	await sessions.cancel(foreground.taskId);
	assert.equal(frontRequest?.signal?.aborted, true);
	assert.equal(backRequest?.signal?.aborted, false);
	releases.get(foregroundId)?.();
	assert.equal((await foreground.result).status, 'cancelled');
	const branch = await sessions.forkConversation(foregroundId, foreground.taskId, false);
	assert.equal(await store.lastOpened(), foregroundId);
	await sessions.deleteConversation(branch.id);
	releases.get(backgroundId)?.();
	assert.equal((await background.result).status, 'done');
	assert.equal((await store.load(foregroundId)).runs[0]?.state.status, 'cancelled');
	const saved = await store.load(backgroundId);
	assert.deepEqual(saved.runs.map(({ request, model, state }) => [request.instruction, model, state.status]),
		[[backgroundMessage.request.instruction, backgroundChoice, 'done']]);
	assert.equal(saved.queue?.length ?? 0, 0);
	assert.equal(await store.lastOpened(), foregroundId);
});

void test('branching copies through the selected reply and editing replaces only the original tail', async (t) => {
	const { connect } = await fixture(t);
	const sent: ModelRequest[] = [];
	const sessions = connect((request) => {
		sent.push(request);
		return reply(`回答 ${sent.length}`);
	});
	const conversationId = await sessions.createConversation();
	const submit = (instruction: string, replaceFrom?: string) => sessions.submit({ conversationId, instruction, refs: [] }, {}, replaceFrom);
	const first = await submit('保留这轮').result;
	const edited = await submit('旧指令').result;
	const later = await submit('更晚的指令').result;
	await assert.rejects(submit('不能改写', 'missing').result, /找不到/);
	assert.deepEqual((await sessions.openConversation(conversationId))?.runs.map(({ state }) => state.taskId),
		[first.taskId, edited.taskId, later.taskId]);
	const branch = await sessions.forkConversation(conversationId, edited.taskId);
	assert.notEqual(branch.id, conversationId);
	assert.equal((await sessions.openConversation())?.id, branch.id);
	assert.deepEqual(branch.runs.map(({ request, state }) => [request.conversationId, state.taskId, state.messages.at(-1)?.content]),
		[[branch.id, first.taskId, '回答 1'], [branch.id, edited.taskId, '回答 2']]);
	assert.equal(sent.length, 3);

	const run = submit('修改后的指令', edited.taskId);
	await assert.rejects(sessions.forkConversation(conversationId, first.taskId), /正在运行/);
	assert.equal((await run.result).status, 'done');
	assert.deepEqual(sent[3]?.messages.map(({ content }) => content), ['保留这轮', '回答 1', '修改后的指令']);
	assert.deepEqual((await sessions.openConversation(conversationId))?.runs.map(({ state }) => state.taskId), [first.taskId, run.taskId]);
	assert.deepEqual(await sessions.openConversation(branch.id), branch);
});

void test('deleting a saved conversation rejects an active run and prevents stale submissions', async (t) => {
	const { connect } = await fixture(t);
	let requests = 0;
	const sessions = connect(() => { requests++; return reply('保留到删除。'); });
	const id = await sessions.createConversation();
	const request = { conversationId: id, instruction: '原始指令', refs: [] };
	const running = sessions.submit(request);
	await assert.rejects(sessions.deleteConversation(id), /先停止/);
	assert.equal((await running.result).status, 'done');
	await sessions.renameConversation(id, '新标题');
	assert.equal((await sessions.listConversations())[0]?.title, '新标题');
	await sessions.deleteConversation(id);
	assert.equal(await sessions.openConversation(), null);
	await assert.rejects(sessions.openConversation(id), MissingConversationError);
	assert.equal((await sessions.submit(request).result).status, 'failed');
	assert.equal(requests, 1);
	assert.deepEqual(await sessions.listConversations(), []);
	const next = await sessions.createConversation();
	assert.deepEqual(await connect(() => reply('')).openConversation(), { id: next, runs: [] });
});

void test('opening a stale history entry removed outside the session preserves the last opened chat', async (t) => {
	const { connect, directory } = await fixture(t);
	const sessions = connect(() => reply('已保存。'));
	const stale = await sessions.createConversation();
	await sessions.submit({ conversationId: stale, instruction: '会被移除的对话', refs: [] }).result;
	const current = await sessions.createConversation();
	await sessions.submit({ conversationId: current, instruction: '保留的对话', refs: [] }).result;
	assert.ok((await sessions.listConversations()).some(({ id }) => id === stale));
	await rm(join(directory, `${stale}.jsonl`));
	await assert.rejects(sessions.openConversation(stale), MissingConversationError);
	assert.equal((await sessions.openConversation())?.id, current);
	assert.deepEqual((await sessions.listConversations()).map(({ id }) => id), [current]);
});

void test('resumed runs retain their saved effort and legacy runs ignore the current chat choice', async (t) => {
	const { directory, connect } = await fixture(t);
	const key = chatModelKey(firstModel.providerId, firstModel.model);
	const thinkingOptions: ModelService['thinkingOptions'] = (_model, preferred) => ({ levels: ['low', 'high'], level: preferred ?? 'low' });
	const start = connect((request) => {
		assert.equal(request.reasoning, 'high');
		return reply('暂停前的回复。');
	}, { ...firstModel, thinkingByModel: { [key]: 'high' } }, thinkingOptions);
	const id = await start.createConversation();
	const run = start.submit({ conversationId: id, instruction: '请分两段作答。', refs: [] }, {
		onEvent(event) {
			if (event.type === 'text-delta') start.pause(run.taskId);
		},
	});
	assert.equal((await run.result).status, 'interrupted');
	const store = createConversationStore(directory);
	assert.equal((await store.load(id)).runs[0]?.model.reasoning, 'high');
	const unavailable = connect(() => assert.fail('原档位不可用时不能发送请求'), firstModel,
		() => ({ levels: ['low'], level: 'low' }));
	await assert.rejects(unavailable.resume(id, run.taskId).result, { level: 'high' });
	assert.equal((await store.load(id)).runs[0]?.state.status, 'interrupted');
	const legacyId = 'legacy-effort';
	const legacyTask: Task = {
		id: 'legacy-task', status: 'running', createdAt: 1, updatedAt: 1,
		request: { conversationId: legacyId, instruction: '继续旧记录。', refs: [] },
	};
	await store.append(legacyId, [{ type: 'start', task: legacyTask, model: firstModel }]);
	const seen: ModelRequest['reasoning'][] = [];
	const reopened = connect((request) => {
		seen.push(request.reasoning);
		return reply('已完成。');
	}, { ...firstModel, thinkingByModel: { [key]: 'low' } }, thinkingOptions);
	assert.equal((await reopened.resume(id, run.taskId).result).status, 'done');
	assert.equal((await reopened.resume(legacyId, legacyTask.id).result).status, 'done');
	assert.deepEqual(seen, ['high', undefined]);
});

for (const action of ['close-and-ask', 'stop-and-ask', 'close-and-resume'] as const) {
	void test(`visible partial reply survives ${action} without duplication`, async (t) => {
		const { cwd, connect } = await fixture(t);
		const path = '线索.md';
		await writeFile(join(cwd, path), '第一点是鸢尾花。第二点是铃兰。');
		const read = { id: 'note', name: 'Read', input: { file_path: path } };
		const initialReplies = [reply('', [read]), reply(shownPartial)];
		const before = connect(() => {
			const next = initialReplies.shift();
			assert.ok(next);
			return next;
		});
		const conversationId = await before.createConversation();
		const handle = before.submit({ conversationId, instruction: '分段解释临时笔记里的两条线索。', refs: [{ path }] }, {
			onEvent(event) {
				if (event.type !== 'text-delta') return;
				assert.equal(event.text, shownPartial);
				if (action === 'stop-and-ask') void before.cancel(handle.taskId);
				else before.dispose();
			},
		});
		const stopped = await handle.result;
		assert.equal(stopped.status, action === 'stop-and-ask' ? 'cancelled' : 'interrupted');
		assert.deepEqual(stopped.messages.at(-1), {
			role: 'assistant', id: `assistant:${handle.taskId}:2`, content: shownPartial, incomplete: true,
		});

		const continuation = '第二点是铃兰。';
		const sent: ModelRequest[] = [];
		const reopened = connect((request) => {
			sent.push(request);
			return reply(action === 'close-and-resume' ? shownPartial + continuation : continuation);
		});
		const opened = (await reopened.openConversation(conversationId))?.runs[0];
		assert.ok(opened);
		assert.equal(opened.finalized, action === 'stop-and-ask' ? true : undefined);
		const rendered = restoreExecution(opened);
		assert.equal(rendered.items.filter((row) => row.kind === 'text' && row.content === shownPartial).length, 1);
		assert.equal(rendered.state?.messages.filter(({ content }) => content === shownPartial).length, 1);
		const continued = await (action === 'close-and-resume' ? reopened.resume(conversationId, handle.taskId)
			: reopened.submit({ conversationId, instruction: '请接着讲第二点。', refs: [] })).result;
		assert.equal(continued.status, 'done', continued.error);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.messages.filter(({ content }) => content === shownPartial).length, 1);
		assert.match(sent[0]?.messages.find(({ role }) => role === 'tool')?.content ?? '', /第二点是铃兰/);
		assert.equal(continued.messages.at(-1)?.content, continuation);
	});
}

void test('a stopped reply from older saved conversations is included in follow-up requests', async (t) => {
	const { directory, connect } = await fixture(t);
	const id = 'previous-version';
	const task: Task = {
		id: 'legacy', status: 'running', createdAt: 1, updatedAt: 1,
		request: { conversationId: id, instruction: '分段讲解。', refs: [] },
	};
	await createConversationStore(directory).append(id, [
		{ type: 'start', task, model: firstModel },
		{ type: 'messages', taskId: task.id, messages: [{ role: 'user', content: task.request.instruction }] },
		{ type: 'finish', taskId: task.id, status: 'cancelled', turn: 1, partial: shownPartial },
	]);
	const sent: ModelRequest[] = [];
	const sessions = connect((request) => { sent.push(request); return reply('继续。'); });
	const saved = (await sessions.openConversation(id))?.runs[0];
	assert.ok(saved);
	assert.equal(restoreExecution(saved).items.find((row) => row.kind === 'text')?.content, shownPartial);
	assert.equal((await sessions.submit({ conversationId: id, instruction: '继续。', refs: [] }).result).status, 'done');
	assert.equal(sent[0]?.messages.filter(({ content }) => content === shownPartial).length, 1);
});

void test('a stopped approval is shown after reopening and the pending write is never rerun', async (t) => {
	const { cwd, connect } = await fixture(t);
	await writeFile(join(cwd, 'before.md'), '已完成读取');
	const read = { id: 'read', name: 'Read', input: { file_path: 'before.md' } };
	const write = { id: 'save', name: 'Write', input: { file_path: 'must-not-exist.md', content: '禁止意外执行' } };
	const before = connect(() => reply('', [read, write]));
	const id = await before.createConversation();
	let approvals = 0;
	const handle = before.submit({ conversationId: id, instruction: '读完另存为新笔记。', refs: [] }, {
		async approve(preview) {
			assert.equal(preview.target, write.input.file_path);
			approvals += 1;
			await before.cancel(handle.taskId);
			return new Promise(() => {});
		},
	});
	const ended = await handle.result;
	assert.equal(ended.status, 'cancelled', ended.error);
	assert.equal(approvals, 1);
	before.dispose();

	let requests = 0;
	const reopened = connect(() => { requests++; return reply('已确认。'); });
	const saved = await reopened.openConversation();
	assert.equal(saved?.id, id);
	const run = saved.runs[0];
	assert.equal(run?.state.status, 'cancelled');
	assert.equal(run.step?.phase, 'approval');
	assert.deepEqual(run.step?.call, { id: write.id, name: write.name });
	assert.ok(run.state.messages.some((message) => message.toolCallId === read.id && !message.isError));
	assert.equal(requests, 0);
	await assert.rejects(access(join(cwd, write.input.file_path)), { code: 'ENOENT' });
	reopened.dispose();
});

void test('an interrupted task resumes as history and closes orphaned calls with an error', async (t) => {
	const { cwd, directory, connect } = await fixture(t);
	const store = createConversationStore(directory);
	const id = 'restore-interrupted';
	const now = Date.now();
	const pending = { id: 'unconfirmed-write', name: 'Write', input: { file_path: 'not-created.md', content: '未完成写入' } };
	const task: Task = {
		id: 'interrupted-task', status: 'running', createdAt: now, updatedAt: now,
		request: { conversationId: id, instruction: '创建笔记。', refs: [] },
	};
	await store.append(id, [
		{ type: 'start', task, model: firstModel },
		{ type: 'messages', taskId: task.id, messages: [
			{ role: 'user', content: '创建笔记。' },
			{ role: 'assistant', content: '', toolCalls: [pending] },
		] },
		{ type: 'step', taskId: task.id, step: { phase: 'tool', turn: 1, call: { id: pending.id, name: pending.name } } },
	]);
	await store.setLastOpened(id);

	const sent: ModelRequest[] = [];
	const reopened = connect((request) => { sent.push(request); return reply('先核对文件是否存在。'); });
	const saved = await reopened.openConversation();
	assert.equal(saved?.id, id);
	assert.equal(saved.runs[0]?.state.status, 'interrupted');
	assert.equal(saved.runs[0]?.step?.call?.id, pending.id);
	assert.equal(sent.length, 0);
	await assert.rejects(reopened.resume(id, task.id).result, /请先核对已保存的进度/);
	assert.equal(sent.length, 0);

	const result = await reopened.submit({ conversationId: id, instruction: '先确认上次有没有成功。', refs: [] }).result;
	assert.equal(result.status, 'done', result.error);
	const messages = sent[0]?.messages ?? [];
	assert.equal(messages.at(-1)?.role, 'user');
	const activity = messages.find((message) => message.toolCallId === pending.id);
	assert.equal(activity?.role, 'tool');
	assert.equal(activity.isError, true);
	assert.equal(activity.toolName, pending.name);
	await assert.rejects(access(join(cwd, pending.input.file_path)), { code: 'ENOENT' });
	reopened.dispose();
});

void test('closing and reopening resumes the same task without replaying a saved write or an old approval', async (t) => {
	const { cwd, connect } = await fixture(t);
	const a = { id: 'a', name: 'Write', input: { file_path: 'A.md', content: '甲' } };
	const b = { id: 'b-before-close', name: 'Write', input: { file_path: 'B.md', content: '乙' } };
	const original = connect(() => reply('', [a, b]));
	const id = await original.createConversation();
	const request = { conversationId: id, instruction: '请创建 A.md 和 B.md。', refs: [] };
	const old = original.submit(request, { approve: async (preview) => {
		if (preview.target === 'A.md') return true;
		assert.equal(preview.target, 'B.md');
		original.dispose();
		return false;
	} });
	assert.equal((await old.result).status, 'interrupted');
	const aBefore = await stat(join(cwd, 'A.md'));
	await assert.rejects(access(join(cwd, 'B.md')), { code: 'ENOENT' });

	const requests: ModelRequest[] = [];
	const reopened = connect((request) => {
		requests.push(request);
		return requests.length === 1 ? reply('', [{ ...a, id: 'repeated-a', input: { ...a.input, content: '不应覆盖' } }, { ...b, id: 'b-after-open' }])
			: reply('两篇已完成。');
	});
	const saved = (await reopened.openConversation(id))?.runs[0];
	assert.equal(saved?.state.status, 'interrupted');
	assert.equal(saved?.step?.phase, 'approval');
	assert.deepEqual(saved?.state.pendingCalls, [b]);
	assert.equal(requests.length, 0);
	const approvals: string[] = [];
	const result = await reopened.resume(id, old.taskId, { approve: async (preview) => { approvals.push(preview.target); return true; } }).result;
	assert.equal(result.status, 'file-changes-done', result.error);
	assert.deepEqual(approvals, ['B.md']);
	assert.equal(requests[0]?.messages.find((message) => message.toolCallId === a.id)?.isError, false);
	assert.equal(requests[0]?.messages.find((message) => message.toolCallId === b.id)?.skipped, true);
	assert.equal(await readFile(join(cwd, 'A.md'), 'utf8'), '甲');
	assert.equal((await stat(join(cwd, 'A.md'))).mtimeMs, aBefore.mtimeMs);
	assert.equal(await readFile(join(cwd, 'B.md'), 'utf8'), '乙');
	const runs = (await reopened.openConversation(id))?.runs;
	assert.equal(runs?.length, 1);
	assert.equal(runs[0]?.state.taskId, old.taskId);
	assert.equal(runs[0]?.state.status, 'file-changes-done');
	assert.equal(runs[0]?.state.resumed, true);
	assert.equal(runs[0]?.state.messages.filter(({ role }) => role === 'user').length, 1);
	await assert.rejects(reopened.resume(id, old.taskId).result, /无法从此处继续任务/);
});

void test('resuming a saved task only restores explicit outside attachments', async (t) => {
	const { cwd, directory, connect } = await fixture(t);
	const store = createConversationStore(directory);
	const file = join(cwd, '..', '外部临时笔记.md');
	await writeFile(file, '恢复验证用的临时资料');

	for (const explicit of [false, true]) {
		const id = explicit ? 'explicit-attachment' : 'old-inferred-path';
		const sessions = connect((request) => request.messages.some(({ role }) => role === 'tool') ? reply('已核对。')
			: reply('', [{ id: 'read', name: 'Read', input: { file_path: file } }]));
		const task: Task = {
			id, status: 'running', createdAt: 1, updatedAt: 1,
			request: {
				conversationId: id, instruction: '核对临时资料。',
				refs: [{ path: file, ...(explicit ? { addedExternal: true as const } : {}) }],
			},
		};
		await store.append(id, [{ type: 'start', task, model: firstModel }]);
		const restored = await sessions.resume(id, id).result;
		const result = restored.messages.find(({ role }) => role === 'tool');
		assert.equal(result?.isError, !explicit);
		assert.equal(result?.content.includes('恢复验证用的临时资料'), explicit);
	}
});

for (const repair of [true, false]) {
	void test(repair ? 'resuming finishes a second edit without replaying the first edit'
		: 'an unfinished edit stays visible when a resumed task closes again and omits it', async (t) => {
		const { cwd, connect } = await fixture(t);
		const file = '草稿.md';
		await writeFile(join(cwd, file), '标题\n旧正文\n');
		const read = { id: 'read', name: 'Read', input: { file_path: file } };
		const title = { id: 'title', name: 'Edit', input: {
			file_path: file, old_string: '标题', new_string: '新标题', replace_all: true,
		} };
		const body = { id: 'body', name: 'Edit', input: {
			file_path: file, old_string: '旧正文', new_string: '新正文',
		} };
		let turn = 0;
		const first = connect(() => reply('', ++turn === 1 ? [read] : [title, body]));
		const conversationId = await first.createConversation();
		const run = first.submit({ conversationId, instruction: '请修改 草稿.md。', refs: [] }, {
			async approve(preview) {
				if (preview.after === '新标题\n旧正文\n') return true;
				assert.equal(preview.after, '新标题\n新正文\n');
				first.dispose();
				return false;
			},
		});
		assert.equal((await run.result).status, 'interrupted');
		assert.equal(await readFile(join(cwd, file), 'utf8'), '新标题\n旧正文\n');

		if (!repair) {
			const paused = connect(() => {
				paused.dispose();
				return reply('');
			});
			assert.equal((await paused.resume(conversationId, run.taskId).result).status, 'interrupted');
		}

		const repeat = { ...title, id: 'repeat-title', input: { ...title.input, file_path: join(cwd, file) } };
		const overwrite = { id: 'overwrite', name: 'Write', input: { file_path: file, content: '不得覆盖已写入的修改' } };
		const finish = reply('标题和正文修改已完成。');
		const replies = repair ? [
			reply('', [{ ...read, id: 'read-again' }]),
			reply('', [repeat, overwrite, { ...body, id: 'body-again', input: { ...body.input, replace_all: false } }]),
			finish,
		] : [finish];
		const reopened = connect(() => {
			const next = replies.shift();
			assert.ok(next);
			return next;
		});
		const approvals: Array<string | undefined> = [];
		const result = await reopened.resume(conversationId, run.taskId, { async approve(preview) {
			approvals.push(preview.after);
			return true;
		} }).result;
		assert.equal(result.status, repair ? 'file-changes-done' : 'partial', result.error);
		assert.deepEqual(approvals, repair ? ['新标题\n新正文\n'] : []);
		assert.equal(await readFile(join(cwd, file), 'utf8'), repair ? '新标题\n新正文\n' : '新标题\n旧正文\n');
		assert.equal(replies.length, 0);
		if (repair) {
			const skipped = result.messages.filter((message) => message.skipped).map((message) => message.toolCallId);
			assert.deepEqual(skipped, ['body', 'repeat-title', 'overwrite']);
			assert.equal(result.messages.find((message) => message.toolCallId === 'body-again')?.isError, false);
		} else {
			assert.match(result.messages.at(-1)?.content ?? '', /草稿\.md 仍有修改未完成（退出前尚未完成此项修改。）/);
		}
	});
}

void test('resuming a previously pending overwrite rereads the file and gets a fresh approval', async (t) => {
	const { cwd, connect } = await fixture(t);
	const file = '稿件.md';
	await writeFile(join(cwd, file), '旧标题\n旧正文\n');
	const read = { id: 'read', name: 'Read', input: { file_path: file } };
	const edit = { id: 'heading', name: 'Edit', input: { file_path: file, old_string: '旧标题', new_string: '新标题' } };
	const write = { id: 'overwrite', name: 'Write', input: { file_path: file, content: '新标题\n重写后的正文\n' } };
	const opening = [
		reply('', [read]), reply('', [edit]), reply('', [{ ...read, id: 'read-edited' }]), reply('', [write]),
	];
	const first = connect(() => {
		const next = opening.shift();
		assert.ok(next);
		return next;
	});
	const conversationId = await first.createConversation();
	const run = first.submit({ conversationId, instruction: '请修改 稿件.md。', refs: [] }, {
		async approve(preview) {
			if (preview.after === '新标题\n旧正文\n') return true;
			assert.equal(preview.after, write.input.content);
			first.dispose();
			return false;
		},
	});
	assert.equal((await run.result).status, 'interrupted');
	assert.equal(await readFile(join(cwd, file), 'utf8'), '新标题\n旧正文\n');

	const recovery = [
		reply('', [{ ...read, id: 'read-for-resume' }]), reply('', [{ ...write, id: 'overwrite-after-resume' }]), reply('已续做。'),
	];
	const reopened = connect(() => {
		const next = recovery.shift();
		assert.ok(next);
		return next;
	});
	const previews: Array<string | undefined> = [];
	const result = await reopened.resume(conversationId, run.taskId, { async approve(preview) {
		previews.push(preview.after);
		return true;
	} }).result;
	assert.equal(result.status, 'file-changes-done', result.error);
	assert.deepEqual(previews, [write.input.content]);
	assert.equal(await readFile(join(cwd, file), 'utf8'), write.input.content);
});

void test('resume reviews the request before sending and leaves the saved task intact on cancellation', async (t) => {
	const { cwd, directory, connect } = await fixture(t);
	const path = '续做确认.md';
	const savedText = '只用于本地验证的笔记内容';
	await writeFile(join(cwd, path), savedText);
	const read = { id: 'read-before-resume', name: 'Read', input: { file_path: path } };
	let rounds = 0;
	const initial = connect(() => ++rounds === 1 ? reply('', [read]) : reply('已显示的半段。'));
	const id = await initial.createConversation();
	const original = initial.submit({ conversationId: id, instruction: '读取临时笔记再总结。', refs: [{ path }] }, {
		onEvent(event) {
			if (event.type === 'text-delta') initial.pause(original.taskId);
		},
	});
	assert.equal((await original.result).status, 'interrupted');
	const store = createConversationStore(directory);
	const before = await store.load(id);
	const sent: ModelRequest[] = [];
	const address = 'http://127.0.0.1:14080/v1/chat/completions';
	const resumed = connect((request) => {
		const stream = reply('续做完成。');
		return {
			...stream,
			async *[Symbol.asyncIterator]() {
				assert.ok(request.beforeSend);
				await request.beforeSend(address);
				await request.beforeSend(address);
				sent.push(request);
				yield* stream;
			},
		};
	});

	const declined = await resumed.resume(id, original.taskId, {
		async confirmResume(preview) {
			assert.equal(preview.address, address);
			assert.equal(preview.source.refs[0]?.path, path);
			assert.ok(preview.request.messages.some(({ content }) => content.includes(savedText)));
			assert.ok(preview.request.messages.some(({ content }) => content.includes('已显示的半段。')));
			assert.deepEqual(sent, []);
			return false;
		},
	}).result;
	assert.equal(declined.status, 'interrupted');
	assert.deepEqual(await store.load(id), before);
	assert.deepEqual(sent, []);

	let approvals = 0;
	const completed = await resumed.resume(id, original.taskId, {
		async confirmResume(preview) {
			assert.equal(preview.address, address);
			approvals++;
			return true;
		},
	}).result;
	assert.equal(completed.status, 'done', completed.error);
	assert.equal(approvals, 1);
	assert.equal(sent.length, 1);
});

void test('a resumed run refuses to send to an address other than the one approved', async (t) => {
	const { directory, connect } = await fixture(t);
	const store = createConversationStore(directory);
	const id = 'resume-address-changed';
	const task: Task = {
		id, status: 'running', createdAt: 1, updatedAt: 1, request: { conversationId: id, instruction: '整理临时资料。', refs: [] },
	};
	await store.append(id, [{ type: 'start', task, model: firstModel }]);
	const addresses = ['http://127.0.0.1:14080/v1/chat/completions', 'http://127.0.0.1:14081/v1/chat/completions'];
	const sent: string[] = [];
	const sessions = connect((request) => ({
		...reply('完成。'),
		async *[Symbol.asyncIterator]() {
			assert.ok(request.beforeSend);
			for (const address of addresses) {
				await request.beforeSend(address);
				sent.push(address);
				yield* reply('暂存内容。');
			}
		},
	}));
	const result = await sessions.resume(id, id, { confirmResume: async () => true }).result;
	assert.equal(result.status, 'failed');
	assert.match(result.error ?? '', /发送地址已改变/);
	assert.deepEqual(sent, addresses.slice(0, 1));
});
