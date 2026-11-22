import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import { conversationMetrics, runUsage } from '../../interaction/chatMetrics';
import { restoreExecution } from '../../interaction/context';
import { createAgentLoop } from '../../runtime/agentLoop';
import { bindAgent } from '../../runtime/createAgent';
import { createModelCoordinator } from '../../runtime/modelCoordinator';
import { createRunState } from '../../runtime/runState';
import { createToolCoordinator } from '../../runtime/toolCoordinator';
import { createToolRegistry } from '../../tools';
import { createToolExecutor } from '../../tools/executor';
import { shellTools } from '../../tools/external/shellTool';
import { readTools } from '../../tools/readTools';
import { searchTools } from '../../tools/searchTools';
import { writeTools } from '../../tools/writeTools';
import { MissingConversationError } from '../../types';
import type { AutoReviewDenial, Message, ModelRequest, ModelService, ModelStream, ReportedUsage, RunState, RuntimeLayer, ScribeSettings, Task, TaskRequest, ToolCall } from '../../types';
import { createContextBuilder } from '../context/contextBuilder';
import { createSessionController } from '../sessionController';
import { normalizeSettings } from '../settings/defaults';
import { chatModelKey } from '../settings/thinking';
import { createConversationStore } from '../storage/conversationStore';

const firstModel = { providerId: 'test-provider', model: 'first-model' };
const secondModel = { providerId: 'another-provider', model: 'second-model' };
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function reply(content: string, toolCalls: ToolCall[] = [], billing?: { reportedUsage: ReportedUsage; total?: number }): ModelStream {
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
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: billing ? { ...cost, total: billing.total ?? 9, totalFromProvider: billing.total !== undefined } : cost },
		stopReason: toolCalls.length ? 'toolUse' : 'stop',
		timestamp: Date.now(),
	};
	return {
		async *[Symbol.asyncIterator]() {
			if (content) yield { type: 'text_delta', delta: content, contentIndex: 0, partial: raw };
		},
		result: () => Promise.resolve({ raw, content, toolCalls, stopReason: toolCalls.length ? 'tool-calls' : 'end',
			...(billing ? { reportedUsage: billing.reportedUsage, usage: raw.usage } : {}) }),
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
	let activeNote: string | undefined;
	const ruleLookups: string[] = [];
	const ruleReads: string[] = [];
	const app = { workspace: { getActiveFile: () => activeNote ? { path: activeNote } : null }, vault: {
		adapter: {
			getBasePath: () => cwd,
			async process(path: string, update: (content: string) => string) {
				const file = join(cwd, path);
				await writeFile(file, update(await readFile(file, 'utf8')));
			},
		},
		configDir: 'fixture-vault-config',
		getFileByPath(path: string) {
			if (path !== 'AGENTS.md' && !path.endsWith('/AGENTS.md')) return null;
			ruleLookups.push(path);
			return statSync(join(cwd, path), { throwIfNoEntry: false })?.isFile() ? { path, name: 'AGENTS.md' } : null;
		},
		read({ path }: { path: string }) {
			ruleReads.push(path);
			return readFile(join(cwd, path), 'utf8');
		},
		create: (path: string, content: string) => writeFile(join(cwd, path), content, { flag: 'wx' }),
	} } as unknown as App;
	return {
		cwd,
		directory,
		ruleLookups,
		ruleReads,
		setActiveNote: (path: string) => { activeNote = path; },
		connect: (stream: (request: ModelRequest) => ModelStream, model: Partial<ScribeSettings> = firstModel,
			thinkingOptions?: ModelService['thinkingOptions'], modelService?: Pick<ModelService, 'send' | 'contextLimits'>) => {
			const registry = createToolRegistry([readTools, searchTools, writeTools, shellTools]);
			const models = createModelCoordinator({ stream, contextLimits: modelService?.contextLimits }, createContextBuilder(registry));
			const tools = createToolCoordinator(app, createToolExecutor(registry));
			const runtime: RuntimeLayer = {
				newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools,
			};
			return createSessionController(app, normalizeSettings(model), runtime, createConversationStore(directory), thinkingOptions, modelService);
		},
	};
}

void test('chat execution modes run vault edits directly and route outside actions to the selected approver', async (t) => {
	const { cwd, connect, directory } = await fixture(t);
	for (const [executionMode, decision] of [
		['ask', 'approve'], ['ask', 'deny'], ['auto-review', 'APPROVE'], ['auto-review', 'DENY'],
		['auto-review', 'APPROVE with extra text'], ['full-access', 'unused'],
	] as const) {
		const label = `${executionMode}-${decision}`;
		const outside = join(cwd, '..', `${label}.md`);
		const inside = `${label}.md`;
		const write = (id: string, path: string): ToolCall => ({ id, name: 'Write', input: { file_path: path, content: '新内容' } });
		const reviews: ModelRequest[] = [];
		let prompts = 0;
		let first = true;
		const sessions = connect(() => {
			if (!first) return reply('执行完毕。');
			first = false;
			return reply('', [write('inside', inside), write('outside', outside)]);
		}, firstModel, undefined, { async send(request) { reviews.push(request); return reply(decision).result(); } });
		const id = await sessions.createConversation();
		const instruction = `创建 ${inside} 以及库外的 ${outside}`;
		const state = await sessions.submit({ conversationId: id, instruction, refs: [] }, {
			approve: async (operation) => { prompts++; assert.ok(operation.target.endsWith(`${label}.md`)); return decision === 'approve'; },
		}, undefined, { executionMode }).result;
		assert.equal(await readFile(join(cwd, inside), 'utf8'), '新内容');
		const allowed = decision === 'approve' || decision === 'APPROVE' || executionMode === 'full-access';
		if (allowed) assert.equal(await readFile(outside, 'utf8'), '新内容');
		else await assert.rejects(access(outside), { code: 'ENOENT' });
		assert.equal(state.messages.find(({ toolCallId }) => toolCallId === 'outside')?.isError, !allowed);
		const [saved] = (await createConversationStore(directory).load(id)).runs;
		assert.deepEqual(saved?.state.messages.find(({ toolCallId }) => toolCallId === 'inside')?.noteChange, { path: inside, after: '新内容' });
		assert.equal(saved?.state.messages.find(({ toolCallId }) => toolCallId === 'outside')?.noteChange, undefined);
		assert.equal(prompts, executionMode === 'ask' ? 1 : 0);
		assert.equal(reviews.length, executionMode === 'auto-review' ? 1 : 0);
		for (const review of reviews) {
			assert.deepEqual(review.tools, []);
			assert.equal(review.sessionId, undefined);
			const payload = JSON.parse(review.messages[0]!.content) as { instruction: string; operation: { target: string; after: string } };
			assert.equal(payload.instruction, instruction);
			assert.ok(payload.operation.target.endsWith(`${label}.md`));
			assert.equal(payload.operation.after, '新内容');
		}
		sessions.dispose();
	}
});

void test('plan and review do not regain write permissions and review sends only its selected material', async (t) => {
	const { cwd, connect, directory } = await fixture(t);
	const outside = join(cwd, '..', 'external.md');
	await Promise.all([writeFile(outside, 'outside secret'), writeFile(join(cwd, 'context.md'), 'vault detail'),
		writeFile(join(cwd, 'AGENTS.md'), 'vault style')]);
	const requests: ModelRequest[] = [];
	const deniedWrite = { id: 'plan-write', name: 'Write', input: { file_path: 'forbidden.md', content: 'write attempt' } };
	const planReads = [outside, 'context.md'].map((file_path, index) =>
		({ id: `plan-read-${index}`, name: 'Read', input: { file_path } }));
	const sessions = connect((request) => {
		requests.push(request);
		if (!request.messages.some(({ toolCallId }) => toolCallId === deniedWrite.id) && request.system?.includes('本次为只读计划模式')) {
			return reply('', [deniedWrite, ...planReads]);
		}
		return reply('说完了。');
	});
	t.after(() => sessions.dispose());
	const conversationId = await sessions.createConversation();
	await sessions.submit({ conversationId, instruction: 'unrelated prior history', refs: [] }).result;
	const plan = await sessions.submit({ conversationId, intent: 'plan', instruction: '先做计划', refs: [{ path: outside, kind: 'file' }] }, {}, undefined,
		{ executionMode: 'full-access' }).result;
	assert.equal(plan.messages.find(({ toolCallId }) => toolCallId === deniedWrite.id)?.isError, true);
	assert.equal(plan.messages.find(({ toolCallId }) => toolCallId === planReads[0]?.id)?.isError, true);
	assert.match(plan.messages.find(({ toolCallId }) => toolCallId === planReads[1]?.id)?.content ?? '', /vault detail/);
	await assert.rejects(access(join(cwd, 'forbidden.md')), { code: 'ENOENT' });
	assert.deepEqual(requests.find(({ system }) => system?.includes('本次为只读计划模式'))?.tools.map(({ name }) => name).sort(), ['Glob', 'Grep', 'Read']);
	const reviewMaterial = 'selected snapshot';
	await sessions.submit({ conversationId, intent: 'review', instruction: '检查事实', refs: [], reviewMaterial }, {}, undefined,
		{ executionMode: 'full-access' }).result;
	const review = requests.at(-1)!;
	assert.match(review.system ?? '', /本次为只读笔记检查/);
	assert.doesNotMatch(review.system ?? '', /vault style/);
	assert.deepEqual(review.tools, []);
	assert.equal(review.messages.length, 2);
	assert.equal(review.messages[0]?.content, '检查事实');
	assert.match(review.messages[1]?.content ?? '', /selected snapshot/);
	assert.equal((await createConversationStore(directory).load(conversationId)).runs.at(-1)?.request.reviewMaterial, reviewMaterial);
	await sessions.submit({ conversationId, instruction: '下一个普通问题', refs: [] }).result;
	assert.ok(requests.at(-1)?.messages.every(({ content }) => !content.includes(reviewMaterial)));
});

void test('writing rules are read from AGENTS.md in the vault root and matching folders on every question', async (t) => {
	const { cwd, connect, ruleLookups, setActiveNote } = await fixture(t);
	await Promise.all(['会议/项目', '读书', '会议存档'].map((folder) => mkdir(join(cwd, folder), { recursive: true })));
	await Promise.all(Object.entries({
		'AGENTS.md': '全库用短段落。',
		'会议/AGENTS.md': '会议用项目符号。',
		'会议/项目/AGENTS.md': '项目会议结尾列出负责人。',
		'会议/项目/纪要.md': '会议记录。',
		'读书/AGENTS.md': '读书笔记结尾写感想。',
		'读书/摘录.md': '摘录。',
		'会议存档/旧纪要.md': '旧会议记录。',
		'普通笔记.md': '普通笔记。',
	}).map(([path, content]) => writeFile(join(cwd, path), content)));
	const requests: ModelRequest[] = [];
	const sessions = connect((request) => {
		requests.push(request);
		return reply('已完成。');
	});
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const ask = async (options: Partial<Pick<TaskRequest, 'refs'>> = {}) => {
		const run = await sessions.submit({ conversationId: id, instruction: '请整理内容。', refs: [], ...options }).result;
		assert.equal(run.status, 'done', run.error);
		return requests.at(-1)!;
	};

	setActiveNote('读书/摘录.md');
	const meeting = await ask({ refs: [{ path: '会议/项目/纪要.md' }] });
	assert.match(meeting.system ?? '', /全库用短段落。[\s\S]*会议用项目符号。[\s\S]*项目会议结尾列出负责人。/u);
	assert.match(meeting.system ?? '', /文件夹规则优先于全库规则，较深的文件夹规则优先于上级文件夹规则/u);
	assert.doesNotMatch(meeting.system ?? '', /结尾写感想/u);
	assert.doesNotMatch(JSON.stringify(meeting.messages), /全库用短段落|会议用项目符号/u);
	assert.deepEqual([...new Set(ruleLookups)].sort(), ['AGENTS.md', '会议/AGENTS.md', '会议/项目/AGENTS.md']);

	const books = await ask();
	assert.match(books.system ?? '', /读书笔记结尾写感想/u);
	assert.doesNotMatch(JSON.stringify(books), /会议用项目符号|列出负责人/u);
	assert.doesNotMatch((await ask({ refs: [{ path: '会议存档/旧纪要.md' }] })).system ?? '', /会议用项目符号/u);

	await writeFile(join(cwd, '会议/AGENTS.md'), '会议改用表格。');
	const edited = await ask({ refs: [{ path: '会议', kind: 'folder' }] });
	assert.match(edited.system ?? '', /会议改用表格/u);
	assert.doesNotMatch(JSON.stringify(edited), /会议用项目符号|结尾列出负责人/u);

	await rm(join(cwd, '会议/AGENTS.md'));
	const removed = await ask({ refs: [{ path: '会议', kind: 'folder' }] });
	assert.match(removed.system ?? '', /全库用短段落/u);
	assert.doesNotMatch(JSON.stringify(removed), /会议改用表格/u);

	await writeFile(join(cwd, 'AGENTS.md'), '');
	assert.doesNotMatch(JSON.stringify(await ask({ refs: [{ path: '普通笔记.md' }] })), /全库用短段落/u);
});

void test('writing rules cannot be loaded by following a symlink outside the vault', { skip: process.platform === 'win32' }, async (t) => {
	const { cwd, connect, ruleReads } = await fixture(t);
	const external = join(cwd, '..', '外部规则.md');
	await writeFile(external, '不发送这个外部规则。');
	await symlink(external, join(cwd, 'AGENTS.md'));
	const requests: ModelRequest[] = [];
	const sessions = connect((request) => {
		requests.push(request);
		return reply('已完成。');
	});
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const run = await sessions.submit({ conversationId: id, instruction: '请整理内容。', refs: [] }).result;
	assert.equal(run.status, 'done', run.error);
	assert.equal(requests.length, 1);
	assert.deepEqual(ruleReads, []);
	assert.doesNotMatch(JSON.stringify(requests), /不发送这个外部规则/u);
});

void test('a long chat keeps its confirmed decision and counts the summary and automatic reviews once', async (t) => {
	const { cwd, connect } = await fixture(t);
	const path = '资料/交付纪要.md';
	const allowed = join(cwd, '..', '审核可读.md');
	const denied = join(cwd, '..', '审核拒绝.md');
	await mkdir(join(cwd, '资料'));
	await writeFile(join(cwd, path), '# 交付会\n交付批次为「银杏-27」。\n原始记录编号 RAW-NOTE-42。\n');
	await writeFile(allowed, '通过审核的示例材料。');
	await writeFile(denied, '拒绝后不得读取的示例材料。');
	const read: ToolCall = { id: 'summary-source-read', name: 'Read', input: { file_path: path } };
	const reviewedRead = (target: string): ToolCall => ({ id: 'reviewed-read', name: 'Read', input: { file_path: target } });
	const readPrompt = '读取这篇纪要并核对批次。';
	const decisionPrompt = '我确认沿用上一轮纪要里敲定的交付决定，待办由周宁复核清单。';
	const recallPrompt = '我们早先定的交付批次是什么？注明出处和剩余事项。';
	const captured: ModelRequest[] = [];
	const summarized: ModelRequest[] = [];
	const reviewed: ModelRequest[] = [];
	let recalls = 0;
	const beforeReview = { reportedUsage: { prompt: 135, input: 100, cacheRead: 30, cacheWrite: 5, output: 20 }, total: 0.125 };
	const afterReview = { reportedUsage: { prompt: 250, input: 200, cacheRead: 40, cacheWrite: 10, output: 30 }, total: 0.25 };
	const approvedUsage = { reportedUsage: { prompt: 100, input: 70, cacheRead: 25, cacheWrite: 5, output: 5 }, total: 0.0625 };
	const deniedUsage = { reportedUsage: { prompt: 65, input: 60, cacheRead: 5, output: 7 } };
	const summaryUsage = { reportedUsage: { prompt: 80, input: 60, cacheRead: 10, cacheWrite: 10, output: 12 }, total: 0.03125 };
	const service: Pick<ModelService, 'send' | 'contextLimits'> = {
		contextLimits: () => ({ contextWindow: 12_000, maxTokens: 1_024 }),
		async send(request) {
			if (request.system?.includes('你是独立审批员')) {
				reviewed.push(request);
				const { operation } = JSON.parse(request.messages[0]!.content) as { operation: { kind: string; target: string } };
				assert.equal(operation.kind, 'access');
				return operation.target.endsWith('审核可读.md')
					? reply('APPROVE', [], approvedUsage).result() : reply('DENY', [], deniedUsage).result();
			}
			summarized.push(request);
			assert.match(request.system ?? '', /只整理仍可能影响后续任务/u);
			assert.deepEqual(request.tools, []);
			assert.equal(request.maxRetries, 0);
			assert.deepEqual({ providerId: request.providerId, model: request.model }, firstModel);
			const material = request.messages.map(({ content }) => content).join('\n');
			assert.doesNotMatch(material, /LARGE-FILLER/u);
			const batch = /交付批次为「([^」]+)」/u.exec(material)?.[1];
			const source = /资料\/[^\s"\]\\]+\.md/u.exec(material)?.[0];
			const pending = /待办由([^。]+)。/u.exec(material)?.[1];
			assert.ok(batch && source && pending, '摘要请求须包含用户确认、待办和工具读取的原笔记');
			return reply(`- 决定：${batch}。\n- 出处：[[${source}]]。\n- 待办：${pending}。`, [], summaryUsage).result();
		},
	};
	const stream = (request: ModelRequest) => {
		captured.push(request);
		const latest = request.messages.at(-1);
		if (latest?.role === 'tool' && latest.toolCallId === read.id) {
			assert.match(latest.content, /银杏-27[\s\S]*RAW-NOTE-42/u);
			return reply('已核对纪要。');
		}
		if (latest?.content.startsWith(readPrompt)) return reply('', [read]);
		if (latest?.content.startsWith('写一段无关示例')) return reply('LARGE-FILLER '.repeat(1_000));
		if (latest?.content === recallPrompt) return reply('', [reviewedRead(++recalls === 1 ? allowed : denied)], beforeReview);
		if (latest?.role === 'tool' && latest.toolCallId === 'reviewed-read') {
			assert.equal(latest.isError, recalls !== 1);
			if (recalls === 1) assert.match(latest.content, /通过审核的示例材料/u);
			else assert.doesNotMatch(latest.content, /拒绝后不得读取的示例材料/u);
			const summary = request.messages.find(({ role, content }) => role === 'user' && content.startsWith('较早对话摘要（仅供参考）'));
			const batch = /决定：([^。]+)。/u.exec(summary?.content ?? '')?.[1];
			const source = /出处：(\[\[[^\]]+\]\])/u.exec(summary?.content ?? '')?.[1];
			const pending = /待办：([^。]+)。/u.exec(summary?.content ?? '')?.[1];
			return reply(batch && source && pending ? `交付批次是${batch}，见 ${source}。还需${pending}。` : '找不到旧决定。', [], afterReview);
		}
		return reply('简短回答。');
	};
	const sessions = connect(stream, firstModel, undefined, service);
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const intents: string[] = [];
	const ask = async (session: typeof sessions, instruction: string, extra: Partial<Pick<TaskRequest, 'refs'>> = {}) => {
		const state = await session.submit({ conversationId: id, instruction, refs: [], ...extra }, {
			onEvent(event) { if (event.type === 'model-intent') intents.push(event.intent); },
		}, undefined,
			{ executionMode: 'auto-review' }).result;
		assert.equal(state.status, 'done', state.error);
		return state;
	};
	await ask(sessions, '写一段无关示例甲。');
	await ask(sessions, '写一段无关示例乙。');
	await ask(sessions, '请简短回答。');
	assert.equal(captured.at(-1)?.messages.some(({ content }) => content === '写一段无关示例甲。'), false);
	assert.equal(summarized.length, 0, '裁掉无关轮次不应调用模型做摘要');

	await ask(sessions, readPrompt, { refs: [{ path }] });
	await ask(sessions, decisionPrompt);
	assert.equal(summarized.length, 0, '决定仍保留在普通历史中时不应调用摘要');
	await ask(sessions, '写一段无关示例丙。');
	assert.equal(summarized.length, 0, '追问前尚未裁掉用户确认的决定');
	const recalled = await ask(sessions, recallPrompt);
	assert.equal(recalled.messages.at(-1)?.content, '交付批次是银杏-27，见 [[资料/交付纪要.md]]。还需周宁复核清单。');
	assert.doesNotMatch(JSON.stringify(captured.at(-1)), /交付批次为「银杏-27」|RAW-NOTE-42/u);
	assert.doesNotMatch(intents.join('\n'), /正在整理较早对话里的决定和待办/u);
	assert.equal(summarized.length, 1);
	assert.equal(reviewed.length, 1);
	assert.deepEqual(recalled.auxiliaryUsage, [
		{ kind: 'summary', reportedUsage: summaryUsage.reportedUsage, cost: summaryUsage.total },
		{ kind: 'review', reportedUsage: approvedUsage.reportedUsage, cost: approvedUsage.total },
	]);
	const usage = runUsage(recalled);
	assert.ok(usage);
	assert.deepEqual(usage.byKind, {
		main: { count: 2, input: 300, cacheRead: 70, cacheWrite: 15, output: 50, total: 435, hit: 70 / 385, cost: 0.375 },
		review: { count: 1, input: 70, cacheRead: 25, cacheWrite: 5, output: 5, total: 105, hit: 0.25, cost: 0.0625 },
		summary: { count: 1, input: 60, cacheRead: 10, cacheWrite: 10, output: 12, total: 92, hit: 0.125, cost: 0.03125 },
	});
	assert.deepEqual({ count: usage.count, input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
		output: usage.output, total: usage.total, hit: usage.hit, cost: usage.cost },
	{ count: 4, input: 430, cacheRead: 105, cacheWrite: 30, output: 67, total: 632, hit: 105 / 565, cost: 0.46875 });
	sessions.dispose();

	const reopened = connect(stream, firstModel, undefined, service);
	t.after(() => reopened.dispose());
	const saved = await reopened.openConversation(id);
	assert.ok(saved);
	assert.ok(saved.runs.some(({ state }) => state.messages.some(({ content }) => content.includes('RAW-NOTE-42'))));
	const savedRecall = saved.runs.at(-1)?.state;
	assert.ok(savedRecall);
	assert.deepEqual(runUsage(savedRecall), usage);
	const repeated = await ask(reopened, recallPrompt);
	assert.equal(repeated.messages.at(-1)?.content, recalled.messages.at(-1)?.content);
	assert.deepEqual(repeated.auxiliaryUsage?.map(({ kind }) => kind), ['review']);
	const repeatedUsage = runUsage(repeated);
	assert.equal(repeatedUsage?.count, 3);
	assert.equal(repeatedUsage.total, 507);
	assert.equal(repeatedUsage.byKind.review?.cacheRead, 5);
	assert.equal(repeatedUsage.byKind.review?.cacheWrite, undefined);
	assert.equal(repeatedUsage.byKind.review?.cost, undefined);
	assert.equal(repeatedUsage.byKind.summary, undefined);
	assert.equal(repeatedUsage.cacheWrite, undefined);
	assert.equal(repeatedUsage.cost, undefined);
	const combined = conversationMetrics([savedRecall, repeated]).usage;
	assert.equal(combined?.count, 7);
	assert.equal(combined.total, 1139);
	assert.equal(combined.cost, undefined);
	assert.equal(combined.byKind.summary?.count, 1);
	assert.equal(combined.byKind.review?.count, 2);
	assert.equal(summarized.length, 1);
	assert.equal(reviewed.length, 2);
});

void test('stopping during an automatic review saves its usage once even when the reply arrives late', async (t) => {
	const { cwd, connect, directory } = await fixture(t);
	const outside = join(cwd, '..', 'cancelled-review-source.md');
	await writeFile(outside, '库外测试内容，不应读取。');
	let markStarted = () => {};
	let release = () => {};
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const held = new Promise<void>((resolve) => { release = resolve; });
	const read: ToolCall = { id: 'late-review', name: 'Read', input: { file_path: outside } };
	const sessions = connect(() => reply('', [read]), firstModel, undefined, {
		async send() {
			markStarted();
			await held;
			return reply('APPROVE').result();
		},
	});
	t.after(() => { release(); sessions.dispose(); });
	const id = await sessions.createConversation();
	const handle = sessions.submit({ conversationId: id, instruction: '经审核后读取指定资料。', refs: [] }, {}, undefined, { executionMode: 'auto-review' });
	await Promise.race([started, handle.result.then(() => assert.fail('未启动自动审核'))]);
	await sessions.cancel(handle.taskId);
	const stopped = await handle.result;
	assert.equal(stopped.status, 'cancelled');
	assert.deepEqual(stopped.auxiliaryUsage, [{ kind: 'review' }]);
	release();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const saved = await createConversationStore(directory).load(id);
	assert.deepEqual(saved.runs[0]?.state.auxiliaryUsage, [{ kind: 'review' }]);
	assert.equal(runUsage(stopped)?.byKind.review?.cost, undefined);
});

void test('Bash waits for the automatic reviewer and saves its decision beside the command result', {
	skip: !shellTools().find(({ name }) => name === 'Bash')?.isAvailable?.(),
	timeout: 10_000,
}, async (t) => {
	const { cwd, connect, directory } = await fixture(t);
	for (const [decision, expected] of [
		['APPROVE', 'approved'], ['DENY', 'denied'], ['APPROVE with extra text', 'incomplete'],
	] as const) {
		const marker = `bash-ran-${expected}.txt`;
		const command = `printf 'ran\\n' >> ${marker}`;
		const call: ToolCall = { id: 'checked-shell', name: 'Bash', input: { command, elevated: true } };
		let markReviewStarted = (_request: ModelRequest) => {};
		let releaseReview = () => {};
		const reviewStarted = new Promise<ModelRequest>((resolve) => { markReviewStarted = resolve; });
		const reviewHeld = new Promise<void>((resolve) => { releaseReview = resolve; });
		let reviews = 0;
		let first = true;
		const sessions = connect(() => {
			if (!first) return reply('检查结束。');
			first = false;
			return reply('', [call]);
		}, firstModel, undefined, {
			async send(request) {
				reviews++;
				markReviewStarted(request);
				await reviewHeld;
				return reply(decision).result();
			},
		});
		t.after(() => { releaseReview(); sessions.dispose(); });
		const id = await sessions.createConversation();
		let liveStatus: RunState['status'] | undefined;
		let denial: AutoReviewDenial | undefined;
		const run = sessions.submit({ conversationId: id, instruction: '审核后运行测试命令。', refs: [] }, {
			onEvent(event) { if (event.type === 'state') liveStatus = event.state.status; },
			onAutoReviewDenied(operation) { denial = operation; },
		}, undefined, { executionMode: 'auto-review' });
		const request = await Promise.race([reviewStarted, run.result.then(() => assert.fail('未发起独立审核'))]);
		assert.equal(liveStatus, 'awaiting-approval');
		const { operation } = JSON.parse(request.messages[0]!.content) as { operation: { kind: string; after: string } };
		assert.equal(operation.kind, 'shell');
		assert.equal(operation.after, command);
		await assert.rejects(access(join(cwd, marker)), { code: 'ENOENT' });
		releaseReview();

		const state = await run.result;
		assert.equal(reviews, 1);
		const [result] = state.messages.filter(({ toolCallId }) => toolCallId === call.id);
		assert.equal(result?.approvalReview, expected);
		assert.equal(result.isError, expected !== 'approved');
		assert.equal(result.shellStatus, expected === 'approved' ? 'success' : undefined);
		if (expected === 'approved') assert.equal(await readFile(join(cwd, marker), 'utf8'), 'ran\n');
		else await assert.rejects(access(join(cwd, marker)), { code: 'ENOENT' });
		const [saved] = (await createConversationStore(directory).load(id)).runs;
		assert.ok(saved);
		const row = restoreExecution(saved).items.find((item) => item.kind === 'tool' && item.call.id === call.id);
		assert.ok(row?.kind === 'tool');
		assert.equal(row.result?.approvalReview, expected);
		if (expected === 'denied') {
			assert.ok(denial);
			assert.equal(denial.approval.after, command);
			const retry = await denial.retry(new AbortController().signal);
			assert.equal(retry.shellStatus, 'success');
			await assert.rejects(denial.retry(new AbortController().signal), /已经尝试/);
			assert.equal(await readFile(join(cwd, marker), 'utf8'), 'ran\n');
		} else assert.equal(denial, undefined);
		sessions.dispose();
	}
});

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
		return requests.length === 1 ? reply('', [
			{ ...a, id: 'repeated-a', input: { ...a.input, content: '不应覆盖' } },
			{ ...b, id: 'b-after-open' },
			{ id: 'outside-resume-scope', name: 'Write', input: { file_path: '额外.md', content: '不应写入' } },
		]) : reply('两篇已完成。');
	});
	const saved = (await reopened.openConversation(id))?.runs[0];
	assert.equal(saved?.state.status, 'interrupted');
	assert.equal(saved?.step?.phase, 'approval');
	assert.deepEqual(saved?.state.pendingCalls, [b]);
	assert.equal(requests.length, 0);
	const approvals: string[] = [];
	const result = await reopened.resume(id, old.taskId, { approve: async (preview) => { approvals.push(preview.target); return true; } }).result;
	assert.equal(result.status, 'done', result.error);
	assert.deepEqual(approvals, ['B.md']);
	assert.equal(requests[0]?.messages.find((message) => message.toolCallId === a.id)?.isError, false);
	assert.equal(requests[0]?.messages.find((message) => message.toolCallId === b.id)?.skipped, true);
	assert.equal(result.messages.find(({ toolCallId }) => toolCallId === 'outside-resume-scope')?.skipped, true);
	assert.equal(await readFile(join(cwd, 'A.md'), 'utf8'), '甲');
	assert.equal((await stat(join(cwd, 'A.md'))).mtimeMs, aBefore.mtimeMs);
	assert.equal(await readFile(join(cwd, 'B.md'), 'utf8'), '乙');
	await assert.rejects(access(join(cwd, '额外.md')), { code: 'ENOENT' });
	const runs = (await reopened.openConversation(id))?.runs;
	assert.equal(runs?.length, 1);
	assert.equal(runs[0]?.state.taskId, old.taskId);
	assert.equal(runs[0]?.state.status, 'done');
	assert.equal(runs[0]?.state.messages.at(-1)?.content, '两篇已完成。');
	assert.equal(runs[0]?.state.resumed, true);
	assert.equal(runs[0]?.state.messages.filter(({ role }) => role === 'user').length, 1);
	await assert.rejects(reopened.resume(id, old.taskId).result, /无法从此处继续任务/);
});

void test('a long task resumes with saved evidence and does not replay a compacted write', { timeout: 5_000 }, async (t) => {
	const { cwd, connect } = await fixture(t);
	const source = '交接原始记录.md';
	const evidence = 'SOURCE-EVIDENCE-218';
	const target = '交接清单.md';
	const written = '第一项核验已完成。';
	await writeFile(join(cwd, source), `原始核验编号为 ${evidence}。`);
	const read = (path: string): ToolCall => ({ id: path, name: 'Read', input: { file_path: path } });
	const write = { id: 'original-write', name: 'Write', input: { file_path: target, content: written } };
	const laterBatches = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
		const detail = `材料-${index}.md`;
		const check = `核验-${index}.md`;
		await writeFile(join(cwd, detail), `DETAIL-${index} ${'item '.repeat(160)} END-DETAIL-${index}`);
		await writeFile(join(cwd, check), `CHECK-${index}`);
		return [read(detail), read(check)];
	}));
	const batches = [[read(source), write], ...laterBatches];
	const handoff = `已核验 ${evidence}，见 [[${source}]]。已创建 ${target}。下一步核对剩余材料。`;
	const auxiliary: ModelRequest[] = [];
	const service: Pick<ModelService, 'send' | 'contextLimits'> = {
		contextLimits: () => ({ contextWindow: 12_000, maxTokens: 1_024 }),
		async send(request) {
			auxiliary.push(request);
			return reply(handoff).result();
		},
	};
	let compactedRequest: ModelRequest | undefined;
	const original = connect((request) => {
		if (request.messages.some(({ content }) => content.includes(handoff))) {
			compactedRequest = request;
			original.pause(active.taskId);
			return reply('');
		}
		const batch = batches.shift();
		return batch ? reply(batch.includes(write) ? '' : 'Verified item. '.repeat(150), batch) : reply('已读完材料。');
	}, firstModel, undefined, service);
	t.after(() => original.dispose());
	const conversationId = await original.createConversation();
	const active = original.submit({ conversationId, instruction: `请读取 ${source} 核验材料并创建 ${target}。`, refs: [] },
		{}, undefined, { executionMode: 'ask' });
	const paused = await active.result;
	assert.equal(paused.status, 'interrupted', paused.error);
	assert.ok(compactedRequest);
	assert.equal(auxiliary.length, 1);
	const summaryInput = auxiliary[0]!;
	assert.match(summaryInput.system ?? '', /当前任务[\s\S]*交接|交接[\s\S]*当前任务/u);
	const material = summaryInput.messages.map(({ content }) => content).join('\n');
	assert.ok(material.includes(`${source}（第 1–1 行）`) && material.includes(evidence) && material.includes(`已创建 ${target}。`));
	assert.deepEqual(summaryInput.tools, []);
	assert.equal(compactedRequest.messages.some(({ toolCallId }) => toolCallId === source || toolCallId === write.id), false);
	const latest = laterBatches.find((batch) => batch.at(-1)?.id === compactedRequest?.messages.at(-1)?.toolCallId);
	assert.ok(latest);
	assert.equal(await readFile(join(cwd, target), 'utf8'), written);
	const writtenAt = (await stat(join(cwd, target))).mtimeMs;
	original.dispose();

	const sent: ModelRequest[] = [];
	const reopened = connect((request) => {
		const stream = sent.length ? reply('核验完成。') : reply('', [{ ...write, id: 'repeat-write' }]);
		return {
			...stream,
			async *[Symbol.asyncIterator]() {
				assert.ok(request.beforeSend);
				await request.beforeSend('http://127.0.0.1:14080/v1/chat/completions');
				sent.push(request);
				yield* stream;
			},
		};
	}, firstModel, undefined, service);
	t.after(() => reopened.dispose());
	const saved = (await reopened.openConversation(conversationId))?.runs[0];
	assert.equal(saved?.runSummary?.text, handoff);
	assert.ok(saved.runSummary.throughMessage > 0 && saved.runSummary.throughMessage < saved.state.messages.length);
	assert.equal(saved.state.messages.find(({ toolCallId }) => toolCallId === write.id)?.isError, false);
	assert.ok(saved.state.messages.find(({ toolCallId }) => toolCallId === source)?.content.includes(evidence));
	let confirmations = 0;
	const result = await reopened.resume(conversationId, active.taskId, {
		async confirmResume({ request }) {
			confirmations++;
			assert.equal(auxiliary.length, 1);
			assert.deepEqual(sent, []);
			assert.ok(request.messages.some(({ content }) => content.includes(handoff)));
			assert.ok(request.messages.some(({ toolCalls }) => toolCalls?.every(({ id }, index) => id === latest[index]?.id)
				&& toolCalls.length === latest.length));
			for (const { id } of latest) {
				const originalResult: Message | undefined = saved.state.messages.find(({ toolCallId }) => toolCallId === id);
				assert.ok(originalResult);
				assert.deepEqual(request.messages.find(({ toolCallId }) => toolCallId === id), originalResult);
			}
			return true;
		},
	}, { executionMode: 'ask' }).result;
	assert.equal(confirmations, 1);
	assert.equal(result.status, 'done', result.error);
	assert.equal(result.messages.at(-1)?.content, '核验完成。');
	assert.equal(result.messages.find(({ toolCallId }) => toolCallId === 'repeat-write')?.skipped, true);
	assert.equal(await readFile(join(cwd, target), 'utf8'), written);
	assert.equal((await stat(join(cwd, target))).mtimeMs, writtenAt);
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
		: 'resuming twice preserves both an unexecuted edit result and the final reply', async (t) => {
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
		const finalText = repair ? '标题和正文修改已完成。' : '标题已修改。正文修改在上次中断时未执行。';
		const finish = reply(finalText);
		const replies = repair ? [
			reply('', [{ ...read, id: 'read-again' }]),
			reply('', [repeat, overwrite, { ...body, id: 'body-again', input: { ...body.input, replace_all: false } }]),
			finish,
		] : [finish];
		let firstRequest: ModelRequest | undefined;
		const reopened = connect((request) => {
			firstRequest ??= request;
			const next = replies.shift();
			assert.ok(next);
			return next;
		});
		const approvals: Array<string | undefined> = [];
		const result = await reopened.resume(conversationId, run.taskId, { async approve(preview) {
			approvals.push(preview.after);
			return true;
		} }).result;
		assert.equal(result.status, 'done', result.error);
		assert.equal(result.messages.at(-1)?.content, finalText);
		const skippedBody = firstRequest?.messages.find(({ toolCallId }) => toolCallId === body.id);
		assert.equal(skippedBody?.skipped, true);
		assert.equal(skippedBody?.isError, true);
		assert.match(skippedBody?.content ?? '', /退出前未执行/);
		assert.deepEqual(approvals, repair ? ['新标题\n新正文\n'] : []);
		assert.equal(await readFile(join(cwd, file), 'utf8'), repair ? '新标题\n新正文\n' : '新标题\n旧正文\n');
		assert.equal(replies.length, 0);
		if (repair) {
			const skipped = result.messages.filter((message) => message.skipped).map((message) => message.toolCallId);
			assert.deepEqual(skipped, ['body', 'repeat-title', 'overwrite']);
			assert.equal(result.messages.find((message) => message.toolCallId === 'body-again')?.isError, false);
		} else {
			assert.equal(result.messages.find(({ toolCallId }) => toolCallId === body.id)?.skipped, true);
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
	assert.equal(result.status, 'done', result.error);
	assert.equal(result.messages.at(-1)?.content, '已续做。');
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
