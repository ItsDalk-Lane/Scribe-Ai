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
import { writeTools } from '../../tools/writeTools';
import type { ModelRequest, ModelStream, RuntimeLayer, Task, ToolCall } from '../../types';
import { createContextBuilder } from '../context/contextBuilder';
import { createSessionController } from '../sessionController';
import { normalizeSettings } from '../settings/defaults';
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
		connect: (stream: (request: ModelRequest) => ModelStream, model = firstModel) => {
			const registry = createToolRegistry([readTools, writeTools]);
			const models = createModelCoordinator({ stream }, createContextBuilder(registry));
			const tools = createToolCoordinator(app, createToolExecutor(registry));
			const runtime: RuntimeLayer = {
				newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools,
			};
			return createSessionController(app, normalizeSettings(model), runtime, createConversationStore(directory));
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
	const start = await before.submit({ conversationId: id, instruction: '读取笔记并记住其中的地点。', refs: [{ path: 'fact.md' }] }).result;
	assert.equal(start.status, 'done', start.error);
	assert.equal(requests, 2);
	before.dispose();

	const sent: ModelRequest[] = [];
	const reopened = connect((request) => { sent.push(request); return reply('已接续。'); }, secondModel);
	const saved = await reopened.openConversation();
	assert.equal(saved?.id, id);
	assert.equal(saved.runs[0]?.state.status, 'done');
	assert.deepEqual(saved.runs[0]?.request.refs, [{ path: 'fact.md' }]);
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
		assert.deepEqual(stopped.messages.at(-1), { role: 'assistant', content: shownPartial, incomplete: true });

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
		assert.equal(rendered.draft, '');
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
	assert.equal(restoreExecution(saved).draft, shownPartial);
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
