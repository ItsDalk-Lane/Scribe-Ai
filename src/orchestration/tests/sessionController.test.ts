import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import timers from 'node:timers';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import { confirmModelRequest } from '../../communication/modelRequestConfirmation';
import { createModelService } from '../../communication/providers';
import { finishGoalRound, goalRoundInstruction, reportGoalToolName, restoreChatGoal } from '../../interaction/chatGoal';
import type { ChatGoal } from '../../interaction/chatGoal';
import { approvedPlanRequest, submittedPlan } from '../../interaction/chatPlan';
import { conversationMetrics, runUsage } from '../../interaction/chatMetrics';
import { emptyExecution, restoreExecution, updateExecution } from '../../interaction/context';
import { createAgentLoop } from '../../runtime/agentLoop';
import { bindAgent } from '../../runtime/createAgent';
import { createModelCoordinator } from '../../runtime/modelCoordinator';
import { createRunState } from '../../runtime/runState';
import { createToolCoordinator } from '../../runtime/toolCoordinator';
import { fixtureToolIntents } from '../../runtime/tests/agentFixture';
import { createToolRegistry } from '../../tools';
import { createToolExecutor } from '../../tools/executor';
import { chatTaskTools } from '../../tools/chatTaskTools';
import { goalTools } from '../../tools/goalTool';
import { planTools } from '../../tools/planTools';
import { shellTools } from '../../tools/external/shellTool';
import { readTools } from '../../tools/readTools';
import { searchTools } from '../../tools/searchTools';
import { readOnlySkillTools, skillTools } from '../../tools/skillTools';
import { writeTools } from '../../tools/writeTools';
import { MissingConversationError, RetryableModelError } from '../../types';
import type { Message, ModelRequest, ModelService, ModelStream, ReportedUsage, RunState, RuntimeLayer, ScribeSettings, Task, TaskRequest, ToolCall } from '../../types';
import { createContextBuilder } from '../context/contextBuilder';
import { promptText } from '../context/promptXml';
import { createSkillRegistry } from '../context/skills';
import { createSessionController } from '../sessionController';
import { normalizeSettings } from '../settings/defaults';
import { queuedModelDestination } from '../settings/modelConnection';
import { chatModelKey } from '../settings/thinking';
import { createConversationStore } from '../storage/conversationStore';

const firstModel = { providerId: 'test-provider', model: 'first-model' };
const secondModel = { providerId: 'another-provider', model: 'second-model' };
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function requestText(request?: ModelRequest): string {
	return request?.messages.map(promptText).join('\n') ?? '';
}

function dialogMessages(request?: ModelRequest): Message[] {
	return (request?.messages ?? []).filter((message) => message.role !== 'user' || Boolean(message.content) || !message.promptSections?.length);
}

function activeMode(request: ModelRequest): string {
	return request.messages.flatMap(({ promptSections }) => promptSections ?? []).reverse().find(({ tag, text }) =>
		tag === 'system-reminder' && /^(?:本次为只读|当前权限模式为)/u.test(text))?.text ?? '';
}

function reply(content: string, toolCalls: ToolCall[] = [], billing?: { reportedUsage: ReportedUsage; total?: number }): ModelStream {
	toolCalls = fixtureToolIntents(toolCalls);
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
		connect: (stream: ModelService['stream'], model: Partial<ScribeSettings> = firstModel,
			thinkingOptions?: ModelService['thinkingOptions'], modelService?: Pick<ModelService, 'send' | 'contextLimits' | 'modelCapabilities' | 'modelOrigin'
				| 'modelType' | 'prepareModel' | 'withPreparedModels'> & Partial<Pick<ModelService, 'modelConnection'>>, withSkills = false, withPlanTools = false, withGoalTools = false) => {
			const settings = normalizeSettings(model);
			const skills = withSkills ? createSkillRegistry(app, settings, async () => {}, {
				draft: async () => false, install: async () => false,
			}) : undefined;
			// 工具列表不随本机是否装有 PowerShell 变化，否则按上下文余量触发的压缩在各平台结果不同。
			const registry = createToolRegistry([readTools, searchTools, writeTools, () => shellTools().filter(({ name }) => name === 'Bash'), chatTaskTools,
				...(skills ? [skillTools] : []), ...(withPlanTools ? [planTools] : []), ...(withGoalTools ? [goalTools] : [])]);
			const models = createModelCoordinator({ stream, contextLimits: modelService?.contextLimits }, createContextBuilder(registry));
			const tools = createToolCoordinator(app, createToolExecutor(registry));
			const runtime: RuntimeLayer = {
				newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools,
			};
			return createSessionController(app, settings, runtime, createConversationStore(directory), thinkingOptions, modelService, undefined, skills);
		},
	};
}

void test('video service converts an attachment, requires a media receipt, and restores the saved result', async (t) => {
	if (['ffmpeg', 'ffprobe'].some((tool) => spawnSync(tool, ['-version']).status !== 0)) {
		t.skip('FFmpeg and ffprobe are required for this integration test');
		return;
	}
	const { cwd, directory, connect } = await fixture(t);
	const path = 'example.avi';
	execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:size=64x64:rate=10', '-t', '1',
		'-c:v', 'mpeg4', join(cwd, path)]);
	const videoModel = secondModel;
	const settings = {
		...firstModel, videoModel,
		providerModels: { [firstModel.providerId]: [firstModel.model], [videoModel.providerId]: [videoModel.model] },
	};
	let confirmed = true;
	let videoCalls = 0;
	const service: Pick<ModelService, 'send' | 'modelOrigin' | 'modelCapabilities'> = {
		modelCapabilities: () => ({ structuredOutput: false, videoAnalysis: 'file' }),
		modelOrigin: () => 'https://video.example',
		async send(request) {
			videoCalls++;
			assert.equal(request.model, videoModel.model);
			assert.equal(request.messages.length, 1);
			assert.equal(request.tools.length, 0);
			const [file] = await request.video!.load(request.signal!);
			assert.equal(file?.mimeType, 'video/mp4');
			assert.equal(Buffer.from(file?.data ?? '', 'base64').toString('ascii', 4, 8), 'ftyp');
			await request.beforeSend?.('https://video.example/models/video:streamGenerateContent');
			return reply('[00:00] A red screen.', [], { reportedUsage: { prompt: 11, ...(confirmed && { videoInput: 10 }) } }).result();
		},
	};
	const mainRequests: ModelRequest[] = [];
	const answer = (request: ModelRequest) => {
		mainRequests.push(request);
		assert.equal(request.model, firstModel.model);
		assert.equal(request.video, undefined);
		assert.match(requestText(request), /\[00:00\] A red screen/u);
		return reply('主模型完成。');
	};
	const submits = connect(answer, settings, undefined, service);
	const id = await submits.createConversation();
	const task = { conversationId: id, instruction: '说明这个视频。', refs: [{ path, kind: 'file' as const }] };
	const active = submits.submit(task, { onEvent(event) {
		if (event.type === 'text-delta') submits.pause(active.taskId);
	} });
	const interrupted = await active.result;
	assert.equal(interrupted.status, 'interrupted', interrupted.error);
	const saved = (await createConversationStore(directory).load(id)).runs[0];
	assert.match(saved?.videoAnalysis ?? '', /\[00:00\] A red screen/u);
	assert.deepEqual(saved?.videoAnalysisSources, ['file']);
	assert.deepEqual(saved?.state.auxiliaryUsage?.filter(({ kind }) => kind === 'video').length, 1);
	assert.deepEqual(await readdir(join(cwd, '.scribe-ai', 'cache', id, 'root')), []);
	assert.equal(runUsage(interrupted)?.byKind.video?.count, 1);
	submits.dispose();

	const reopened = connect(answer, settings, undefined, service);
	t.after(() => reopened.dispose());
	assert.equal((await reopened.resume(id, active.taskId).result).status, 'done');
	assert.equal(videoCalls, 1);

	confirmed = false;
	const notDelivered = await reopened.submit({ ...task, conversationId: await reopened.createConversation() }).result;
	assert.equal(notDelivered.status, 'failed');
	assert.match(notDelivered.error ?? '', /服务商未确认处理视频输入/u);
	assert.equal(videoCalls, 2);
	assert.equal(mainRequests.length, 2);
	await writeFile(join(cwd, path), 'not a valid video');
	const corrupt = await reopened.submit({ ...task, conversationId: await reopened.createConversation() }).result;
	assert.equal(corrupt.status, 'failed');
	assert.match(corrupt.error ?? '', /无法读取视频格式/u);
	assert.equal(videoCalls, 2);
	assert.equal(mainRequests.length, 2);
});

void test('a link-only video model handles HTTPS embeds while local attachments follow their own setting', async (t) => {
	const { cwd, directory, connect } = await fixture(t);
	const remoteModel = { providerId: 'zhipu-fixture', model: 'glm-5.3-flash' };
	const link = 'https://media.example.invalid/clip.mov';
	const path = 'local.mp4';
	await writeFile(join(cwd, path), 'native local fixture');
	let requests = 0;
	const sessions = connect((request) => {
		assert.equal(request.model, firstModel.model);
		assert.equal(request.video?.hasFiles, true);
		assert.match(requestText(request), /\[00:01\] Link scene/u);
		return reply('处理完成。');
	}, {
		...firstModel, videoLinkModel: remoteModel,
		providerModels: { [firstModel.providerId]: [firstModel.model], [remoteModel.providerId]: [remoteModel.model] },
	}, undefined, {
		modelCapabilities: () => ({ structuredOutput: false, videoAnalysis: 'link' }),
		modelOrigin: () => 'https://video.example',
		async send(request) {
			requests++;
			assert.equal(request.model, remoteModel.model);
			assert.equal(request.video?.hasFiles, false);
			assert.deepEqual(await request.video?.load(request.signal!), [{ mimeType: 'video/quicktime', url: link }]);
			await request.beforeSend?.('https://video.example/chat/completions');
			return reply('[00:01] Link scene.', [], { reportedUsage: { videoInput: 31 } }).result();
		},
	});
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const task = { conversationId: id, instruction: '解析 ![片段](' + link + ')', refs: [{ path, kind: 'file' as const }] };
	const state = await sessions.submit(task).result;
	assert.equal(state.status, 'done', state.error);
	assert.equal(requests, 1);
	assert.deepEqual((await createConversationStore(directory).load(id)).runs[0]?.videoAnalysisSources, ['link']);
	const invalid = await sessions.submit({ ...task, instruction: task.instruction.replace('.mov', '.webm') }).result;
	assert.equal(invalid.status, 'failed');
	assert.match(invalid.error ?? '', /需要 MP4、MOV 或 MKV 的 HTTPS 直链/u);
	assert.equal(requests, 1);
});

void test('a model configured for generation cannot receive chat or video analysis requests', async (t) => {
	const { connect } = await fixture(t);
	const sessions = connect(() => assert.fail('unexpected chat request'), {
		...firstModel, videoLinkModel: secondModel,
		providerModels: { [firstModel.providerId]: [firstModel.model], [secondModel.providerId]: [secondModel.model] },
		modelOverrides: { [secondModel.providerId]: { [secondModel.model]: { type: 'video' } } },
	}, undefined, {
		modelCapabilities: () => ({ structuredOutput: false, videoAnalysis: 'link' }),
		modelOrigin: () => 'https://video.example',
		send: () => assert.fail('unexpected video analysis request'),
	});
	t.after(() => sessions.dispose());
	const conversationId = await sessions.createConversation();
	const request = { conversationId, instruction: '分析 ![片段](https://media.example.invalid/clip.mp4)', refs: [] };
	assert.throws(() => sessions.submit(request, {}, undefined, { model: secondModel }), /所选模型已不可用/u);
	const state = await sessions.submit(request).result;
	assert.equal(state.status, 'failed');
	assert.match(state.error ?? '', /视频解析模型已停用或连接已变更/u);
});

void test('video processing checkpoints each confirmed item and ignores quoted examples and appended plan links', async (t) => {
	const { directory, connect } = await fixture(t);
	const serviceModel = { providerId: 'video-fixture', model: 'link-model' };
	const urls = ['https://media.example.invalid/a.mp4', 'https://media.example.invalid/b.mp4'];
	const example = 'https://media.example.invalid/example.mp4';
	const objective = '解释 `![代码示例](' + example + ')`，并分析 ' + urls.map((url) => '![片段](' + url + ')').join(' ');
	const instruction = objective + '\n\n计划示例 ![计划](' + example + ')';
	const settings = { ...firstModel, videoLinkModel: serviceModel, providerModels: {
		[firstModel.providerId]: [firstModel.model], [serviceModel.providerId]: [serviceModel.model],
	} };
	const submitted: string[] = [];
	let fail = true;
	let pauseAtReceipt: (() => void) | undefined;
	function reopen() {
		return connect((request) => {
			const analysis = request.messages.flatMap(({ promptSections }) => promptSections ?? [])
				.find(({ tag, text }) => tag === 'reference-material' && text.includes('视频模型的带时间戳解析'));
			assert.ok(analysis);
			assert.match(analysis.text, /第一项/u);
			assert.match(analysis.text, /第二项/u);
			return reply('已完成');
		}, settings, undefined, {
			modelOrigin: () => 'https://video.example',
			modelCapabilities: () => ({ structuredOutput: false, videoAnalysis: 'link' }),
			async send(request) {
				assert.equal(request.messages[0]?.content, objective);
				const [video] = await request.video!.load(request.signal!);
				const url = video!.url!;
				submitted.push(url);
				if (url === urls[1] && fail) throw new Error('暂时不可用');
				pauseAtReceipt?.();
				return reply('[00:00] ' + (url === urls[0] ? '第一项' : '第二项'), [], { reportedUsage: { videoInput: 12 } }).result();
			},
		});
	}
	let sessions = reopen();
	const id = await sessions.createConversation();
	const task = { conversationId: id, instruction, imageLinkEnd: objective.length, refs: [] };
	assert.equal((await sessions.submit(task).result).status, 'failed');
	assert.equal((await createConversationStore(directory).load(id)).runs[0]?.videoItems?.length, 1);
	sessions.dispose();
	sessions = reopen();
	t.after(() => sessions.dispose());
	assert.equal((await sessions.submit(task).result).status, 'failed');
	fail = false;
	const finished = await sessions.submit(task).result;
	assert.equal(finished.status, 'done', finished.error);
	assert.deepEqual(submitted, [urls[0], urls[1], urls[1], urls[1]]);
	const otherId = await sessions.createConversation();
	const active = sessions.submit({ ...task, conversationId: otherId });
	pauseAtReceipt = () => sessions.pause(active.taskId);
	assert.equal((await active.result).status, 'interrupted');
	const savedItem = (await createConversationStore(directory).load(otherId)).runs[0]?.videoItems;
	assert.equal(savedItem?.length, 1);
	pauseAtReceipt = undefined;
	const resumed = await sessions.resume(otherId, active.taskId).result;
	assert.equal(resumed.status, 'done', resumed.error);
	assert.deepEqual(submitted.slice(4), urls);
});

void test('PDF attachments require a configured PDF connection and fail before sending the chat request', async (t) => {
	const { cwd, connect } = await fixture(t);
	const path = 'not-a-pdf.pdf';
	await writeFile(join(cwd, path), 'file name is not proof of format');
	const submit = async (selection?: typeof secondModel) => {
		const sessions = connect(() => assert.fail('PDF failure must stop the chat model'), {
			...firstModel, pdfModel: selection, providerModels: {
				[firstModel.providerId]: [firstModel.model], [secondModel.providerId]: [secondModel.model],
			},
		}, undefined, {
			modelOrigin: () => 'https://pdf.example',
			modelCapabilities: () => ({ structuredOutput: false, pdfAnalysis: true }),
			send: () => assert.fail('No PDF should leave the vault'),
		});
		t.after(() => sessions.dispose());
		return sessions.submit({ conversationId: await sessions.createConversation(), instruction: '分析资料', refs: [{ path, kind: 'file' }] }).result;
	};
	const missing = await submit();
	assert.equal(missing.status, 'failed');
	assert.match(missing.error ?? '', /服务 → PDF 解析/u);
	const invalid = await submit(secondModel);
	assert.equal(invalid.status, 'failed');
	assert.match(invalid.error ?? '', /缺少有效的 PDF 文件头/u);
});

void test('PDF analysis sends originals to the specialist, checkpoints reports, and hands off text on resume', async (t) => {
	const { cwd, directory, connect } = await fixture(t);
	const paths = ['one.PDF', 'two.pdf'];
	const contents = paths.map((path) => Buffer.from('%PDF-1.4\n%specialist bytes for ' + path));
	for (const [index, path] of paths.entries()) await writeFile(join(cwd, path), contents[index]!);
	const question = '请汇总两个 PDF 的页码和证据。';
	const settings = {
		...firstModel, pdfModel: secondModel, providerModels: {
			[firstModel.providerId]: [firstModel.model], [secondModel.providerId]: [secondModel.model],
		},
	};
	const calls: string[] = [];
	let pause: (() => void) | undefined;
	let destination = 'https://pdf.example/v1/responses';
	let pdfBase = 'https://pdf.example/v1';
	let mainCalls = 0;
	const modelConnection: ModelService['modelConnection'] = (_provider, model) => ({
		api: 'openai-responses', baseUrl: model === secondModel.model ? pdfBase : 'https://chat.example/v1', source: 'configured',
	});
	function reopen() {
		return connect((request) => {
			mainCalls++;
			assert.equal(request.model, firstModel.model);
			assert.equal(request.pdf, undefined);
			assert.match(requestText(request), /PDF 解析模型的资料报告/u);
			assert.match(requestText(request), /第 1 页：one\.PDF/u);
			assert.match(requestText(request), /第 1 页：two\.pdf/u);
			return reply('已汇总。');
		}, settings, undefined, {
			modelOrigin: () => 'https://pdf.example',
			modelConnection,
			modelCapabilities: (_provider, model) => ({ structuredOutput: false, pdfAnalysis: model === secondModel.model }),
			async send(request) {
				assert.equal(request.model, secondModel.model);
				assert.deepEqual(request.tools, []);
				assert.equal(request.messages[0]?.content, question);
				const { filename, data } = await request.pdf!.load(request.signal!);
				assert.deepEqual(Buffer.from(data, 'base64'), contents[paths.indexOf(filename)]);
				if (filename === paths[1]) pause?.();
				await request.beforeSend?.(destination);
				calls.push(filename);
				await request.onTransmission?.(destination);
				return reply('第 1 页：' + filename, [], { reportedUsage: { prompt: 31, output: 8 } }).result();
			},
		});
	}
	let sessions = reopen();
	const id = await sessions.createConversation();
	const refs = [...paths.map((path) => ({ path, kind: 'file' as const })), { path: 'folder.pdf', kind: 'folder' as const }];
	const task = { conversationId: id, instruction: question, refs };
	const first = sessions.submit(task);
	pause = () => sessions.pause(first.taskId);
	assert.equal((await first.result).status, 'interrupted');
	assert.deepEqual(calls, paths.slice(0, 1));
	assert.equal(mainCalls, 0);
	const stored = (await createConversationStore(directory).load(id)).runs[0];
	assert.equal(stored?.pdfItems?.[0]?.content, '第 1 页：one.PDF');
	assert.equal(runUsage(stored.state)?.byKind.pdf?.count, 1);
	sessions.dispose();
	sessions = reopen();
	t.after(() => sessions.dispose());
	pause = undefined;
	const resumed = await sessions.resume(id, first.taskId).result;
	assert.equal(resumed.status, 'done', resumed.error);
	assert.deepEqual(calls, paths);
	assert.equal(runUsage(resumed)?.byKind.pdf?.count, 2);
	assert.equal(mainCalls, 1);
	const completed = (await createConversationStore(directory).load(id)).runs[0];
	assert.equal(completed?.pdfItems?.length, 2);
	assert.equal(JSON.stringify(completed).includes(contents[0]!.toString('base64')), false);

	destination = 'https://pdf.example/other/responses';
	const rejected = await sessions.submit({ ...task, conversationId: await sessions.createConversation() }).result;
	assert.equal(rejected.status, 'failed');
	assert.match(rejected.error ?? '', /实际接收地址已变更/u);
	assert.deepEqual(calls, paths);
	assert.equal(mainCalls, 1);

	destination = 'https://pdf.example/v1/responses';
	const queuedId = await sessions.createConversation();
	const row = { id: 'pdf-queued', request: { ...task, conversationId: queuedId },
		destination: queuedModelDestination(firstModel, modelConnection), pdfDestination: queuedModelDestination(secondModel, modelConnection) };
	const store = createConversationStore(directory);
	await store.enqueue(queuedId, row);
	pdfBase = 'https://pdf.example/v2';
	await assert.rejects(sessions.submitQueued(row, {}, () => assert.fail('changed PDF route must leave the task queued')).result, /解析地址已变更/u);
	assert.deepEqual(await store.getQueued(queuedId), [row]);
	assert.deepEqual(calls, paths);
	pdfBase = 'https://pdf.example/v1';
	assert.equal((await sessions.submitQueued(row, {}, () => {}).result).status, 'done');
	assert.deepEqual(await store.getQueued(queuedId), []);
	assert.deepEqual(calls, [...paths, ...paths]);
	assert.equal(mainCalls, 2);
});

void test('a catalog tool denial hides tools and prevents an unsolicited model call from reading a file', async (t) => {
	const { cwd, connect } = await fixture(t);
	await writeFile(join(cwd, 'fact.md'), 'content-not-sent');
	const requests: ModelRequest[] = [];
	const sessions = connect((request) => {
		requests.push(request);
		return requests.length === 1 ? reply('', [{ id: 'read-one', name: 'Read', input: { file_path: 'fact.md' } }]) : reply('完成');
	}, firstModel, undefined, {
		send: async () => { throw new Error('Unexpected auxiliary request'); },
		modelCapabilities: () => ({ tools: false, structuredOutput: false }),
	});
	t.after(() => sessions.dispose());
	const state = await sessions.submit({ conversationId: await sessions.createConversation(), instruction: '读一下笔记', refs: [] }).result;
	assert.ok(requests.length);
	assert.ok(requests.every(({ tools }) => tools.length === 0));
	assert.ok(!JSON.stringify(state.messages).includes('content-not-sent'));
});

void test('a catalog route change cannot send the next turn of a running task to the new address', async (t) => {
	const { cwd, connect } = await fixture(t);
	await writeFile(join(cwd, 'fact.md'), '保留在原任务中的工具结果');
	let attempts = 0;
	let address = 'https://one.example/api';
	const sessions = connect(() => {
		attempts += 1;
		address = 'https://two.example/api';
		return reply('', [{ id: 'read-one', name: 'Read', input: { file_path: 'fact.md' } }]);
	}, firstModel, undefined, {
		send: async () => { throw new Error('Unexpected auxiliary request'); },
		modelConnection: () => ({ api: 'openai-completions', baseUrl: address, source: 'catalog' }),
	});
	t.after(() => sessions.dispose());
	const state = await sessions.submit({ conversationId: await sessions.createConversation(), instruction: '读一下笔记', refs: [] }).result;
	assert.equal(state.status, 'failed');
	assert.match(state.error ?? '', /模型连接设置已变更/u);
	assert.equal(attempts, 1);
});

void test('runtime model data is available before tools, thinking, and queued destinations are resolved', async (t) => {
	const { connect, directory } = await fixture(t);
	const scope = new AsyncLocalStorage<{ prepared?: true }>();
	const fallback = 'https://compatible.example/v1';
	const current = 'https://resolved.example/v1';
	let preparations = 0;
	let messages = 0;
	const modelConnection: ModelService['modelConnection'] = () => ({
		api: 'openai-completions', source: 'catalog', baseUrl: scope.getStore()?.prepared ? current : fallback,
	});
	const sessions = connect((request) => {
		messages++;
		assert.equal(modelConnection(firstModel.providerId, firstModel.model).baseUrl, current);
		assert.equal(request.reasoning, 'high');
		assert.deepEqual(request.tools, []);
		return reply('已完成');
	}, { ...firstModel, thinkingByModel: { [chatModelKey(firstModel.providerId, firstModel.model)]: 'high' } },
	(_choice, preferred) => scope.getStore()?.prepared ? { levels: ['high'], level: preferred ?? 'high' } : { levels: [] }, {
		send: async () => assert.fail('Unexpected auxiliary request'), modelConnection,
		modelCapabilities: () => ({ tools: !scope.getStore()?.prepared, structuredOutput: false, imageInput: false }),
		async withPreparedModels(work) {
			await Promise.resolve();
			return scope.run({}, work);
		},
		async prepareModel(selection) {
			const run = scope.getStore();
			assert.ok(run);
			assert.equal(selection.model, firstModel.model);
			await Promise.resolve();
			preparations++;
			run.prepared = true;
		},
	});
	t.after(() => sessions.dispose());
	const conversationId = await sessions.createConversation();
	const request = { conversationId, instruction: '完成任务', refs: [] };
	const state = await sessions.submit(request).result;
	assert.equal(state.status, 'done', state.error);
	assert.equal(preparations, 1);
	assert.equal(messages, 1);

	const row = { id: 'queued-before-update', request, destination: queuedModelDestination(firstModel, modelConnection) };
	assert.equal(row.destination?.baseUrl, fallback);
	const store = createConversationStore(directory);
	await store.enqueue(conversationId, row);
	await assert.rejects(sessions.submitQueued(row, {}, () => assert.fail('unconfirmed destination consumed the queue row')).result, /接收方已变更/u);
	assert.deepEqual(await store.getQueued(conversationId), [row]);
	const side = sessions.createSideChat([]);
	const run = side.submit({ instruction: '转交', queued: { destination: row.destination } });
	assert.ok(run.prepared);
	await assert.rejects(run.prepared, /接收方与排队记录不一致/u);
	await assert.rejects(run.result, /接收方与排队记录不一致/u);
	const accepted = side.submit({ instruction: '普通侧聊' });
	await accepted.prepared;
	assert.equal((await accepted.result).status, 'done');
	assert.equal(preparations, 4);
	assert.equal(messages, 2);
});

void test('new submissions reject a disabled provider and use the remaining chat default', async (t) => {
	const { connect } = await fixture(t);
	const requests: string[] = [];
	const sessions = connect(({ providerId }) => {
		requests.push(providerId);
		return reply('收到');
	}, {
		...firstModel,
		providerModels: { [firstModel.providerId]: [firstModel.model], [secondModel.providerId]: [secondModel.model] },
		disabledProviderIds: [firstModel.providerId],
	});
	t.after(() => sessions.dispose());
	const request = { conversationId: await sessions.createConversation(), instruction: '你好', refs: [] };
	assert.throws(() => sessions.submit(request, {}, undefined, { model: firstModel }), /所选模型已不可用/u);
	assert.deepEqual(requests, []);
	assert.equal((await sessions.submit(request).result).status, 'done');
	assert.deepEqual(requests, [secondModel.providerId]);
});

void test('queued messages keep their saved destination and need confirmation before switching services', async (t) => {
	const { connect, directory } = await fixture(t);
	const localAddress = 'http://127.0.0.1:2010/v1';
	let remoteAddress = 'https://cloud.example/v1';
	const modelConnection: NonNullable<ModelService['modelConnection']> = (providerId) => ({
		api: 'openai-completions', source: 'configured', baseUrl: providerId === firstModel.providerId ? localAddress : remoteAddress,
	});
	const received: string[] = [];
	const sessions = connect((request) => {
		received.push(request.providerId);
		return reply('已回答。');
	}, { ...firstModel, providerModels: { [firstModel.providerId]: [firstModel.model], [secondModel.providerId]: [secondModel.model] } },
	undefined, { modelConnection, send: async () => assert.fail('unexpected auxiliary request') });
	t.after(() => sessions.dispose());
	const store = createConversationStore(directory);
	const id = await sessions.createConversation();
	const row = { id: 'queued-local', request: { conversationId: id, instruction: '本地分析', refs: [] },
		destination: queuedModelDestination(firstModel, modelConnection) };
	await store.enqueue(id, row);
	const unexpectedStart = () => assert.fail('queue entry was consumed before authorization');
	await assert.rejects(sessions.submitQueued(row, {}, unexpectedStart, { model: secondModel }).result, /接收方已变更/u);
	await assert.rejects(sessions.submitQueued(row, {}, unexpectedStart, { model: secondModel,
		confirmQueuedDestination: async (previous, current) => {
			assert.equal(previous?.baseUrl, localAddress);
			assert.equal(current.baseUrl, remoteAddress);
			remoteAddress = 'https://new.example/v1';
			return true;
		} }).result, /再次变更/u);
	assert.deepEqual(received, []);
	assert.deepEqual(await store.getQueued(id), [row]);
	const accepted = await sessions.submitQueued(row, {}, () => {}, { model: secondModel,
		confirmQueuedDestination: async (_previous, current) => current.baseUrl === remoteAddress }).result;
	assert.equal(accepted.status, 'done', accepted.error);
	assert.deepEqual(received, [secondModel.providerId]);
	assert.deepEqual(await store.getQueued(id), []);

	const side = sessions.createSideChat([]);
	assert.throws(() => side.submit({ instruction: '转交', model: secondModel, queued: { destination: row.destination } }), /接收方与排队记录不一致/u);
	assert.throws(() => side.submit({ instruction: '旧排队消息', model: firstModel, queued: {} }), /接收方与排队记录不一致/u);
	const running = sessions.submit({ conversationId: id, instruction: '原任务', refs: [] }, {}, undefined, { model: secondModel });
	await assert.rejects(sessions.steer(running.taskId, row), /接收方与排队记录不一致/u);
	assert.equal((await running.result).status, 'done');
	assert.deepEqual(received, [secondModel.providerId, secondModel.providerId]);
});

void test('automatic review can approve an external read but sends external edits and rule changes to the user', async (t) => {
	const { cwd, connect } = await fixture(t);
	const outside = join(cwd, '..', 'approval-diff.txt');
	await writeFile(outside, 'replace this\nprivate unchanged line\n');
	const turns: ToolCall[][] = [
		[{ id: 'read', name: 'Read', input: { file_path: outside, limit: 1 } }],
		[{ id: 'edit', name: 'Edit', input: { file_path: outside, old_string: 'replace this', new_string: 'updated' } }],
		[{ id: 'root-rule', name: 'Write', input: { file_path: 'AGENTS.md', content: 'Persistent rule' } }],
	];
	const reviews: string[] = [];
	const human: string[] = [];
	const sessions = connect(() => {
		const calls = turns.shift();
		return calls ? reply('', calls) : reply('已完成。');
	}, firstModel, undefined, { async send(request) {
		reviews.push(request.messages[0]!.content);
		return reply('APPROVE').result();
	} });
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const result = await sessions.submit({ conversationId: id, refs: [], instruction: '调整已指定的内容' }, {
		approve: async (approval) => {
			assert.equal(approval.humanRequired, true);
			human.push(approval.target);
			return false;
		},
	}, undefined, { executionMode: 'auto-review' }).result;
	assert.equal(result.status, 'done', result.error);
	assert.equal(human.length, 2);
	assert.ok(human[0]?.endsWith('/approval-diff.txt'));
	assert.equal(human[1], 'AGENTS.md');
	assert.equal(reviews.length, 1);
	assert.match(reviews[0]!, /approval-diff\.txt/u);
	assert.doesNotMatch(reviews[0]!, /updated|private unchanged line|Persistent rule/u);
	assert.deepEqual(result.messages.filter(({ toolCallId }) => toolCallId).map(({ isError }) => Boolean(isError)), [false, true, true]);
	assert.equal(await readFile(outside, 'utf8'), 'replace this\nprivate unchanged line\n');
});

void test('external writes require a person except when full access explicitly waives approval', async (t) => {
	const { cwd, connect, directory } = await fixture(t);
	for (const [executionMode, decision, confirm] of [
		['ask', true], ['ask', false], ['auto-review', true], ['auto-review', false],
		['full-access', true], ['full-access', false],
		['ask', false, false], ['auto-review', false, false], ['full-access', false, false],
	] as const) {
		const label = `${executionMode}-${decision}-${confirm !== false}`;
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
		}, { ...firstModel, confirmFullAccessExternalActions: confirm }, undefined,
		{ async send(request) { reviews.push(request); return reply('APPROVE').result(); } });
		const id = await sessions.createConversation();
		const instruction = `创建 ${inside} 以及库外的 ${outside}`;
		const state = await sessions.submit({ conversationId: id, instruction, refs: [] }, {
			approve: async (operation) => {
				prompts++;
				assert.ok(operation.target.endsWith(`${label}.md`));
				assert.equal(operation.humanRequired, true);
				assert.equal(operation.after, '新内容');
				return decision;
			},
		}, undefined, { executionMode }).result;
		assert.equal(await readFile(join(cwd, inside), 'utf8'), '新内容');
		const skip = executionMode === 'full-access' && confirm === false;
		const allowed = decision || skip;
		const outsideResult = state.messages.find(({ toolCallId }) => toolCallId === 'outside');
		assert.equal(outsideResult?.isError, !allowed, outsideResult?.content);
		if (allowed) assert.equal(await readFile(outside, 'utf8'), '新内容');
		else await assert.rejects(access(outside), { code: 'ENOENT' });
		const [saved] = (await createConversationStore(directory).load(id)).runs;
		assert.deepEqual(saved?.state.messages.find(({ toolCallId }) => toolCallId === 'inside')?.noteChange, { path: inside, after: '新内容' });
		assert.equal(saved?.state.messages.find(({ toolCallId }) => toolCallId === 'outside')?.noteChange, undefined);
		assert.equal(prompts, skip ? 0 : 1);
		assert.deepEqual(reviews, []);
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
		if (!request.messages.some(({ toolCallId }) => toolCallId === deniedWrite.id) && activeMode(request).includes('本次为只读计划模式')) {
			return reply('', [deniedWrite, ...planReads]);
		}
		return reply('说完了。');
	}, { ...firstModel, confirmFullAccessExternalActions: false });
	t.after(() => sessions.dispose());
	const conversationId = await sessions.createConversation();
	await sessions.submit({ conversationId, instruction: 'unrelated prior history', refs: [] }).result;
	const plan = await sessions.submit({ conversationId, intent: 'plan', instruction: '先做计划', refs: [{ path: outside, kind: 'file' }] }, {}, undefined,
		{ executionMode: 'full-access' }).result;
	assert.equal(plan.messages.find(({ toolCallId }) => toolCallId === deniedWrite.id)?.isError, true);
	assert.equal(plan.messages.find(({ toolCallId }) => toolCallId === planReads[0]?.id)?.isError, true);
	assert.match(plan.messages.find(({ toolCallId }) => toolCallId === planReads[1]?.id)?.content ?? '', /vault detail/);
	await assert.rejects(access(join(cwd, 'forbidden.md')), { code: 'ENOENT' });
	const planRequest = requests.find((request) => activeMode(request).includes('本次为只读计划模式'));
	assert.deepEqual(planRequest?.tools, requests[0]?.tools);
	assert.ok(planRequest?.tools.some(({ name }) => name === 'Write'));
	const reviewMaterial = 'selected snapshot';
	await sessions.submit({ conversationId, intent: 'review', instruction: '检查事实', refs: [], reviewMaterial }, {}, undefined,
		{ executionMode: 'full-access' }).result;
	const review = requests.at(-1)!;
	assert.match(activeMode(review), /本次为只读笔记检查/);
	assert.equal(review.system, planRequest?.system);
	assert.doesNotMatch(requestText(review), /vault style|unrelated prior history/);
	assert.deepEqual(review.tools, []);
	assert.equal(review.messages.length, 2);
	assert.equal(review.messages[0]?.content, '检查事实');
	assert.match(requestText(review), /selected snapshot/);
	assert.equal((await createConversationStore(directory).load(conversationId)).runs.at(-1)?.request.reviewMaterial, reviewMaterial);
	await sessions.submit({ conversationId, instruction: '下一个普通问题', refs: [] }).result;
	assert.doesNotMatch(requestText(requests.at(-1)), /selected snapshot/);
});

void test('a planned checklist stays locked until confirmed, releases stopped work and survives reopening', async (t) => {
	const { connect, directory } = await fixture(t);
	const store = createConversationStore(directory);
	const create = (subject: string, blockedBy: string[] = []): ToolCall => ({
		id: subject, name: 'TaskCreate', input: { subject, description: subject, blockedBy },
	});
	const update = (id: string, taskId: string, status: string): ToolCall => ({ id, name: 'TaskUpdate', input: { taskId, status } });
	const responses = (steps: ModelStream[]) => connect(() => {
		const next = steps.shift();
		assert.ok(next, '模型收到了意外的额外请求');
		return next;
	});
	const sessions = responses([
		reply('', [create('核对来源'), create('整理结果', ['1']), create('复查结论', ['2'])]),
		reply('<!-- scribe-plan -->\n# 分步核对\n## 验收条件\n- 复查结论\n<!-- /scribe-plan -->'),
		reply('', [update('claim-first', '1', 'in_progress'), update('finish-first', '1', 'completed'), update('claim-second', '2', 'in_progress')]),
		reply('开始整理。'),
	]);
	const id = await sessions.createConversation();
	const planned = await sessions.submit({ conversationId: id, intent: 'plan', instruction: '列出核对步骤', refs: [] }).result;
	assert.equal(planned.status, 'done', planned.error);
	const plan = submittedPlan((await store.load(id)).runs.at(-1));
	assert.ok(plan);
	const states = async (conversationId: string) => (await store.chatTasks.list(conversationId)).at(-1)?.tasks.map(({ status }) => status);
	assert.deepEqual(await states(id), ['pending', 'pending', 'pending']);

	const fork = await sessions.forkConversation(id, plan.taskId);
	const bypass = responses([reply('', [update('unapproved', '1', 'in_progress')]), reply('等待确认。')]);
	const blocked = await bypass.submit({ conversationId: fork.id, instruction: '继续', refs: [] }).result;
	assert.equal(blocked.messages.find(({ toolCallId }) => toolCallId === 'unapproved')?.isError, true);
	assert.deepEqual(await states(fork.id), ['pending', 'pending', 'pending']);
	bypass.dispose();

	const run = sessions.submit(approvedPlanRequest(plan), { onEvent(event) {
		if (event.type === 'text-delta') sessions.pause(run.taskId);
	} });
	assert.equal((await run.result).status, 'interrupted');
	assert.deepEqual(await states(id), ['completed', 'stopped', 'pending']);
	sessions.dispose();
	const reopened = responses([
		reply('', [update('reclaim-second', '2', 'in_progress'), update('finish-second', '2', 'completed'),
			update('claim-third', '3', 'in_progress'), update('finish-third', '3', 'completed')]),
		reply('已复查。'),
	]);
	const resumed = await reopened.resume(id, run.taskId).result;
	assert.equal(resumed.status, 'done', resumed.error);
	assert.deepEqual(await states(id), ['completed', 'completed', 'completed']);
	assert.deepEqual(await states(fork.id), ['pending', 'pending', 'pending']);
	reopened.dispose();
});

const goalEndpoint = 'https://model.example/v1/chat/completions';

function confirmGoalEndpoint(request: ModelRequest, address = goalEndpoint + '?route=original-private-query') {
	return confirmModelRequest(new URL(address), { beforeSend: request.beforeSend, controller: new AbortController() });
}

function atGoalEndpoint(request: ModelRequest, stream: ModelStream): ModelStream {
	return { ...stream, async *[Symbol.asyncIterator]() {
		await confirmGoalEndpoint(request);
		yield* stream;
	} };
}

void test('a confirmed plan keeps its attachments and a structured goal report survives reopening with checked evidence', async (t) => {
	const { cwd, connect, directory } = await fixture(t);
	const source = '会议.md';
	const index = '索引.md';
	const body = '# 整理会议纪要\n\n## 执行范围\n- 核对会议日期并生成索引。\n\n## 验收条件\n- 核对 [[会议.md]] 的会议日期\n- 生成 [[索引.md]]';
	await writeFile(join(cwd, source), '# 会议\n\n日期是 11 月 23 日。\n\n附录：无关会议段落不应外发。\n');
	const write = { id: 'index-write', name: 'Write', input: { file_path: index, content: '# 会议索引\n\n[[会议.md]]' } };
	const read = { id: 'source-read', name: 'Read', input: { file_path: source } };
	const reportDate = { id: 'report-date', name: reportGoalToolName, input: { intent: '报告日期核对结果',
		checks: [{ criterion: 1, evidence: '日期是 11 月 23 日', notePaths: [source] }], remaining: ['生成 [[索引.md]]'] } };
	const reportIndex = { id: 'report-index', name: reportGoalToolName, input: { intent: '报告索引核对结果',
		checks: [{ criterion: 2, evidence: '索引包含会议纪要链接', notePaths: [index] }], remaining: [] } };
	const outOfScopeReport = { ...reportDate, id: 'out-of-scope-report' };
	const invalidReport = { ...reportDate, id: 'invalid-report', input: { ...reportDate.input, checks: [{ criterion: 3, evidence: '错误编号' }] } };
	const duplicateReport = { ...reportDate, id: 'duplicate-report', input: { ...reportDate.input, remaining: [], blocked: '不应覆盖已登记报告' } };
	let outputLegacyReport = false;
	const stream = (request: ModelRequest) => {
		const mode = activeMode(request);
		const reportTool = request.tools.find(({ name }) => name === reportGoalToolName);
		if (mode.includes('本次为只读计划模式')) {
			assert.ok(request.tools.some(({ name }) => name === 'Write'));
			assert.equal(reportTool, undefined);
			return reply(`<!-- scribe-plan -->\n${body}\n<!-- /scribe-plan -->`);
		}
		const userIndex = request.messages.findLastIndex(({ role, content }) => role === 'user' && Boolean(content));
		const user = request.messages[userIndex];
		const currentUser = user ? promptText(user) : '';
		const currentResults = request.messages.slice(userIndex);
		if (!mode.includes('聊天目标的自动执行轮次')) {
			assert.equal(reportTool, undefined);
			assert.ok(currentUser.includes(body));
			assert.ok(currentUser.includes('原始引文'));
			const outOfScope = currentResults.find(({ toolCallId }) => toolCallId === outOfScopeReport.id);
			if (!outOfScope) return reply('', [outOfScopeReport]);
			assert.equal(outOfScope.isError, true);
			return request.messages.some(({ toolCallId }) => toolCallId === write.id) ? reply('索引已生成。') : reply('', [write]);
		}
		assert.ok(reportTool);
		assert.deepEqual(reportTool.inputSchema.required, ['checks', 'remaining', 'intent']);
		assert.ok(currentUser.includes(body));
		assert.ok(currentUser.includes('原始引文'));
		if (!currentUser.includes('上轮已核对')) {
			if (!currentResults.some(({ toolCallId }) => toolCallId === read.id)) return reply('', [read]);
			if (outputLegacyReport) return reply('日期已核对。\n<!-- scribe-goal-report: ' + JSON.stringify(reportDate.input) + ' -->');
			const recorded = currentResults.find(({ toolCallId }) => toolCallId === reportDate.id);
			if (!recorded) return reply('', [invalidReport, reportDate, duplicateReport]);
			assert.equal(currentResults.find(({ toolCallId }) => toolCallId === invalidReport.id)?.isError, true);
			assert.equal(currentResults.find(({ toolCallId }) => toolCallId === duplicateReport.id)?.isError, true);
			assert.equal(recorded.isError, false);
			return reply('日期已核对。');
		}
		assert.ok(currentUser.includes('日期是 11 月 23 日'));
		const readIndex = { id: 'index-read', name: 'Read', input: { file_path: index } };
		if (!currentResults.some(({ toolCallId }) => toolCallId === readIndex.id)) return reply('', [readIndex]);
		return currentResults.some(({ toolCallId, isError }) => toolCallId === reportIndex.id && !isError)
			? reply('索引已核对。') : reply('', [reportIndex]);
	};
	let reviews = 0;
	const sessions = connect((request) => atGoalEndpoint(request, stream(request)), firstModel, undefined, {
		async send(request) {
			await confirmGoalEndpoint(request);
			assert.deepEqual(request.tools, []);
			assert.deepEqual([request.providerId, request.model], [firstModel.providerId, firstModel.model]);
			const material = request.messages[0]!.content;
			assert.match(material, /日期是 11 月 23 日/u);
			assert.match(material, /会议索引/u);
			assert.equal((JSON.parse(material) as {notes: Record<string, {whole: boolean}[]>}).notes[source]?.[0]?.whole, false);
			assert.doesNotMatch(material, /原始引文|scribe-goal-report|fixture-vault-config|上轮已核对|无关会议段落不应外发/u);
			reviews++;
			return reply('["日期是 11 月 23 日","[[会议.md]]"]').result();
		},
	}, false, false, true);
	t.after(() => sessions.dispose());
	const conversationId = await sessions.createConversation();
	const store = createConversationStore(directory);
	const sourceRequest = { conversationId, instruction: '整理会议纪要', refs: [
		{ path: source, kind: 'file' as const }, { path: join(cwd, '..', 'other.md'), kind: 'file' as const, addedExternal: true as const },
	], chatQuotes: ['原始引文'], skillNotePaths: [source] };
	await sessions.submit({ ...sourceRequest, intent: 'plan' }, {}, undefined, { executionMode: 'full-access' }).result;
	await assert.rejects(access(join(cwd, index)), { code: 'ENOENT' });
	const savedPlan = (await store.load(conversationId)).runs.at(-1)!;
	assert.equal(submittedPlan({ ...savedPlan, state: { ...savedPlan.state, status: 'partial' } }), undefined);
	const plan = submittedPlan(savedPlan);
	assert.ok(plan);
	assert.deepEqual(plan.criteria, ['核对 [[会议.md]] 的会议日期', '生成 [[索引.md]]']);
	const approved = approvedPlanRequest(plan);
	assert.equal(approved.intent, undefined);
	assert.deepEqual(approved.refs, [{ path: source, kind: 'file' }]);
	assert.deepEqual(approved.skillNotePaths, [source]);
	await sessions.submit(approved, {}, undefined, { executionMode: 'ask' }).result;
	assert.match(await readFile(join(cwd, index), 'utf8'), /\[\[会议\.md\]\]/u);

	const goal: ChatGoal = { objective: plan.title, status: 'active', usedRounds: 0, totalRounds: 0,
		criteria: plan.criteria, plan: plan.markdown, refs: plan.request.refs, chatQuotes: plan.request.chatQuotes };
	await store.saveGoal(conversationId, goal);
	const runGoal = (value: ChatGoal) => sessions.submit({ conversationId, instruction: value.objective, refs: value.refs ?? [],
		chatQuotes: value.chatQuotes, goalRound: true, goalContext: goalRoundInstruction(value) }, {}, undefined, { executionMode: 'ask', goal: value }).result;
	const firstRound = await runGoal(goal);
	const checkpoint = finishGoalRound({ ...goal, usedRounds: 1, totalRounds: 1 }, firstRound);
	const savedRound = (await createConversationStore(directory).load(conversationId)).runs.at(-1)!.state;
	assert.equal(savedRound.messages.at(-1)?.content, '日期已核对。');
	assert.ok(savedRound.messages.some(({ toolCallId, isError }) => toolCallId === reportDate.id && isError === false));
	assert.equal(checkpoint.status, 'active');
	assert.equal(checkpoint.progress?.checks.length, 1);
	assert.deepEqual(checkpoint.progress?.remaining, ['生成 [[索引.md]]']);
	await store.saveGoal(conversationId, checkpoint);
	const restored = restoreChatGoal(await createConversationStore(directory).loadGoal(conversationId));
	assert.ok(restored);
	assert.equal(restored.status, 'paused');
	assert.deepEqual(restored.progress, checkpoint.progress);
	const resumed = { ...restored, status: 'active' as const, usedRounds: 1, totalRounds: 2 };
	const result = await runGoal(resumed);
	const completed = finishGoalRound(resumed, result, result.goalReview);
	assert.equal(reviews, 1);
	assert.deepEqual((await store.load(conversationId)).runs.at(-1)?.state.auxiliaryUsage?.map(({kind}) => kind), ['goal-review']);
	assert.equal(completed.status, 'complete');
	assert.equal(completed.progress?.checks.length, 2);

	outputLegacyReport = true;
	const unconfirmed = await runGoal(goal);
	assert.equal(unconfirmed.messages.at(-1)?.goalReportRequired, true);
	assert.deepEqual(finishGoalRound(goal, unconfirmed).progress?.checks, []);
	const reopened = (await createConversationStore(directory).load(conversationId)).runs.at(-1)!.state;
	assert.deepEqual(finishGoalRound(goal, reopened).progress?.checks, []);
});

for (const scenario of ['approved', 'unsupported', 'rejected', 'failed', 'stopped', 'redirected', 'query-changed', 'changed'] as const) {
	void test(`semantic goal review keeps the original recipient, evidence scope and usage when ${scenario}`, async (t) => {
		const { cwd, connect, directory } = await fixture(t);
		const path = '报告.md';
		const criterion = '说明报告为何适合初学者。';
		const goal: ChatGoal = { objective: criterion, criteria: [criterion], refs: [{ path, lines: [2, 2] }],
			status: 'active', usedRounds: 1, totalRounds: 1 };
		const writeSource = (body: string) => writeFile(join(cwd, path), '隐藏行 A\n' + body + '\n隐藏行 B\n');
		await writeSource('先举例再介绍术语。');
		const report = '主助手的自述。\n<!-- scribe-goal-report: ' + JSON.stringify({
			checks: [{criterion: 1, evidence: '主助手声称验收通过', notePaths: [path]}], remaining: [],
		}) + ' -->';
		let sent = 0;
		let reviewing!: () => void;
		const started = new Promise<void>((resolve) => { reviewing = resolve; });
		let finish!: () => void;
		const release = new Promise<void>((resolve) => { finish = resolve; });
		const sessions = connect((request) => atGoalEndpoint(request, request.messages.at(-1)?.toolCallId === 'read-goal-proof'
			? reply(report) : reply('', [{ id: 'read-goal-proof', name: 'Read', input: { file_path: path } }])), firstModel, undefined, {
			async send(request, receipt) {
				await confirmGoalEndpoint(request, scenario === 'redirected' ? goalEndpoint + '/unexpected'
					: scenario === 'query-changed' ? goalEndpoint + '?route=another-private-query' : undefined);
				sent++;
				const payload = request.messages[0]!.content;
				assert.deepEqual(request.tools, []);
				assert.equal(request.messages.length, 1);
				assert.match(payload, /先举例再介绍术语。/u);
				assert.doesNotMatch(payload, /隐藏行|主助手|资料之外的引文|private-query/u);
				assert.equal(request.maxRetries, 0);
				receipt?.({ reportedUsage: {input: 5} });
				if (scenario === 'failed') throw new Error('服务暂不可用');
				if (scenario === 'stopped') { reviewing(); await release; }
				if (scenario === 'changed') await writeSource('材料已经变化');
				return reply(scenario === 'unsupported' ? '["并不存在的引语"]' : scenario === 'rejected' ? '[null]' : '["先举例再介绍术语。"]').result();
			},
		});
		t.after(() => sessions.dispose());
		const id = await sessions.createConversation();
		const request = { conversationId: id, instruction: criterion, refs: goal.refs!, chatQuotes: ['资料之外的引文'] };
		await sessions.submit(request, {}, undefined, { goal }).result;
		assert.equal(sent, 0, '普通聊天不能启动独立验收');
		// 私有历史会与后续目标共享同一模型，但不会进入辅助请求。
		const run = sessions.submit({ ...request, goalRound: true, goalContext: goalRoundInstruction(goal) }, {}, undefined, { goal });
		if (scenario === 'stopped') {
			await Promise.race([started, run.result.then(() => assert.fail('未启动目标验收'))]);
			await sessions.cancel(run.taskId);
		}
		const result = await run.result;
		if (scenario === 'stopped') {
			const beforeReply = (await createConversationStore(directory).load(id)).runs.at(-1)?.state.auxiliaryUsage;
			assert.deepEqual(beforeReply, [{kind: 'goal-review', reportedUsage: {input: 5}}]);
			finish();
		}
		assert.equal(sent, scenario === 'redirected' || scenario === 'query-changed' ? 0 : 1);
		const next = finishGoalRound(goal, result, result.goalReview);
		assert.equal(next.status, scenario === 'approved' ? 'complete' : 'paused');
		if (scenario !== 'approved' && scenario !== 'stopped') assert.equal(next.reason, 'verification');
		const usage = (await createConversationStore(directory).load(id)).runs.at(-1)?.state.auxiliaryUsage;
		assert.equal(usage?.length ?? 0, sent);
		if (sent) { assert.equal(usage?.[0]?.kind, 'goal-review'); assert.equal(usage?.[0]?.reportedUsage?.input, 5); }
	});
}

void test('goal review verifies each cited note and the actual exit status of a named foreground command', async (t) => {
	const {cwd, connect} = await fixture(t);
	const paths = ['甲.md', '乙.md'];
	await Promise.all(paths.map((path, i) => writeFile(join(cwd, path), ['甲的原文', '乙的原文'][i]! + '\n')));
	const command = 'test -f 甲.md';
	const criteria = ['两篇笔记都应说明结论。', '运行「test -f 甲.md」应成功。'];
	const goal: ChatGoal = {objective: '复核产物', criteria, status: 'active', usedRounds: 1, totalRounds: 1};
	const calls = [...paths.map((path, i) => ({id: 'proof' + i, name: 'Read', input: {file_path: path}})),
		{id: 'check-note', name: 'Bash', input: {command}}];
	const report = '全部完成。\n<!-- scribe-goal-report: ' + JSON.stringify({checks: [
		{criterion: 1, evidence: '两个结论已经核对', notePaths: paths}, {criterion: 2, evidence: '运行测试通过'},
	], remaining: []}) + ' -->';
	let enough = false;
	let reviewed = 0;
	const sessions = connect((request) => atGoalEndpoint(request,
		request.messages.at(-1)?.toolCallId === 'check-note' ? reply(report) : reply('', calls)), firstModel, undefined, {
		async send(request) {
			await confirmGoalEndpoint(request);
			const evidence = JSON.parse(request.messages[0]!.content) as {commands: unknown; answer?: string; notes: Record<string,{whole: boolean}[]>};
			assert.deepEqual(evidence.commands, [{command, status: 'success'}]);
			assert.equal(evidence.answer, undefined);
			assert.ok(evidence.notes['甲.md']?.[0]?.whole && evidence.notes['乙.md']?.[0]?.whole);
			reviewed++;
			return reply(JSON.stringify([[enough ? '甲的原文' : '乙的原文', '乙的原文'], 'success'])).result();
		},
	});
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const run = () => sessions.submit({conversationId: id, instruction: goal.objective, refs: [], goalRound: true, goalContext: goalRoundInstruction(goal)},
		{approve: async () => true}, undefined, {goal, executionMode: 'full-access'}).result;
	const first = await run();
	assert.equal(first.goalReview, 'needs-evidence');
	enough = true;
	const second = await run();
	assert.equal(second.goalReview, 'passed');
	assert.equal(reviewed, 2);
});

void test('mechanical goal completion checks the current note locally before accepting the earlier receipt', async (t) => {
	const { cwd, connect } = await fixture(t);
	const path = '校验.md';
	const criterion = '[[校验.md]] 的标题应为「交付」';
	const goal: ChatGoal = {objective: criterion, criteria: [criterion], status: 'active', usedRounds: 1, totalRounds: 1};
	const report = '已检查。\n<!-- scribe-goal-report: ' + JSON.stringify({
		checks: [{criterion: 1, evidence: '标题为交付', notePaths: [path]}], remaining: [],
	}) + ' -->';
	let change = true;
	let calls = 0;
	const sessions = connect((request) => {
		const read = request.messages.at(-1)?.toolCallId === 'heading';
		const stream = atGoalEndpoint(request, read ? reply(report) : reply('', [{id: 'heading', name: 'Read', input: {file_path: path}}]));
		return { ...stream, async *[Symbol.asyncIterator]() {
			if (change && read) await writeFile(join(cwd, path), '# 已由用户更改\n');
			yield* stream;
		} };
	}, firstModel, undefined, { send: () => { calls++; throw new Error('unexpected remote check'); } });
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	for (change of [true, false]) {
		await writeFile(join(cwd, path), '# 交付\n');
		const result = await sessions.submit({conversationId: id, instruction: criterion, refs: [], goalRound: true, goalContext: goalRoundInstruction(goal)},
			{}, undefined, {goal}).result;
		assert.equal(finishGoalRound(goal, result, result.goalReview).status, change ? 'paused' : 'complete');
	}
	assert.equal(calls, 0);
});

void test('a whole-note semantic criterion keeps both paragraphs or pauses if the complete evidence is too long', async (t) => {
	const {cwd, connect} = await fixture(t);
	const path = '稿件.md';
	const criterion = '确认全文的日期口径一致。';
	const goal: ChatGoal = {objective: criterion, status: 'active', criteria: [criterion], usedRounds: 1, totalRounds: 1};
	const report = '已检查。\n<!-- scribe-goal-report: ' + JSON.stringify({checks: [
		{criterion: 1, evidence: '「日期为三日」', notePaths: [path]},
	], remaining: []}) + ' -->';
	let reviews = 0;
	const sessions = connect((request) => atGoalEndpoint(request, dialogMessages(request).at(-1)?.toolCallId === 'read-all'
		? reply(report) : reply('', [{id: 'read-all', name: 'Read', input: {file_path: path}}])), firstModel, undefined, {
		async send(request) {
			await confirmGoalEndpoint(request);
			reviews++;
			assert.match(request.messages[0]!.content, /日期为三日/u);
			assert.match(request.messages[0]!.content, /文末写作二日/u);
			return reply('[null]').result();
		},
	});
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	for (const filler of ['', '大量其余内容'.repeat(1200)]) {
		await writeFile(join(cwd, path), '日期为三日。\n\n' + filler + '文末写作二日。');
		const result = await sessions.submit({conversationId: id, instruction: criterion, refs: [], goalRound: true, goalContext: goalRoundInstruction(goal)},
			{}, undefined, {goal}).result;
		assert.equal(result.goalReview, 'needs-evidence');
	}
	assert.equal(reviews, 1);
});

void test('goal work stops while a tool waits for the user and resumes for actual work', async (t) => {
	const { cwd, connect } = await fixture(t);
	const output = join(cwd, '..', 'goal-output.md');
	const transitions: boolean[] = [];
	let working = false;
	let prompted = false;
	const sessions = connect((request) => {
		assert.equal(working, true);
		return request.messages.some(({ toolCallId }) => toolCallId === 'goal-output') ? reply('已生成笔记。')
			: reply('', [{ id: 'goal-output', name: 'Write', input: { file_path: output, content: '# 结果' } }]);
	});
	t.after(() => sessions.dispose());
	const conversationId = await sessions.createConversation();
	const run = sessions.submit({ conversationId, instruction: '生成笔记', refs: [], goalRound: true }, {
		onWork: (_taskId, active) => {
			working = active;
			transitions.push(active);
		},
		approve: async () => {
			prompted = true;
			assert.equal(working, false);
			return true;
		},
	}, undefined, { executionMode: 'ask' });
	await run.result;
	assert.equal(prompted, true);
	assert.equal(await readFile(output, 'utf8'), '# 结果');
	assert.deepEqual(transitions, [true, false, true, false, true, false, true, false]);
});

void test('each question reads only the vault root writing rules with or without attachments', async (t) => {
	const { cwd, connect, ruleLookups, setActiveNote } = await fixture(t);
	await mkdir(join(cwd, '会议/项目'), { recursive: true });
	await Promise.all(Object.entries({
		'AGENTS.md': '全库用短段落。',
		'会议/AGENTS.md': '会议用项目符号。',
		'会议/项目/AGENTS.md': '项目会议结尾列出负责人。',
		'会议/项目/纪要.md': '会议记录。',
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

	setActiveNote('会议/项目/纪要.md');
	const meeting = await ask({ refs: [{ path: '会议/项目/纪要.md' }] });
	assert.match(requestText(meeting), /<project-rules>[\s\S]*全库用短段落/u);
	assert.doesNotMatch(requestText(meeting), /会议用项目符号|列出负责人/u);
	assert.doesNotMatch(meeting.system ?? '', /全库用短段落/u);

	const noAttachment = await ask();
	assert.match(requestText(noAttachment), /<project-rules>[\s\S]*全库用短段落/u);
	assert.doesNotMatch(requestText(noAttachment), /会议用项目符号|列出负责人/u);

	await writeFile(join(cwd, 'AGENTS.md'), '全库改用表格。');
	const edited = await ask({ refs: [{ path: '会议', kind: 'folder' }] });
	assert.match(requestText(edited), /<project-rules>[\s\S]*全库改用表格/u);
	assert.doesNotMatch(requestText(edited), /会议用项目符号/u);
	assert.equal(edited.system, meeting.system);

	await writeFile(join(cwd, 'AGENTS.md'), '');
	assert.doesNotMatch(requestText(await ask()), /全库改用表格|会议用项目符号|列出负责人/u);
	assert.deepEqual([...new Set(ruleLookups)], ['AGENTS.md']);
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
		contextLimits: () => ({ contextWindow: 18_000, maxTokens: 1_024 }),
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
		const latest = dialogMessages(request).at(-1);
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
			const summary = request.messages.map(promptText).find((text) => text.includes('较早对话摘要（仅供参考）')) ?? '';
			const batch = /决定：([^。]+)。/u.exec(summary)?.[1];
			const source = /出处：(\[\[[^\]]+\]\])/u.exec(summary)?.[1];
			const pending = /待办：([^。]+)。/u.exec(summary)?.[1];
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
		main: { count: 2, prompt: 385, input: 300, cacheRead: 70, cacheWrite: 15, output: 50, total: 435, hit: 70 / 385, cost: 0.375 },
		review: { count: 1, prompt: 100, input: 70, cacheRead: 25, cacheWrite: 5, output: 5, total: 105, hit: 0.25, cost: 0.0625 },
		summary: { count: 1, prompt: 80, input: 60, cacheRead: 10, cacheWrite: 10, output: 12, total: 92, hit: 0.125, cost: 0.03125 },
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
	assert.equal(recalled.messages.find(({ toolCallId }) => toolCallId === 'reviewed-read')?.approvalReview, 'approved');
	assert.equal(repeated.messages.find(({ toolCallId }) => toolCallId === 'reviewed-read')?.approvalReview, 'denied');
	const goal = finishGoalRound({ objective: recallPrompt, status: 'active', usedRounds: 1, totalRounds: 1 }, repeated);
	assert.equal(goal.status, 'paused');
	assert.equal(goal.reason, 'blocked');
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
	assert.deepEqual(repeatedUsage.partial?.cost, { value: 0.375, reported: 2 });
	assert.deepEqual(repeatedUsage.partial?.cacheWrite, { value: 15, reported: 2 });
	const combined = conversationMetrics([savedRecall, repeated]).usage;
	assert.equal(combined?.count, 7);
	assert.equal(combined.total, 1139);
	assert.equal(combined.cost, undefined);
	assert.deepEqual(combined.partial?.cost, { value: 0.84375, reported: 6 });
	assert.equal(combined.byKind.summary?.count, 1);
	assert.equal(combined.byKind.review?.count, 2);
	assert.equal(summarized.length, 1);
	assert.equal(reviewed.length, 2);
});

void test('reconnecting without a usage receipt keeps the known per-run and whole-chat usage after reopening', async (t) => {
	const { connect } = await fixture(t);
	const initial = { reportedUsage: { input: 20, cacheRead: 4, cacheWrite: 0, output: 6 }, total: 0.25 };
	const recovered = { reportedUsage: { input: 32, cacheRead: 8, cacheWrite: 0, output: 10 }, total: 0.5 };
	let requests = 0;
	const sessions = connect((request) => {
		switch (++requests) {
			case 1: return reply('第一轮完成。', [], initial);
			case 2: {
				const disconnected = reply('');
				return { ...disconnected,
					async *[Symbol.asyncIterator]() {
						await request.beforeSend?.('https://fixture.test/chat');
						yield* disconnected;
					},
					result: () => Promise.reject(new RetryableModelError('connection interrupted')),
				};
			}
			case 3: return reply('已重连并完成。', [], recovered);
			default: throw new Error('多余的模型请求');
		}
	});
	const id = await sessions.createConversation();
	const ask = (instruction: string) => sessions.submit({ conversationId: id, instruction, refs: [] }).result;
	const first = await ask('开始第一轮');
	const retried = await ask('开始第二轮');
	assert.equal(first.status, 'done');
	assert.equal(retried.status, 'done', retried.error);
	assert.equal(requests, 3);
	assert.deepEqual(retried.auxiliaryUsage, [{ kind: 'main-attempt' }]);
	assert.deepEqual(retried.messages.at(-1)?.reportedUsage, recovered.reportedUsage);
	sessions.dispose();
	const reopened = connect(() => assert.fail('重开聊天不应调用模型'));
	t.after(() => reopened.dispose());
	const saved = await reopened.openConversation(id);
	assert.equal(saved?.runs.length, 2);
	const states = saved.runs.map(({ state }) => state);
	const round = runUsage(states[1]!);
	const whole = conversationMetrics(states).usage;
	assert.deepEqual(round, runUsage(retried));
	assert.deepEqual(whole, conversationMetrics([first, retried]).usage);
	assert.ok(round && whole);
	assert.equal(round.count, 2);
	assert.equal(round.total, undefined);
	assert.deepEqual(round.partial?.total, { value: 50, reported: 1 });
	assert.deepEqual(round.partial?.cacheWrite, { value: 0, reported: 1 });
	assert.deepEqual(round.partial?.cost, { value: 0.5, reported: 1 });
	assert.deepEqual(whole.byKind.main?.partial, whole.partial);
	assert.equal(whole.count, 3);
	assert.deepEqual(whole.partial?.input, { value: 52, reported: 2 });
	assert.deepEqual(whole.partial?.prompt, { value: 64, reported: 2 });
	assert.deepEqual(whole.partial?.cacheRead, { value: 12, reported: 2 });
	assert.deepEqual(whole.partial?.output, { value: 16, reported: 2 });
	assert.deepEqual(whole.partial?.hit, { value: 12 / 64, reported: 2 });
	assert.deepEqual(whole.partial?.total, { value: 80, reported: 2 });
	assert.deepEqual(whole.partial?.cost, { value: 0.75, reported: 2 });
});

void test('streamed usage estimates input at transmission and keeps per-attempt usage across retries and reopening', async (t) => {
	const { connect } = await fixture(t);
	const interrupted = '相同的开头，仍在输出。';
	const recovered = '相同的开头，重试完成。';
	const beforeUpdate = '这段正文已计入下一次累计回执。';
	let markSent = () => {};
	let returnResponse = () => {};
	const requestSent = new Promise<void>((resolve) => { markSent = resolve; });
	const responseAllowed = new Promise<void>((resolve) => { returnResponse = resolve; });
	let releaseBody = () => {};
	const bodyAllowed = new Promise<void>((resolve) => { releaseBody = resolve; });
	const attempts = [
		{ snapshots: [], content: '', complete: true, final: 0, prompt: 7 },
		{ snapshots: [0], content: interrupted, complete: false, holdBody: true, prompt: 40 }, { snapshots: [], content: recovered, complete: true, final: 30 },
		{ snapshots: [4, 12], beforeUpdate, content: interrupted, complete: false }, { snapshots: [], content: recovered, complete: true, final: 30, omitPrompt: true },
		{ snapshots: [0], content: '仅在开头报告过零。', complete: true },
		{ snapshots: [0], content: '结尾重新报告了零。', complete: true, final: 0 },
		{ snapshots: [], content: interrupted, complete: false }, { snapshots: [], content: recovered, complete: true, final: 30 },
	];
	let requests = 0;
	const model = createModelService({
		read: async () => undefined, list: async () => [], modify: async (_provider, fn) => fn(undefined), delete: async () => {},
	}, {
		configure() {}, onStatus: () => () => {}, logs: () => [],
		fetch: async () => {
			const attempt = attempts[requests++];
			assert.ok(attempt, 'unexpected model request');
			if (attempt.holdBody) {
				markSent();
				await responseAllowed;
			}
			const chunk = (output: number | undefined, content = '', kind: 'delta' | 'stop' | 'usage' = 'delta') => 'data: ' + JSON.stringify({
				id: 'request-' + requests, model: firstModel.model, object: 'chat.completion.chunk', created: 1,
				choices: kind === 'usage' ? [] : [{ index: 0, delta: { content }, finish_reason: kind === 'stop' ? 'stop' : null }],
				...(output !== undefined && { usage: { completion_tokens: output, ...(!attempt.omitPrompt && { prompt_tokens: attempt.prompt ?? 0 }) } }),
			}) + '\n\n';
			const body = chunk(undefined, attempt.content);
			const frames = attempt.snapshots.map((value) => chunk(value));
			if (attempt.beforeUpdate) frames.splice(1, 0, chunk(undefined, attempt.beforeUpdate));
			frames.push(body);
			if (attempt.holdBody) frames.push(chunk(0));
			if (attempt.complete) frames.push(chunk(undefined, '', 'stop'));
			if (attempt.final !== undefined) frames.push(chunk(attempt.final, '', 'usage'), 'data: [DONE]\n\n');
			return new Response(new ReadableStream<Uint8Array>({
				async pull(controller) {
					const frame = frames.shift();
					if (frame === body && attempt.holdBody) await bodyAllowed;
					if (frame) controller.enqueue(new TextEncoder().encode(frame));
					else if (attempt.complete) controller.close();
					else controller.error(new Error('upstream stream was interrupted'));
				},
			}, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
		},
	}, { customProviders: () => [{ id: firstModel.providerId, label: 'Usage test', models: [firstModel.model],
		baseUrl: 'https://usage-fixture.invalid/v1', protocol: 'openai-completions' }] });
	const sessions = connect((request, onUsage) => model.stream(request, onUsage));
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const live: RunState[] = [];
	const retries: { shown: string; usage: ReturnType<typeof runUsage> }[] = [];
	const output = (usage: ReturnType<typeof runUsage>) => usage?.output ?? usage?.partial?.output?.value;
	const prompt = (usage: ReturnType<typeof runUsage>) => usage?.prompt ?? usage?.partial?.prompt?.value;
	const retryInputs: number[] = [];
	let inputWithoutReceipt: number | undefined;
	const confirmedZeroUpdates: number[] = [];
	for (const instruction of ['空答复', '从零开始的快照', '多次累计快照', '丢失最终用量', '最终重新确认零', '只收到正文']) {
		let displayed = emptyExecution;
		let shown = '';
		let received = () => {};
		const firstReceipt = new Promise<void>((resolve) => { received = resolve; });
		const pending = sessions.submit({ conversationId: id, instruction, refs: [] }, {
			onEvent(event) {
				displayed = updateExecution(displayed, event);
				if (event.type === 'text-delta') shown += event.text;
				const usage = displayed.state ? runUsage(displayed.state) : undefined;
				const displayedOutput = output(usage);
				const displayedPrompt = prompt(usage);
				if (instruction === '最终重新确认零' && displayedOutput !== undefined) confirmedZeroUpdates.push(displayedOutput);
				if (instruction === '从零开始的快照' && usage?.count === 2 && displayedPrompt !== undefined) retryInputs.push(displayedPrompt);
				if (instruction === '多次累计快照' && usage?.count === 2 && inputWithoutReceipt === undefined) inputWithoutReceipt = displayedPrompt;
				if (displayedPrompt === 40 && displayedOutput === 0 && !shown) received();
				if (event.type === 'model-retry') retries.push({ shown, usage });
			},
		});
		if (instruction === '从零开始的快照') {
			const timeout = timers.setTimeout(releaseBody, 5000);
			try {
				await Promise.race([requestSent, pending.result.then(() => assert.fail('请求应当已发出'))]);
				assert.ok(displayed.state);
				const sent = runUsage(displayed.state);
				const estimate = prompt(sent);
				assert.ok(estimate !== undefined && estimate > 0, '收到首个响应帧前应显示输入估算');
				assert.equal(sent?.count, 1);
				assert.equal(shown, '');
				const duringSend = conversationMetrics([...live, displayed.state]).usage;
				assert.equal(duringSend?.count, 2);
				assert.equal(prompt(duringSend), 7 + estimate);
				returnResponse();
				await Promise.race([firstReceipt, pending.result.then(() => assert.fail('正文到达前应当显示服务商回执'))]);
				assert.equal(shown, '');
				assert.ok(displayed.state);
				const current = runUsage(displayed.state);
				assert.equal(current?.count, 1);
				assert.equal(output(current), 0);
				assert.equal(current.cacheWrite ?? current.partial?.cacheWrite?.value, undefined);
				const chat = conversationMetrics([...live, displayed.state]).usage;
				assert.equal(chat?.count, 2);
				assert.equal(prompt(chat), 47);
				assert.equal(output(chat), 0);
			} finally {
				timers.clearTimeout(timeout);
				returnResponse();
				releaseBody();
				await pending.result;
			}
		}
		const state = await pending.result;
		assert.equal(state.status, 'done', state.error);
		live.push(state);
	}
	assert.equal(requests, 9);
	assert.equal(retries.length, 3);
	assert.ok(retryInputs.some((value) => value > 40), '重试发送后应保留之前已报告的 40 并加上新请求估算');
	assert.equal(retryInputs.at(-1), 40);
	assert.ok(confirmedZeroUpdates.includes(Math.ceil('结尾重新报告了零。'.length / 3.5)));
	assert.equal(confirmedZeroUpdates.at(-1), 0);
	const tailTokens = Math.ceil(interrupted.length / 3.5);
	for (const [index, retry] of retries.entries()) {
		assert.equal(retry.shown, index === 1 ? beforeUpdate + interrupted : interrupted);
		assert.equal(retry.usage?.count, 1);
		assert.equal(output(retry.usage), (index === 1 ? 12 : 0) + tailTokens);
	}
	sessions.dispose();
	const reopened = connect(() => assert.fail('reopening must not issue a request'));
	t.after(() => reopened.dispose());
	const saved = (await reopened.openConversation(id))?.runs.map(({ state }) => state);
	assert.ok(saved);
	assert.deepEqual(saved.map(runUsage), live.map(runUsage));
	assert.deepEqual(conversationMetrics(saved).usage, conversationMetrics(live).usage);
	const zero = runUsage(saved[0]!);
	assert.equal(zero?.output, 0);
	assert.equal(zero.partial, undefined);
	const retry = saved[1]!;
	assert.equal(retry.auxiliaryUsage?.[0]?.reportedUsage?.prompt, 40);
	const corrected = retry.messages.at(-1);
	assert.equal(corrected?.reportedUsage?.prompt, 0);
	assert.equal(corrected.estimatedUsage?.prompt, undefined);
	assert.equal(prompt(runUsage(retry)), 40);
	assert.ok(inputWithoutReceipt !== undefined && inputWithoutReceipt > 0);
	const outputOnly = saved[2]!.messages.at(-1);
	assert.equal(outputOnly?.reportedUsage?.prompt, undefined);
	assert.equal(outputOnly?.estimatedUsage?.prompt, inputWithoutReceipt);
	assert.equal(prompt(runUsage(saved[2]!)), inputWithoutReceipt);
	for (const [round, lastSnapshot] of [[1, 0], [2, 12], [5, undefined]] as const) {
		const state: RunState = saved[round]!;
		assert.equal(state.auxiliaryUsage?.length, 1);
		const [failed] = state.auxiliaryUsage;
		assert.equal(failed?.kind, 'main-attempt');
		assert.equal(failed.reportedUsage?.output, lastSnapshot);
		assert.equal(failed.estimatedUsage?.output, (lastSnapshot ?? 0) + tailTokens);
		const usage = runUsage(state);
		assert.equal(usage?.count, 2);
		assert.equal(output(usage), (lastSnapshot ?? 0) + tailTokens + 30);
	}
	const missingFinal = saved[3]!;
	const lastMessage = missingFinal.messages.at(-1);
	assert.equal(lastMessage?.content, '仅在开头报告过零。');
	const incomplete = runUsage(missingFinal);
	assert.equal(incomplete?.count, 1);
	const unconfirmedTokens = Math.ceil('仅在开头报告过零。'.length / 3.5);
	assert.equal(lastMessage.reportedUsage?.output, 0);
	assert.equal(lastMessage.estimatedUsage?.output, unconfirmedTokens);
	assert.equal(output(incomplete), unconfirmedTokens);
	const repeatedZero = runUsage(saved[4]!);
	assert.equal(saved[4]!.messages.at(-1)?.estimatedUsage, undefined);
	assert.equal(repeatedZero?.count, 1);
	assert.equal(repeatedZero.output, 0);
	assert.equal(repeatedZero.partial, undefined);
	const whole = conversationMetrics(saved).usage;
	assert.equal(whole?.count, 9);
	assert.equal(output(whole), 102 + 3 * tailTokens + unconfirmedTokens);
	const missingPrompt = prompt(retries[2]?.usage);
	assert.ok(missingPrompt !== undefined && missingPrompt > 0);
	assert.equal(saved[5]!.auxiliaryUsage?.[0]?.estimatedUsage?.prompt, missingPrompt);
	assert.equal(prompt(runUsage(saved[5]!)), missingPrompt);
	assert.equal(prompt(whole), 47 + missingPrompt + inputWithoutReceipt);
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
		async send(request) {
			await request.onTransmission?.('https://test.example/review');
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

void test('an unrestricted shell in automatic review mode waits for the user before writing', {
	skip: !shellTools().find(({ name }) => name === 'Bash')?.isAvailable?.(),
	timeout: 10_000,
}, async (t) => {
	const { cwd, connect, directory } = await fixture(t);
	for (const allowed of [false, true]) {
		const marker = `bash-ran-${allowed}.txt`;
		const command = `printf done > ${marker}`;
		const call: ToolCall = { id: 'checked-shell', name: 'Bash', input: { command, elevated: true } };
		let first = true;
		let reviews = 0;
		let prompts = 0;
		const sessions = connect(() => {
			if (!first) return reply('检查结束。');
			first = false;
			return reply('', [call]);
		}, firstModel, undefined, { async send() { reviews++; return reply('APPROVE').result(); } });
		t.after(() => sessions.dispose());
		const id = await sessions.createConversation();
		const state = await sessions.submit({ conversationId: id, instruction: '确认后运行测试命令。', refs: [] }, {
			async approve(operation) {
				prompts++;
				assert.equal(operation.after, command);
				assert.equal(operation.humanRequired, true);
				await assert.rejects(access(join(cwd, marker)), { code: 'ENOENT' });
				return allowed;
			},
		}, undefined, { executionMode: 'auto-review' }).result;
		assert.equal(prompts, 1);
		assert.equal(reviews, 0);
		const result = state.messages.find(({ toolCallId }) => toolCallId === call.id);
		assert.equal(result?.approvalReview, undefined);
		assert.equal(result?.isError, !allowed);
		if (allowed) assert.equal(await readFile(join(cwd, marker), 'utf8'), 'done');
		else await assert.rejects(access(join(cwd, marker)), { code: 'ENOENT' });
		const [saved] = (await createConversationStore(directory).load(id)).runs;
		assert.equal(saved?.state.messages.find(({ toolCallId }) => toolCallId === call.id)?.isError, !allowed);
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
	const dialog = dialogMessages(request);
	assert.deepEqual(dialog.map(({ role }) => role), ['user', 'assistant', 'tool', 'assistant', 'user']);
	assert.match(dialog[0]?.content ?? '', /读取笔记/);
	assert.match(dialog[0] ? promptText(dialog[0]) : '', /来自主聊天的引文/);
	assert.equal(dialog[1]?.toolCalls?.[0]?.id, read.id);
	assert.equal(dialog[2]?.toolCallId, read.id);
	assert.match(dialog[2]?.content ?? '', /银杏灯塔-733/);
	assert.match(dialog[3]?.content ?? '', /第一轮结论/);
	assert.equal(dialog[4]?.content, '把刚才的地点写成一句话。');
	const resumedHistory = await reopened.openConversation(id);
	assert.equal(resumedHistory?.runs.length, 2);
	assert.equal(resumedHistory.runs[1]?.state.messages.at(-1)?.content, '已接续。');

	const newId = await reopened.createConversation();
	assert.notEqual(newId, id);
	assert.equal((await reopened.submit({ conversationId: newId, instruction: '这是一次全新的对话。', refs: [] }).result).status, 'done');
	assert.deepEqual(dialogMessages(sent[1]).map(({ content }) => content), ['这是一次全新的对话。']);
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
		const prompt = dialogMessages(request).filter(({ role }) => role === 'user').at(-1)?.content ?? '';
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
	assert.match(requestText(sideRequests[0]), /本次任务的资料引用.*fact\.md/);
	const context = requestText(sideRequests[0]);
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
	assert.match(requestText(followRequest), /侧聊读完/);

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
	const side = connect((request) => dialogMessages(request).at(-1)?.role === 'tool' ? reply('已检查。') : reply('', calls)).createSideChat([]);

	const first = await side.submit({ instruction: '读取这次的资料', refs: [{ path: allowed, kind: 'file', addedExternal: true }] }).result;
	assert.match(first.messages.find(({ toolCallId }) => toolCallId === calls[0]?.id)?.content ?? '', /所选库外文件/);
	assert.ok(first.messages.some(({ toolCallId, isError }) => toolCallId === calls[1]?.id && isError));

	const follow = await side.submit({ instruction: '再次读取同一份资料' }).result;
	assert.ok(follow.messages.filter(({ toolCallId }) => toolCallId).every(({ isError }) => isError));
	assert.equal(follow.messages.filter(({ toolCallId }) => toolCallId).length, 2);
	side.close();
});

for (const valid of [true, false]) {
	void test(valid ? 'explicit steering skips unstarted writes and persists each paired result'
		: 'out-of-scope steering leaves its queue entry and allows the original writes', async (t) => {
		const { cwd, directory, connect } = await fixture(t);
		const store = createConversationStore(directory);
		const calls = ['A', 'B', 'C'].map((id) => ({ id, name: 'Write', input: { file_path: id + '.md', content: id } }));
		const requests: ModelRequest[] = [];
		const sessions = connect((request) => {
			requests.push(request);
			return requests.length === 1 ? reply('', calls) : reply('已核对。');
		});
		t.after(() => sessions.dispose());
		const conversationId = await sessions.createConversation();
		const external = join(directory, '..', 'private.md');
		await writeFile(external, 'private');
		const row = { id: 'correction', request: { conversationId, instruction: '只保留 A', refs: valid ? [] : [{ path: external }] } };
		const queued = { id: 'later', request: { conversationId, instruction: '稍后独立处理', refs: [] } };
		await store.enqueue(conversationId, row);
		await store.enqueue(conversationId, queued);
		let delivery: Promise<string> | undefined;
		const run = sessions.submit({ conversationId, instruction: '依次创建 A、B、C', refs: [] }, {
			approve: () => Promise.resolve(true),
			onEvent(event) {
				if (event.type === 'tool-start' && event.call.id === 'A') {
					delivery = sessions.steer(run.taskId, row).then(() => 'delivered', () => 'rejected');
				}
			},
		});
		const result = await run.result;
		assert.equal(result.status, 'done', result.error);
		assert.equal(await delivery, valid ? 'delivered' : 'rejected');
		assert.equal(await readFile(join(cwd, 'A.md'), 'utf8'), 'A');
		for (const id of ['B', 'C']) {
			const file = join(cwd, id + '.md');
			if (valid) await assert.rejects(access(file), { code: 'ENOENT' });
			else assert.equal(await readFile(file, 'utf8'), id);
		}
		const saved = await createConversationStore(directory).load(conversationId);
		const messages = saved.runs[0]!.state.messages;
		assert.deepEqual(messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, Boolean(m.skipped)]),
			[['A', false], ['B', valid], ['C', valid]]);
		assert.equal(messages.filter((m) => m.id === 'steer:correction').length, Number(valid));
		assert.deepEqual(requests.at(-1)?.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId), ['A', 'B', 'C']);
		assert.equal(requests.at(-1)?.messages.some((m) => m.id === 'steer:correction'), valid);
		assert.deepEqual(saved.queue, valid ? [queued] : [row, queued]);
	});
}

for (const scenario of ['skipped', 'completed', 'reopened']) {
	void test(`accepted steering can request a fresh read after three identical calls (${scenario})`, async (t) => {
		const beforeReads = scenario === 'skipped';
		const { cwd, directory, connect } = await fixture(t);
		await writeFile(join(cwd, 'fact.md'), '最新资料');
		const read = (id: string) => ({ id, name: 'Read', input: { file_path: 'fact.md' } });
		const batches = [['a', 'b', 'c'].map(read), [read('fresh')]];
		const sessions = connect(() => reply('核对', batches.shift()));
		t.after(() => sessions.dispose());
		const conversationId = await sessions.createConversation();
		const row = { id: 'reread', request: { conversationId, instruction: '现在重新读一次。', refs: [] } };
		await createConversationStore(directory).enqueue(conversationId, row);
		let delivery: Promise<void> | undefined;
		const run = sessions.submit({ conversationId, instruction: '读取笔记', refs: [] }, {
			onEvent(event) {
				if (scenario === 'reopened' && event.type === 'state' && event.state.pendingCalls[0]?.id === 'fresh') sessions.pause(run.taskId);
				if (!delivery && (beforeReads ? event.type === 'state' && event.state.pendingCalls.length === 3
					: event.type === 'tool-end' && event.call.id === 'c')) delivery = sessions.steer(run.taskId, row);
			},
		});
		let result = await run.result;
		await delivery;
		if (scenario === 'reopened') {
			assert.equal(result.status, 'interrupted');
			const retries = [[read('resumed')]];
			const reopened = connect(() => reply('续做', retries.shift()));
			t.after(() => reopened.dispose());
			result = await reopened.resume(conversationId, run.taskId).result;
		}
		assert.equal(result.status, 'done', result.error);
		assert.deepEqual(result.messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, !!m.skipped, !!m.isError]), [
			['a', beforeReads, beforeReads], ['b', beforeReads, beforeReads], ['c', beforeReads, beforeReads],
			...(scenario === 'reopened' ? [['fresh', true, true], ['resumed', false, false]] : [['fresh', false, false]]),
		]);
		assert.match(result.messages.filter((m) => m.role === 'tool').at(-1)!.content, /最新资料/u);
	});
}

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
	assert.deepEqual(dialogMessages(sent[3]).map(({ content }) => content), ['保留这轮', '回答 1', '修改后的指令']);
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
	const a = { id: 'a', name: 'Write', input: { file_path: 'A.md', content: '甲', intent: '写入笔记甲' } };
	const b = { id: 'b-before-close', name: 'Write', input: { file_path: 'B.md', content: '乙', intent: '写入笔记乙' } };
	const original = connect(() => reply('', [a, b]));
	const id = await original.createConversation();
	const request = { conversationId: id, instruction: '请创建 A.md 和 B.md。', refs: [] };
	const old = original.submit(request, { approve: async (preview) => {
		if (preview.target === 'A.md') { assert.equal(preview.intent, a.input.intent); return true; }
		assert.equal(preview.target, 'B.md');
		assert.equal(preview.intent, b.input.intent);
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
		contextLimits: () => ({ contextWindow: 18_000, maxTokens: 1_024 }),
		async send(request) {
			auxiliary.push(request);
			return reply(handoff).result();
		},
	};
	let compactedRequest: ModelRequest | undefined;
	const original = connect((request) => {
		if (requestText(request).includes(handoff)) {
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
	const latest = laterBatches.find((batch) => batch.at(-1)?.id === dialogMessages(compactedRequest).at(-1)?.toolCallId);
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
			assert.ok(requestText(request).includes(handoff));
			assert.ok(request.messages.some(({ toolCalls }) => toolCalls?.every(({ id }, index) => id === latest[index]?.id)
				&& toolCalls.length === latest.length));
			for (const { id } of latest) {
				const originalResult: Message | undefined = saved.state.messages.find(({ toolCallId }) => toolCallId === id);
				assert.ok(originalResult);
				const delivered = request.messages.find(({ toolCallId }) => toolCallId === id);
				assert.ok(delivered);
				assert.deepEqual({ ...delivered, content: originalResult.content }, originalResult);
				if (delivered.content !== originalResult.content) {
					assert.ok(delivered.content.startsWith(originalResult.content.split('\n')[0]!));
					assert.match(delivered.content, /已缩短[\s\S]*重新读取/u);
				}
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
	const resumed = connect((request, onUsage) => {
		const stream = reply('续做完成。', [], { reportedUsage: { output: 10 } });
		return {
			...stream,
			async *[Symbol.asyncIterator]() {
				assert.ok(request.beforeSend);
				await request.beforeSend(address);
				onUsage?.({ reportedUsage: { input: 5 }, usageStatus: 'provisional' });
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
	assert.deepEqual(completed.auxiliaryUsage?.at(-1), {
		kind: 'main-attempt', reportedUsage: { input: 5 }, usageStatus: 'provisional',
	});
	assert.deepEqual(completed.messages.at(-1)?.reportedUsage, { output: 10 });
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

void test('队列和重新编辑沿用有选择记录的库外资料', async (t) => {
	const { cwd, directory, connect } = await fixture(t);
	const store = createConversationStore(directory);
	const outside = join(cwd, '..', '资料.md');
	await writeFile(outside, '测试资料');
	const sessions = connect((request) => dialogMessages(request).at(-1)?.role === 'tool' ? reply('已核对。')
		: reply('', [{ id: 'read', name: 'Read', input: { file_path: outside } }]));
	t.after(() => sessions.dispose());
	for (const explicit of [true, false]) {
		const id = await sessions.createConversation();
		const request: TaskRequest = { conversationId: id, instruction: '读取资料。', refs: [{ path: outside, ...(explicit && { addedExternal: true }) }] };
		const message = { id: 'queued', request };
		await store.enqueue(id, message);
		const queued = await sessions.submitQueued(message, {}, () => {}).result;
		const edited = await sessions.submit(request, {}, queued.taskId).result;
		for (const state of [queued, edited]) {
			assert.equal(state.status, 'done', state.error);
			assert.equal(state.messages.find(({ toolCallId }) => toolCallId === 'read')?.isError, !explicit);
		}
	}
});

void test('续做保留只读技能工具且侧聊继承压缩后的对话和原笔记范围', async (t) => {
	const { directory, connect, setActiveNote } = await fixture(t);
	const store = createConversationStore(directory);
	const requests: ModelRequest[] = [];
	const sessions = connect((request) => { requests.push(request); return reply('已核对。'); }, firstModel, undefined, undefined, true);
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const request = { conversationId: id, instruction: '旧正文', refs: [], skillScope: ['会议'], skillNotePaths: ['会议/原稿.md'] };
	const task: Task = { id: 'paused', request, createdAt: 1, updatedAt: 1, status: 'running' };
	await store.append(id, [{ type: 'start', task, model: firstModel },
		{ type: 'messages', taskId: task.id, messages: [{ role: 'user', content: request.instruction }] }]);
	assert.equal((await sessions.resume(id, task.id).result).status, 'done');
	const tools = requests[0]!.tools.map(({ name }) => name);
	assert.ok(readOnlySkillTools.every((name) => tools.includes(name)));
	assert.ok(!tools.includes('install_skill'));
	const snapshot = await store.load(id);
	setActiveNote('另一处/新稿.md');
	const side = sessions.createSideChat(snapshot.runs, { throughTaskId: task.id, text: '原决定仅留摘要' });
	assert.deepEqual(side.skillScope, ['会议']);
	const follow = side.submit({ instruction: '继续核对' });
	assert.deepEqual(follow.request.skillNotePaths, ['会议/原稿.md']);
	assert.equal((await follow.result).status, 'done');
	const sent = requestText(requests.at(-1));
	assert.match(sent, /原决定仅留摘要/u);
	assert.doesNotMatch(sent, /旧正文|新稿/u);
	const handoff = side.submit({ instruction: '队列转来的问题', skillScope: ['课题'], skillNotePaths: ['课题/排队时打开.md'] });
	assert.deepEqual(handoff.request.skillNotePaths, ['课题/排队时打开.md']);
	await handoff.result;
});

void test('重开后内置探索及其原有下级保持只读，未知工具进度不能续做', async (t) => {
	const { directory, connect } = await fixture(t);
	const requests = new Map<string, ModelRequest>();
	const settings = { ...firstModel, providerModels: { [firstModel.providerId]: [firstModel.model] } };
	const sessions = connect((request) => { requests.set(request.sessionId!, request); return reply('完成。'); }, settings);
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const store = createConversationStore(directory);
	const task: Task = { id: 'old-root', request: { conversationId: id, instruction: '核对', refs: [] }, status: 'running', createdAt: 1, updatedAt: 1 };
	const call = { id: 'started', name: 'Edit', input: {} };
	await store.append(id, [
		{ type: 'start', task, model: firstModel },
		{ type: 'subagent', agentId: 'scout', record: { kind: 'create', agent: { id: 'scout', name: '探索', role: 'explorer', rootTaskId: task.id, model: firstModel } } },
		{ type: 'subagent', agentId: 'nested', record: { kind: 'create', agent: { id: 'nested', name: '下级', role: 'worker', parentId: 'scout', rootTaskId: task.id, model: firstModel } } },
		{ type: 'subagent', agentId: 'custom', record: { kind: 'create', instructions: '用户自定义的写作角色。', agent: { id: 'custom', name: '同名自设角色', role: 'explorer', rootTaskId: task.id, model: firstModel } } },
		{ type: 'subagent', agentId: 'scout', record: { kind: 'run', entry: { type: 'start', task: { ...task, id: 'pending' }, model: firstModel } } },
		{ type: 'subagent', agentId: 'scout', record: { kind: 'run', entry: { type: 'messages', taskId: 'pending', messages: [
			{ role: 'user', content: '核对' }, { role: 'assistant', content: '', toolCalls: [call] },
		], step: { turn: 1, phase: 'tool', call } } } },
	]);
	const controls = sessions.subagents!;
	await controls.load(id);
	await assert.rejects(controls.resume(id, 'scout', 'full-access'), /核对已保存的子任务进度/u);
	assert.equal(requests.size, 0);
	for (const agent of ['scout', 'nested', 'custom']) {
		await controls.addInstruction(id, agent, '独立核对。', 'full-access');
		await new Promise<void>((resolve) => {
			const check = () => {
				if (controls.snapshot(id).agents.find(({ id }) => id === agent)?.status === 'done') { unsubscribe(); resolve(); }
			};
			const unsubscribe = controls.subscribe(id, check);
			check();
		});
		const projected = requests.get(agent)?.tools ?? [];
		assert.ok(projected.some(({ name }) => name === 'Read'));
		assert.equal(projected.some(({ name }) => name === 'Write'), agent === 'custom');
	}
});

void test('旧队列插话沿用原记录完成出队，并把补齐的技能范围用于本轮', async (t) => {
	const { connect, directory, cwd } = await fixture(t);
	await writeFile(join(cwd, '附件.md'), '样例');
	const sessions = connect(() => reply('收到。'), firstModel, undefined, undefined, true);
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	const store = createConversationStore(directory);
	const message = { id: 'old-queue', request: { conversationId: id, instruction: '补充资料', refs: [{ path: '附件.md' }] } };
	await store.enqueue(id, message);
	const run = sessions.submit({ conversationId: id, instruction: '开始', refs: [] });
	const [result] = await Promise.all([run.result, sessions.steer(run.taskId, message)]);
	assert.equal(result.status, 'done', result.error);
	assert.deepEqual(result.messages.find(({ id }) => id === 'steer:old-queue')?.skillNotePaths, ['附件.md']);
	assert.deepEqual(await store.getQueued(id), []);
});

void test('模型提交的计划只读、可编辑，确认时核对版本和执行上下文', async (t) => {
	const { connect, cwd, directory } = await fixture(t);
	const earlier = '旧对话私有前缀，fresh 执行不应引用。';
	const original = '# 整理索引\n\n## 验收条件\n- 核对现有索引。';
	const edited = original.replace('核对现有索引', '归档已核对的索引');
	const revisedDraft = edited.replace('归档已核对的索引', '把归档规则写入计划');
	const outside = join(cwd, '..', 'plan-external.md');
	await writeFile(outside, 'EXTERNAL-PLAN-SECRET');
	const calls: ToolCall[] = [
		{ id: 'enter-plan', name: 'EnterPlanMode', input: {} },
		{ id: 'illegal-write', name: 'Write', input: { file_path: 'illegal.md', content: 'unexpected write' } },
		{ id: 'illegal-read', name: 'Read', input: { file_path: outside } },
		{ id: 'empty-submit', name: 'SubmitPlan', input: {} },
		{ id: 'save-plan', name: 'SavePlan', input: { markdown: original } },
		{ id: 'submit-plan', name: 'SubmitPlan', input: {} },
	];
	let turns = 0;
	const executions: ModelRequest[] = [];
	let continued: ModelRequest | undefined;
	const sessions = connect((request) => {
		turns++;
		if (request.messages.some(({ content }) => content === '请补充归档规则。')) {
			const previous = request.messages.find(({ toolCallId }) => toolCallId === 'read-prior-plan');
			if (previous) {
				assert.match(previous.content, /归档已核对的索引/u);
				return reply('已提交修订，请核对。');
			}
			return reply('', [
				{ id: 'read-prior-plan', name: 'ReadPlan', input: {} },
				{ id: 'save-revised-plan', name: 'SavePlan', input: { markdown: revisedDraft } },
				{ id: 'submit-revised-plan', name: 'SubmitPlan', input: {} },
			]);
		}
		if (request.messages.some(({ content }) => content === '执行后的新请求。')) {
			continued = request;
			return reply('继续处理。');
		}
		if (request.messages.some((message) => promptText(message).includes('<approved-plan>'))) {
			executions.push(request);
			return reply('已执行。');
		}
		if (turns === 1) return reply('保留旧对话。');
		if (!request.messages.some(({ toolCallId }) => toolCallId === 'submit-plan')) return reply('', calls);
		return reply('计划已提交，请确认。');
	}, firstModel, undefined, undefined, false, true);
	t.after(() => sessions.dispose());
	const id = await sessions.createConversation();
	await sessions.submit({ conversationId: id, instruction: earlier, refs: [] }).result;
	const run = await sessions.submit({ conversationId: id, instruction: '规划索引更新。', refs: [] }, {}, undefined, { executionMode: 'full-access' }).result;
	assert.equal(run.status, 'done', run.error);
	for (const callId of ['enter-plan', 'save-plan', 'submit-plan']) {
		const result = run.messages.find(({ toolCallId }) => toolCallId === callId);
		assert.equal(result?.isError, false, result?.content ?? callId);
	}
	for (const callId of ['illegal-write', 'illegal-read', 'empty-submit']) {
		assert.equal(run.messages.find(({ toolCallId }) => toolCallId === callId)?.isError, true, callId);
	}
	await assert.rejects(access(join(cwd, 'illegal.md')), { code: 'ENOENT' });
	assert.doesNotMatch(JSON.stringify(run.messages), /EXTERNAL-PLAN-SECRET/u);
	const reopened = createConversationStore(directory);
	const saved = (await reopened.load(id)).runs.at(-1);
	assert.equal(saved?.request.intent, 'plan');
	const plan = submittedPlan(saved);
	assert.ok(plan);
	assert.equal(plan.markdown, original);
	const file = join(directory, `${id}.plan.${plan.taskId}.md`);
	assert.match(await readFile(file, 'utf8'), /scribe-saved-plan: submitted/u);
	await reopened.savePlanDraft(id, plan.taskId, { submitted: true, markdown: edited }, plan.revision);
	const fork = await sessions.forkConversation(id, plan.taskId);
	const revised = submittedPlan((await reopened.load(id)).runs.at(-1));
	const forked = submittedPlan(fork.runs.at(-1));
	assert.ok(revised && forked);
	assert.equal(revised.markdown, edited);
	assert.equal(forked.revision, revised.revision);
	await assert.rejects(reopened.savePlanDraft(id, plan.taskId, { submitted: true, markdown: original }, plan.revision), /计划已变化/u);
	const stale = await sessions.submit(approvedPlanRequest(plan, 'fresh')).result;
	assert.equal(stale.status, 'failed');
	assert.match(stale.error ?? '', /计划已变化/u);
	const broadened = await sessions.submit({ ...approvedPlanRequest(revised), refs: [{ path: 'added.md', kind: 'file' }] }).result;
	assert.equal(broadened.status, 'failed');
	assert.equal(executions.length, 0);
	const revisionBranch = await sessions.forkConversation(id, plan.taskId);
	const revision = await sessions.submit({ conversationId: revisionBranch.id, instruction: '请补充归档规则。',
		intent: 'plan', revisesPlanTaskId: plan.taskId, refs: [] }).result;
	assert.equal(revision.status, 'done', revision.error);
	assert.equal(submittedPlan((await reopened.load(revisionBranch.id)).runs.at(-1))?.markdown, revisedDraft);
	assert.equal((await sessions.submit(approvedPlanRequest(revised, 'fresh')).result).status, 'done');
	assert.equal((await sessions.submit(approvedPlanRequest(forked, 'continue')).result).status, 'done');
	assert.equal(executions.length, 2);
	assert.doesNotMatch(JSON.stringify(executions[0]), new RegExp(earlier, 'u'));
	assert.match(JSON.stringify(executions[1]), new RegExp(earlier, 'u'));
	assert.match(requestText(executions[0]), /<approved-plan>[\s\S]*归档已核对的索引[\s\S]*<\/approved-plan>/u);
	const completed = await reopened.load(id);
	assert.equal(completed.runs.find(({ state }) => state.taskId === plan.taskId)?.planArchived, true);
	const executionBranch = await sessions.forkConversation(id, completed.runs.at(-1)!.state.taskId);
	const branchFromPlan = await sessions.forkConversation(executionBranch.id, plan.taskId);
	assert.equal(submittedPlan(branchFromPlan.runs.at(-1))?.markdown, edited);
	assert.equal((await sessions.submit({ conversationId: id, instruction: '执行后的新请求。', refs: [] }).result).status, 'done');
	assert.ok(continued);
	assert.doesNotMatch(JSON.stringify(continued.messages), new RegExp(earlier, 'u'));
	assert.match(JSON.stringify(continued.messages), /归档已核对的索引/u);
	await sessions.deleteConversation(id);
	await assert.rejects(access(file), { code: 'ENOENT' });
});
