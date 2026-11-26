import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { AuxiliaryUsage, ConversationEntry, Message, ModelService, QueuedMessage, SubagentRecord } from '../../types';
import { createConversationStore } from '../storage/conversationStore';
import { replayConversation } from '../storage/taskStore';
import { conversationHistory } from '../context/conversationHistory';

import { guardModelConnection, queuedModelDestination } from '../settings/modelConnection';
import { manualConversationSummary } from '../context/manualConversationSummary';
import { createSubagentController } from '../subagents/controller';
import { normalizeSettings } from '../settings/defaults';
import { runUsage } from '../../interaction/chatMetrics';

async function fixture(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), 'scribe-conversation-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	return { directory, store: createConversationStore(directory) };
}

function start(conversationId: string, id: string, instruction: string): Extract<ConversationEntry, { type: 'start' }> {
	return {
		type: 'start',
		task: {
			id, request: { conversationId, instruction, refs: [{ path: 'note.md' }] },
			status: 'pending', createdAt: 1, updatedAt: 1,
		},
		model: { providerId: 'test-provider', model: 'test-model' },
	};
}

function messages(taskId: string, ...items: Message[]): Extract<ConversationEntry, { type: 'messages' }> {
	return { type: 'messages', taskId, messages: items };
}

function queued(conversationId: string, id: string, instruction: string): QueuedMessage {
	return { id, request: { conversationId, instruction, refs: [] } };
}

function subagent(agentId: string, record: SubagentRecord): Extract<ConversationEntry, { type: 'subagent' }> {
	return { type: 'subagent', agentId, record };
}

void test('subagent results stay separate from the main chat and a fork keeps only the recorded prefix', async (t) => {
	const { directory, store } = await fixture(t);
	const id = 'subagent-chat';
	const parent = start(id, 'main', '查找并归纳资料');
	const worker = start(id, 'child-run', '检查读书笔记');
	await store.append(id, [parent, subagent('scout', { kind: 'create', agent: {
		id: 'scout', rootTaskId: parent.task.id, name: '查找资料', role: 'explorer', model: worker.model,
	} }), subagent('scout', { kind: 'run', entry: worker }),
	subagent('scout', { kind: 'run', entry: messages(worker.task.id, { role: 'user', content: '检查读书笔记' }) }),
	{ type: 'finish', taskId: parent.task.id, status: 'done', turn: 1 }]);
	await store.append(id, [start(id, 'next', '另一个问题')]);
	await store.append(id, [
		subagent('scout', { kind: 'run', entry: messages(worker.task.id, { role: 'assistant', content: '后台结论' }) }),
		subagent('scout', { kind: 'run', entry: { type: 'finish', taskId: worker.task.id, status: 'done', turn: 1 } }),
		subagent('scout', { kind: 'note', note: { id: 'report', from: 'scout', to: 'root', text: '后台结论', kind: 'result' } }),
		subagent('scout', { kind: 'delivered', ids: ['report'] }),
	]);

	const reopened = createConversationStore(directory);
	const original = await reopened.load(id);
	assert.deepEqual(original.runs.map(({ state }) => state.taskId), ['main', 'next']);
	assert.equal(original.runs[0]?.state.messages.length, 0);
	const childRuns = async (conversationId: string) => {
		const saved = (await reopened.load(conversationId)).subagents ?? [];
		return (await replayConversation(conversationId, saved.flatMap(({ record }) => record.kind === 'run' ? [record.entry] : []))).runs;
	};
	assert.equal((await childRuns(id))[0]?.state.messages.at(-1)?.content, '后台结论');
	const branch = await reopened.fork(id, 'main');
	const [branchedWorker] = await childRuns(branch.id);
	assert.equal(branchedWorker?.state.status, 'interrupted');
	assert.equal(branchedWorker?.request.conversationId, branch.id);
	assert.deepEqual(branchedWorker?.state.messages.map(({ content }) => content), ['检查读书笔记']);
	assert.equal(branch.subagents?.some(({ record }) => record.kind === 'note'), false);

	await reopened.replaceFrom(id, 'main', [start(id, 'replacement', '更换原任务')]);
	await assert.rejects(store.append(id, [subagent('scout', { kind: 'visibility', closed: true })]), /不属于此对话/);
	assert.equal((await reopened.load(id)).subagents, undefined);
	assert.equal((await childRuns(branch.id)).length, 1);
});

void test('a rejected subagent record leaves the whole append batch unwritten', async (t) => {
	const { store } = await fixture(t);
	const parent = start('primary', 'parent-task', '查询资料');
	const scout = subagent('scout', { kind: 'create', agent: { id: 'scout', rootTaskId: parent.task.id,
		name: '资料搜索', role: 'explorer', model: parent.model } });
	await store.append('primary', [parent]);
	await assert.rejects(store.append('other', [scout]), /所属任务无效/);
	await assert.rejects(store.append('primary', [scout, subagent('scout', { kind: 'run', entry: start('other', 'child', '误投') })]),
		/不属于此对话/);
	assert.equal((await store.load('primary')).subagents, undefined);
	await store.append('primary', [scout, subagent('scout', { kind: 'run', entry: start('primary', 'child', '查找') })]);
	await assert.rejects(store.append('primary', [subagent('scout', { kind: 'delivered', ids: ['missing'] })]), /找不到/);
	assert.equal((await store.load('primary')).subagents?.length, 2);
	await store.append('primary', [subagent('reader', { kind: 'create', agent: { id: 'reader', parentId: 'scout',
		rootTaskId: parent.task.id, name: '阅读资料', role: 'explorer', model: parent.model } }),
	subagent('reader', { kind: 'note', note: { id: 'nested-result', from: 'reader', to: 'scout', text: '子任务结论', kind: 'result' } }),
	subagent('reader', { kind: 'delivered', ids: ['nested-result'] })]);
	assert.equal((await store.load('primary')).subagents?.length, 5);
});

void test('an automatic report is saved once after its receipt and all its child runs finish', async (t) => {
	const { directory, store } = await fixture(t);
	const id = 'automatic-report';
	const main = start(id, 'main', '分别整理两个主题');
	const agents = ['agent-one', 'agent-two'];
	await store.append(id, [main, ...agents.flatMap((agentId) => [
		subagent(agentId, { kind: 'create', agent: {
			id: agentId, rootTaskId: main.task.id, name: agentId, role: 'default', model: main.model,
		} }),
		subagent(agentId, { kind: 'run', entry: start(id, `work-${agentId}`, '整理主题') }),
	])]);
	const sendReport: ConversationEntry = { type: 'subagent-report', taskId: main.task.id,
		report: { content: '## 主题一\n\n第一份结果\n\n## 主题二\n\n第二份结果', sentAt: 10 } };
	const receipt = (deliveryAgents: string[]) =>
		messages(main.task.id, { role: 'assistant', content: '已收到。', local: true, deliveryAgents });
	await assert.rejects(store.append(id, [receipt([agents[0]!, agents[0]!])]), /收件确认的格式无效/);
	await assert.rejects(store.append(id, [messages(main.task.id, { role: 'assistant', content: '未授权', deliveryAgents: agents })]),
		/收件确认的格式无效/);
	await assert.rejects(store.append(id, [receipt(['missing'])]), /关联的后台任务无效/);
	await store.append(id, [receipt(agents)]);
	const finish = (agentId: string) => subagent(agentId, { kind: 'run',
		entry: { type: 'finish', taskId: `work-${agentId}`, status: 'done', turn: 1 } });
	await store.append(id, [finish(agents[0]!)]);
	await assert.rejects(store.append(id, [sendReport]), /任务或记录顺序无效/);
	await store.append(id, [{ type: 'finish', taskId: main.task.id, status: 'done', turn: 0, finishedAt: 4 }]);
	await assert.rejects(store.append(id, [sendReport]), /任务或记录顺序无效/);

	// 下一轮已经开始时，报告仍回到最初给出收件确认的任务。
	const later = start(id, 'later', '另一个问题');
	await store.append(id, [later, finish(agents[1]!)]);
	await assert.rejects(store.append(id, [{ ...sendReport, report: { content: ' ', sentAt: 10 } }]), /回传的格式无效/);
	await assert.rejects(store.append('other-chat', [sendReport]), /任务或记录顺序无效/);
	await assert.rejects(store.append(id, [subagent(agents[0]!, { kind: 'run', entry: sendReport } as unknown as SubagentRecord)]),
		/子 Agent 记录格式无效/);
	const results = await Promise.allSettled([store.append(id, [sendReport]), store.append(id, [sendReport])]);
	assert.deepEqual(results.map(({ status }) => status), ['fulfilled', 'rejected']);

	const reopened = createConversationStore(directory);
	const [first, second] = (await reopened.load(id)).runs;
	assert.equal(first?.state.status, 'done');
	assert.equal(first?.state.finishedAt, 4);
	assert.deepEqual(first?.state.messages[0]?.deliveryAgents, agents);
	assert.deepEqual(first?.subagentReport, sendReport.report);
	assert.equal(second?.subagentReport, undefined);

	const prefix = await reopened.fork(id, main.task.id);
	assert.equal(prefix.runs[0]?.subagentReport, undefined);
	const branch = await reopened.fork(id, later.task.id);
	assert.deepEqual(branch.runs[0]?.subagentReport, sendReport.report);
	await reopened.replaceFrom(id, main.task.id, [start(id, 'replacement', '更换原任务')]);
	await assert.rejects(store.append(id, [sendReport]), /任务或记录顺序无效/);
	assert.equal((await reopened.load(id)).runs[0]?.subagentReport, undefined);
	assert.deepEqual((await reopened.load(branch.id)).runs[0]?.subagentReport, sendReport.report);
});

void test('后台汇总、进展小结和分批整理共享同一用量记录，重开与复用不额外计数', { timeout: 5000 }, async (t) => {
	const { store, directory } = await fixture(t);
	const id = 'summary-chat';
	const parent = start(id, 'main', '主题'.repeat(230));
	const model = parent.model;
	const origin = 'https://example.test';
	const modelConnection: ModelService['modelConnection'] = () => ({ baseUrl: origin, api: 'openai-completions', source: 'configured' });
	const reportDestination = queuedModelDestination(model, modelConnection);
	await store.append(id, [parent,
		subagent('worker', { kind: 'create', modelOrigin: origin, reportDestination, agent: { id: 'worker', rootTaskId: 'main', name: '资料', role: 'worker', model } }),
		subagent('worker', { kind: 'run', entry: start(id, 'child', '查资料') }),
		subagent('worker', { kind: 'run', entry: messages('child', { role: 'assistant', content: '已核对' }) }),
		subagent('worker', { kind: 'run', entry: { type: 'finish', taskId: 'child', status: 'done', turn: 1 } }),
		messages('main', { role: 'assistant', content: '收件回执', local: true, deliveryAgents: ['worker'] }),
		{ type: 'finish', taskId: 'main', status: 'done', turn: 1 },
	]);
	const sent: string[] = [];
	const service: Pick<ModelService, 'send' | 'modelOrigin' | 'modelConnection' | 'contextLimits'> = {
		modelConnection, modelOrigin: () => origin,
		contextLimits: () => ({ contextWindow: 4096, maxTokens: 512 }),
		async send(request) {
			await request.beforeSend?.(origin + '/chat');
			sent.push(request.messages[0]!.content);
			return { content: '正式的汇总结论', toolCalls: [], stopReason: 'end', reportedUsage: { total: 10 },
				raw: { role: 'assistant', provider: 'test', api: 'openai-completions', model: 'test', content: [], timestamp: 1, stopReason: 'stop',
					usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } };
		},
	};
	const settings = normalizeSettings({ ...model, providerModels: { [model.providerId]: ['another', model.model] } });
	const checkModel = guardModelConnection(settings, model);
	for (const changes of ['disabled', 'changed', 'legacy'] as const) {
		const copy = changes + '-summary';
		const records: ConversationEntry[] = [
			start(copy, 'main', '原问题'),
			subagent('worker', { kind: 'create', modelOrigin: origin, reportDestination: changes === 'legacy' ? undefined : reportDestination,
				agent: { id: 'worker', rootTaskId: 'main', name: '资料', role: 'worker', model } }),
			subagent('worker', { kind: 'run', entry: start(copy, 'child', '查资料') }),
			subagent('worker', { kind: 'run', entry: messages('child', { role: 'assistant', content: '本地完成的原稿' }) }),
			subagent('worker', { kind: 'run', entry: { type: 'finish', taskId: 'child', status: 'done', turn: 1 } }),
			messages('main', { role: 'assistant', content: '已收到', local: true, deliveryAgents: ['worker'] }),
			{ type: 'finish', taskId: 'main', status: 'done', turn: 1 },
		];
		await store.append(copy, records);
		const restored = createSubagentController({ ...settings, disabledProviderIds: changes === 'disabled' ? [model.providerId] : [] },
			store, () => assert.fail('不应重启已完成的子任务'), (value) => value, {
				...service, modelConnection: changes === 'changed' ? () => ({ ...modelConnection(model.providerId, model.model), baseUrl: origin + '/other' }) : modelConnection,
			});
		const ready = new Promise<void>((resolve) => {
			const unsubscribe = restored.controls.subscribe(copy, () => {
				if (restored.controls.snapshot(copy).reports?.main) { unsubscribe(); resolve(); }
			});
		});
		await restored.controls.load(copy);
		await ready;
		restored.dispose();
		assert.match((await store.load(copy)).runs[0]?.subagentReport?.content ?? '', /本地完成的原稿/u);
		assert.equal(sent.length, 0);
	}
	const controller = createSubagentController(settings, store, () => assert.fail('不应重启已完成的子任务'), (value) => value, service);
	t.after(() => controller.dispose());
	const ready = new Promise<void>((resolve) => {
		const unsubscribe = controller.controls.subscribe(id, () => {
			if (controller.controls.snapshot(id).reports?.main) { unsubscribe(); resolve(); }
		});
	});
	await controller.controls.load(id);
	await ready;
	const record = (taskId: string, usage: AuxiliaryUsage) => store.append(id, [{ type: 'auxiliary-usage', taskId, usage }]);
	const snapshot = await store.load(id);
	assert.equal(sent.length, 1);
	const smallModel = { ...service, contextLimits: () => ({ contextWindow: 2300, maxTokens: 250 }) };
	for (const mode of ['recap', 'compact'] as const) {
		const before = sent.length;
		await manualConversationSummary(snapshot, smallModel, model, mode, new AbortController().signal, record, checkModel);
		assert.ok(sent.length - before > 1);
		assert.match(sent.slice(before).join(''), /正式的汇总结论/u);
		assert.doesNotMatch(sent.slice(before).join(''), /收件回执/u);
	}
	const reopened = (await createConversationStore(directory).load(id)).runs[0]!;
	assert.equal(runUsage(reopened.state)?.byKind.summary?.count, sent.length);
	assert.equal(runUsage(reopened.state)?.total, 10 * sent.length);
	await controller.reload(id);
	assert.equal(sent.length, reopened.state.auxiliaryUsage?.length);
	settings.providerModels[model.providerId] = ['another'];
	await assert.rejects(manualConversationSummary(snapshot, smallModel, model, 'compact', new AbortController().signal, record, checkModel), /连接设置已变更/u);
	assert.equal(sent.length, reopened.state.auxiliaryUsage?.length);
	await store.replaceFrom(id, 'main', [start(id, 'replacement', '更换原任务')]);
	await assert.rejects(record('main', { kind: 'summary' }), /任务已变更/u);
	assert.equal((await store.load(id)).runs[0]?.state.auxiliaryUsage, undefined);
});

void test('saved conversations can be listed, reopened and appended independently', async (t) => {
	const { directory, store } = await fixture(t);
	assert.equal(await store.lastOpened(), undefined);
	assert.deepEqual(await store.list(), []);
	await store.append('first', [start('first', 'one', '整理\n 笔记')]);
	await Promise.all([
		store.append('first', [messages('one', { role: 'user', content: '整理笔记' })]),
		store.append('first', [messages('one', { role: 'assistant', content: '已整理' })]),
		store.append('first', [{ type: 'finish', taskId: 'one', status: 'done', turn: 1 }]),
	]);
	await store.append('second', [start('second', 'two', '另一个会话')]);
	await Promise.all([store.setLastOpened('second'), store.setLastOpened('first')]);

	const reopened = createConversationStore(directory);
	assert.equal(await reopened.lastOpened(), 'first');
	assert.deepEqual(new Map((await reopened.list()).map((chat) => [chat.id, chat.title])),
		new Map([['second', '另一个会话'], ['first', '整理 笔记']]));
	const [run] = (await reopened.load('first')).runs;
	assert.ok(run);
	assert.equal(run.state.status, 'done');
	assert.deepEqual(run.state.messages.map((message) => message.content), ['整理笔记', '已整理']);
	assert.equal(run.model.model, 'test-model');
	await reopened.append('first', [start('first', 'three', '用原来的内容继续')]);
	assert.equal((await store.load('first')).runs.length, 2);
	assert.equal((await store.load('second')).runs.length, 1);
});

void test('a saved goal is discoverable before its first round and deletion fences off late writes', async (t) => {
	const { directory, store } = await fixture(t);
	const id = 'goal-chat';
	const goal = { objective: '检查会议纪要', status: 'active' as const, usedRounds: 0, totalRounds: 0 };
	const reopened = createConversationStore(directory);
	assert.equal(await reopened.loadGoal(id), undefined);
	const saving = store.saveGoal(id, goal);
	const loading = reopened.loadGoal(id);
	await saving;
	assert.equal((await loading)?.status, 'active');
	assert.deepEqual((await reopened.list()).map(({ title }) => title), [goal.objective]);
	assert.equal((await reopened.load(id)).hasGoal, true);
	await reopened.rename(id, '会后整理');
	await reopened.setArchived(id, true);
	assert.equal((await reopened.list())[0]?.title, '会后整理');
	assert.equal((await reopened.list())[0]?.archived, true);

	await store.saveGoal(id, null);
	assert.equal(await reopened.loadGoal(id), null);
	assert.deepEqual(await reopened.list(), []);

	await store.saveGoal(id, goal);
	await store.append(id, [start(id, 'goal-round', goal.objective)]);
	const fork = await reopened.fork(id, 'goal-round');
	assert.equal(await reopened.loadGoal(fork.id), undefined);
	const deleting = reopened.delete(id);
	await Promise.all([deleting, assert.rejects(store.saveGoal(id, goal), /已删除/)]);
	assert.equal(await reopened.loadGoal(id), null);
	assert.deepEqual(await readdir(directory), [`${fork.id}.jsonl`]);
});

void test('renaming keeps the original transcript and ordering, and deletion removes only the selected chat', async (t) => {
	const { directory, store } = await fixture(t);
	await store.append('first', [start('first', 'one', '原始任务')]);
	await store.append('second', [start('second', 'two', '另一个会话')]);
	await store.setLastOpened('second');
	const before = await store.list();
	const log = await readFile(join(directory, 'first.jsonl'), 'utf8');
	await assert.rejects(store.rename('first', '   '), /对话名称/);
	await assert.rejects(store.rename('first', '字'.repeat(121)), /对话名称/);
	await store.rename('first', '  笔记整理 计划  一  ');
	const reopened = createConversationStore(directory);
	assert.deepEqual(await reopened.list(), before.map((item) => item.id === 'first'
		? { ...item, title: '笔记整理 计划  一' } : item));
	assert.equal(await readFile(join(directory, 'first.jsonl'), 'utf8'), log);
	assert.equal((await reopened.load('first')).runs[0]?.request.instruction, '原始任务');

	const deleting = reopened.delete('first');
	const lateWrite = assert.rejects(store.append('first', [start('first', 'late', '不能恢复')]), /已删除/);
	await Promise.all([deleting, lateWrite]);
	assert.equal(await reopened.lastOpened(), 'second');
	assert.deepEqual((await reopened.list()).map(({ id }) => id), ['second']);
	assert.deepEqual((await readdir(directory)).sort(), ['last-opened', 'second.jsonl']);
	await reopened.delete('second');
	assert.equal(await reopened.lastOpened(), undefined);
	assert.deepEqual(await readdir(directory), []);
});

void test('history summaries follow the saved conversation prefix when reopening, forking or editing', async (t) => {
	const { directory, store } = await fixture(t);
	const id = 'history-summary';
	const summary = { throughTaskId: 'earlier', text: '确认周五发布，出处 [[项目/会议.md]]。' };
	await store.append(id, [
		start(id, 'earlier', '确认周五发布'),
		messages('earlier', { role: 'user', content: '确认周五发布' }),
		{ type: 'finish', taskId: 'earlier', status: 'done', turn: 1 },
		start(id, 'summarized', '继续核对'),
		{ type: 'history-summary', taskId: 'summarized', summary },
		{ type: 'finish', taskId: 'summarized', status: 'done', turn: 1 },
	]);
	const reopened = createConversationStore(directory);
	assert.deepEqual((await reopened.load(id)).runs[1]?.historySummary, summary);
	assert.deepEqual((await reopened.load(id)).runs[0]?.state.messages.map(({ content }) => content), ['确认周五发布']);
	assert.equal((await reopened.fork(id, 'earlier')).runs[0]?.historySummary, undefined);
	const branch = await reopened.fork(id, 'summarized');
	assert.deepEqual((await reopened.load(branch.id)).runs[1]?.historySummary, summary);
	await reopened.replaceFrom(id, 'earlier', [start(id, 'revised', '改为周一发布')]);
	assert.doesNotMatch(await readFile(join(directory, `${id}.jsonl`), 'utf8'), /周五发布/u);
	assert.equal((await reopened.load(id)).runs[0]?.historySummary, undefined);
});

void test('archive can be reversed and manual compaction follows the saved fork boundary', async (t) => {
	const { directory, store } = await fixture(t);
	const id = 'manual-compaction';
	const summary = { throughTaskId: 'middle', text: '已确定周五发布。' };
	await store.append(id, [
		start(id, 'old', '过时记录'), messages('old', { role: 'user', content: '过时记录' }),
		{ type: 'finish', taskId: 'old', status: 'done', turn: 1 },
		start(id, 'middle', '周五发布'), messages('middle', { role: 'user', content: '周五发布' }),
		{ type: 'finish', taskId: 'middle', status: 'done', turn: 1 },
		start(id, 'new', '新内容'), messages('new', { role: 'user', content: '新内容' }),
	]);
	await store.saveManualCompaction(id, summary);
	await store.setArchived(id, true);
	const reopened = createConversationStore(directory);
	assert.equal((await reopened.list())[0]?.archived, true);
	const original = await reopened.load(id);
	assert.equal(original.runs.length, 3);
	assert.deepEqual(original.manualCompaction, summary);
	const { history, manualSummary } = conversationHistory(original);
	assert.doesNotMatch(JSON.stringify(history), /过时记录/u);
	assert.match(JSON.stringify(history), /新内容/u);
	assert.equal(manualSummary, summary.text);
	assert.equal((await reopened.fork(id, 'old')).manualCompaction, undefined);
	const branch = await reopened.fork(id, 'middle');
	assert.deepEqual((await reopened.load(branch.id)).manualCompaction, summary);
	await reopened.setArchived(id, false);
	assert.equal((await reopened.list()).find((row) => row.id === id)?.archived, undefined);
	await reopened.replaceFrom(id, 'middle', [start(id, 'revised', '改为周一发布')]);
	assert.equal((await reopened.load(id)).manualCompaction, undefined);
});

void test('history summaries reject oversized text and references to a later task', async (t) => {
	const { store } = await fixture(t);
	const id = 'invalid-summary';
	await store.append(id, [
		start(id, 'earlier', '早期问题'),
		start(id, 'later', '后面的提问'),
		{ type: 'history-summary', taskId: 'earlier', summary: { throughTaskId: 'later', text: '' } },
	]);
	await assert.rejects(store.load(id), /摘要超出原对话范围/u);
	const large = '超'.repeat(1_370);
	await store.append('oversized-summary', [
		start('oversized-summary', 'first', '早期问题'),
		start('oversized-summary', 'second', '后面的提问'),
		{ type: 'history-summary', taskId: 'second', summary: { throughTaskId: 'first', text: large } },
	]);
	await assert.rejects(store.load('oversized-summary'), /第 3 行/u);
});

void test('completed shell jobs survive reopening in their original conversation', async (t) => {
	const { directory, store } = await fixture(t);
	const original = 'job-chat';
	const other = 'other-chat';
	const bash = {
		id: 'b50b8242-cd9d-46d7-ad51-8ad38fcabb05', name: 'Bash', status: 'success',
		command: 'printf 原始首行；printf 原始末行', startedAt: 1_700_000_000_000,
		finishedAt: 1_700_000_602_000, exitCode: 0,
		content: '原始首行\n…（命令输出中间已截断）\n原始末行',
	} as const;
	const powershell = {
		id: 'dc214397-3260-493d-8558-cbf77304f7ff', name: 'PowerShell', status: 'timed-out',
		command: 'Write-Output 起始输出；Write-Error 末尾诊断', startedAt: 1_700_000_000_000,
		finishedAt: 1_700_000_600_000, exitCode: null,
		content: '命令已超时。\n起始输出\n…（命令输出中间已截断）\n末尾诊断',
	} as const;
	const separate = { ...bash, id: 'a22cc5cd-2681-474d-93a0-519081a821a0', content: '另一聊天的结果' };
	await store.append(original, [start(original, 'launch', '运行后台任务')]);
	await store.append(other, [start(other, 'other-task', '另一聊天')]);
	await Promise.all([
		store.shellJobHistory.save(original, bash),
		store.shellJobHistory.save(original, powershell),
		store.shellJobHistory.save(other, separate),
	]);

	const reopened = createConversationStore(directory);
	const originalJobs = async () => new Map((await reopened.shellJobHistory.list(original)).map((job) => [job.id, job]));
	const expected = new Map<string, typeof bash | typeof powershell>([[bash.id, bash], [powershell.id, powershell]]);
	assert.deepEqual(await originalJobs(), expected);
	assert.deepEqual(await reopened.shellJobHistory.list(other), [separate]);
	const branch = await reopened.fork(original, 'launch');
	assert.deepEqual(await reopened.shellJobHistory.list(branch.id), []);
	await reopened.rename(original, '后台结果');
	await reopened.replaceFrom(original, 'launch', [start(original, 'edited', '改写后的任务')]);
	assert.deepEqual(await originalJobs(), expected);

	await reopened.delete(original);
	assert.deepEqual(await createConversationStore(directory).shellJobHistory.list(original), []);
	await assert.rejects(store.shellJobHistory.save(original, bash), /已删除/);
	assert.deepEqual(await reopened.shellJobHistory.list(other), [separate]);
});

void test('shell job read state survives reopening and concurrent writes in the original conversation', async (t) => {
	const { directory, store } = await fixture(t);
	const owner = 'job-owner';
	const other = 'other-job-owner';
	const legacy = {
		id: 'b50b8242-cd9d-46d7-ad51-8ad38fcabb05', name: 'Bash', status: 'success', content: '旧结果',
	} as const;
	const viewed = {
		id: 'dc214397-3260-493d-8558-cbf77304f7ff', name: 'PowerShell', status: 'failed',
		content: '原始首行\n…（命令输出中间已截断）\n最后的报错',
	} as const;
	const pending = { ...legacy, id: 'a22cc5cd-2681-474d-93a0-519081a821a0', unread: true } as const;
	const separate = { ...pending, id: 'e999f2ae-8577-430a-a2ba-197d88023cdb' };
	const stillUnread = { ...pending, id: 'abda5163-d0b2-47f3-acc4-51027cac2578' };
	await store.append(owner, [start(owner, 'one', '运行后台任务')]);
	await store.append(other, [start(other, 'two', '另一聊天')]);
	await Promise.all([
		store.shellJobHistory.save(owner, legacy),
		store.shellJobHistory.save(owner, { ...viewed, unread: true }),
		store.shellJobHistory.save(owner, stillUnread),
		store.shellJobHistory.save(other, separate),
	]);
	const open = () => createConversationStore(directory).shellJobHistory;
	const unreadChats = async () => (await createConversationStore(directory).list())
		.filter(({ unreadResult }) => unreadResult).map(({ id }) => id).sort();
	const reopened = open();
	assert.deepEqual(await unreadChats(), [other, owner].sort());
	await reopened.markRead(other, viewed.id);
	assert.deepEqual(await reopened.list(owner), [legacy, { ...viewed, unread: true }, stillUnread]);
	await Promise.all([
		reopened.markRead(owner, viewed.id.toUpperCase()),
		store.shellJobHistory.save(owner, pending),
		store.shellJobHistory.markRead(owner, viewed.id),
	]);
	assert.deepEqual(await open().list(owner), [legacy, viewed, stillUnread, pending]);
	assert.deepEqual(await open().list(other), [separate]);
	await reopened.markRead(owner, pending.id);
	assert.deepEqual(await unreadChats(), [other, owner].sort());
	await reopened.markRead(owner, stillUnread.id);
	assert.deepEqual(await unreadChats(), [other]);

	await Promise.all([store.delete(owner), reopened.markRead(owner, pending.id)]);
	await reopened.markRead('missing-chat', separate.id);
	assert.deepEqual(await open().list(owner), []);
	assert.deepEqual((await readdir(directory)).sort(), [`${other}.jsonl`, `${other}.shell-jobs.json`]);
	await writeFile(join(directory, `${other}.shell-jobs.json`), '{');
	const [row] = await createConversationStore(directory).list();
	assert.equal(row?.id, other);
	assert.equal(row?.unreadResult, undefined);
});

void test('a torn tail cannot hide a completed result or revive a pending approval', async (t) => {
	const { directory, store } = await fixture(t);
	const readCall = { id: 'read1', name: 'Read', input: { file_path: 'note.md' } };
	const editCall = { id: 'edit1', name: 'Edit', input: { file_path: 'note.md' } };
	await store.append('journal', [
		start('journal', 'task', 'Find and edit'),
		messages('task', { role: 'user', content: 'Find and edit' }),
		{ type: 'step', taskId: 'task', step: { phase: 'model', turn: 1 } },
		messages('task', { role: 'assistant', content: '', toolCalls: [readCall, editCall] }),
		messages('task', { role: 'tool', content: '旧内容', toolCallId: readCall.id, toolName: readCall.name }),
		{ type: 'step', taskId: 'task', step: { phase: 'approval', turn: 1, call: editCall } },
	]);
	const file = join(directory, 'journal.jsonl');
	await appendFile(file, '{"type":"finish","status":"done","partial":"未写完');
	const reopened = createConversationStore(directory);
	const [interrupted] = (await reopened.load('journal')).runs;
	assert.ok(interrupted);
	assert.equal(interrupted.step?.phase, 'approval');
	assert.equal(interrupted.state.status, 'interrupted');
	assert.equal(interrupted.state.turn, 1);
	assert.equal(interrupted.state.messages.at(-1)?.content, '旧内容');
	assert.deepEqual(interrupted.state.pendingCalls, [editCall]);

	await reopened.append('journal', [start('journal', 'follow-up', '继续聊天')]);
	assert.doesNotMatch(await readFile(file, 'utf8'), /未写完/);
	const restored = (await reopened.load('journal')).runs;
	assert.deepEqual(restored.map((run) => run.state.taskId), ['task', 'follow-up']);
	assert.equal(restored[0]?.state.status, 'interrupted');
});

void test('committed malformed records and unsafe conversation IDs are rejected', async (t) => {
	const { directory, store } = await fixture(t);
	await assert.rejects(store.load('../escape'), /编号无效/);
	await assert.rejects(store.setLastOpened('../escape'), /编号无效/);
	await assert.rejects(store.rename('../escape', '随便一个名称'), /编号无效/);
	await assert.rejects(store.delete('../escape'), /编号无效/);
	await store.append('bad-log', [start('bad-log', 'task', 'Check history')]);
	await appendFile(join(directory, 'bad-log.jsonl'), 'invalid record\n');
	await store.append('bad-log', [{ type: 'finish', taskId: 'task', status: 'done', turn: 1 }]);
	await assert.rejects(store.load('bad-log'), /第 2 行/);
});

void test('a committed result advances a tool checkpoint even when the next record was torn', async (t) => {
	const { directory, store } = await fixture(t);
	const call = { id: 'edit', name: 'Edit', input: { file_path: 'note.md' } };
	await store.append('progress', [
		start('progress', 'task', 'Make a change'),
		messages('task', { role: 'assistant', content: '', toolCalls: [call] }),
		{ type: 'step', taskId: 'task', step: { phase: 'tool', turn: 1, call } },
		{
			type: 'messages', taskId: 'task',
			messages: [{ role: 'tool', content: '修改已完成。', toolCallId: call.id, toolName: call.name }],
			step: { phase: 'tool-result', turn: 1, call },
		},
	]);
	await appendFile(join(directory, 'progress.jsonl'), '{"type":"step","taskId"');
	const [run] = (await store.load('progress')).runs;
	assert.ok(run);
	assert.equal(run.state.status, 'interrupted');
	assert.equal(run.step?.phase, 'tool-result');
	assert.deepEqual(run.state.pendingCalls, []);
});

void test('queued messages keep their original content and order until a durable start or insert consumes them', async (t) => {
	const { directory, store } = await fixture(t);
	const first = queued('primary', 'queued-a', '第一条\n  保留空白 🌱');
	first.request.target = { kind: 'mcp', id: 'server', label: '服务' };
	const second = queued('primary', 'queued-b', '带资料的第二条');
	second.request.refs = [{ path: 'image.png' }, { path: 'note.md' }, { path: 'other.png' }];
	const other = queued('other', 'queued-a', '其他对话');
	await Promise.all([store.enqueue('primary', first), store.enqueue('primary', second), store.enqueue('other', other)]);

	const reopened = createConversationStore(directory);
	assert.deepEqual((await reopened.load('primary')).queue, [first, second]);
	assert.deepEqual(await reopened.getQueued('other'), [other]);
	assert.equal((await reopened.list()).find(({ id }) => id === 'primary')?.title, '第一条 保留空白 🌱');
	await assert.rejects(reopened.editQueued('primary', second.id, '不能修改文件'), /非文本/);
	await assert.rejects(reopened.editQueued('primary', first.id, '  '), /输入任务/);
	await assert.rejects(reopened.append('primary', [start('primary', 'task-b', '带资料的第二条')],
		{ messages: [second], fifo: true }), /顺序/);

	const edit = reopened.editQueued('primary', first.id, '修改后的消息\n下一行');
	const stale = start('primary', 'stale', first.request.instruction);
	stale.task.request.target = first.request.target;
	const staleStart = assert.rejects(reopened.append('primary', [stale], { messages: [first], fifo: true }), /已经变更/);
	await Promise.all([edit, staleStart]);
	assert.deepEqual((await reopened.load('primary')).runs, []);
	const edited = (await reopened.getQueued('primary'))[0]!;
	assert.equal(edited.request.instruction, '修改后的消息\n下一行');
	assert.deepEqual(edited.request.target, first.request.target);

	const log = join(directory, 'primary.jsonl');
	await appendFile(log, '{"type":"start","consumedQueueIds":["queued-a"]');
	assert.deepEqual(await reopened.getQueued('primary'), [edited, second]);

	const selectedRun = start('primary', 'task-a', edited.request.instruction);
	await assert.rejects(reopened.append('primary', [selectedRun], { messages: [edited], fifo: true }), /记录与排队消息不匹配/);
	selectedRun.task.request.target = edited.request.target;
	await reopened.append('primary', [selectedRun], { messages: [edited], fifo: true });
	assert.deepEqual(await reopened.getQueued('primary'), [second]);
	await assert.rejects(reopened.deleteQueued('primary', edited.id), /找不到/);
	const previous: Message = { id: 'assistant:task-a:1', role: 'assistant', content: '前一轮留下的思考', incomplete: true };
	const draft: Message = { id: 'assistant:task-a:2:retry:1', role: 'assistant', content: '', incomplete: true };
	const reply: Message = { id: draft.id, role: 'assistant', content: '插话后的回复' };
	await reopened.append('primary', [
		messages('task-a', previous),
		{ type: 'step', taskId: 'task-a', step: { phase: 'model', turn: 2 } },
		messages('task-a', draft),
	]);
	await assert.rejects(reopened.append('primary', [messages('task-a', { role: 'user', content: '未转交的正文' })],
		{ messages: [second] }), /记录与排队消息不匹配/);
	const steering: Message = { id: 'steer:queued-b', role: 'user', content: second.request.instruction };
	await reopened.append('primary', [messages('task-a', steering)], { messages: [second] });
	await reopened.append('primary', [messages('task-a', reply)]);
	const snapshot = await createConversationStore(directory).load('primary');
	assert.equal(snapshot.queue, undefined);
	assert.deepEqual(snapshot.runs[0]?.state.messages, [previous, steering, reply]);
	assert.deepEqual(snapshot.runs[0]?.request.target, first.request.target);
	const branch = await reopened.fork('primary', 'task-a');
	assert.deepEqual((await reopened.load(branch.id)).runs[0]?.state.messages, [previous, steering, reply]);
	assert.deepEqual(await reopened.getQueued('other'), [other]);
	await reopened.deleteQueued('other', other.id);
	assert.deepEqual(await createConversationStore(directory).getQueued('other'), []);
	assert.equal((await reopened.list()).some(({ id }) => id === 'other'), false);
});

void test('forking, editing history and deleting preserve isolation of pending messages', async (t) => {
	const { store } = await fixture(t);
	const first = queued('parent', 'used', '原来的消息');
	const pending = queued('parent', 'pending', '仍在排队');
	await store.enqueue('parent', first);
	await store.append('parent', [start('parent', 'original', first.request.instruction)], { messages: [first], fifo: true });
	await store.enqueue('parent', pending);

	const branch = await store.fork('parent', 'original');
	assert.equal(branch.runs[0]?.request.conversationId, branch.id);
	assert.deepEqual(await store.getQueued(branch.id), []);
	await store.replaceFrom('parent', 'original', [start('parent', 'edited', '改写历史')]);
	assert.deepEqual(await store.getQueued('parent'), [pending]);
	assert.equal((await store.load('parent')).runs[0]?.request.instruction, '改写历史');

	const deletion = store.delete('parent');
	const lateEnqueue = assert.rejects(store.enqueue('parent', pending), /已删除/);
	await Promise.all([deletion, lateEnqueue]);
	assert.deepEqual(await store.getQueued('parent'), []);
	assert.equal((await store.load(branch.id)).runs.length, 1);
});
