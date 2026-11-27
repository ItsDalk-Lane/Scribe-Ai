import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { App } from 'obsidian';
import type { ModelRequest, ModelStream, SkillMention, SubagentNote, ToolCall } from '../../types';
import { createAgentLoop } from '../../runtime/agentLoop';
import { bindAgent } from '../../runtime/createAgent';
import { createModelCoordinator } from '../../runtime/modelCoordinator';
import { createRunState } from '../../runtime/runState';
import { createToolCoordinator } from '../../runtime/toolCoordinator';
import { createToolRegistry } from '../../tools';
import { createToolExecutor } from '../../tools/executor';
import { createMcpManager } from '../../tools/external/mcp';
import { normalizeMcpSettings } from '../../tools/external/mcpConfig';
import { createMcpTools } from '../../tools/external/mcpTools';
import { skillTools } from '../../tools/skillTools';
import { subagentTools } from '../../tools/subagentTools';
import { writeTools } from '../../tools/writeTools';
import { createContextBuilder } from '../context/contextBuilder';
import { promptText } from '../context/promptXml';
import { createSkillRegistry } from '../context/skills';
import { createSessionController } from '../sessionController';
import { normalizeSettings } from '../settings/defaults';
import { createConversationStore } from '../storage/conversationStore';
import { createTask } from '../taskManager';
import { fixtureToolIntents } from '../../runtime/tests/agentFixture';

function respond(calls: ToolCall[] = [], beforeResult?: () => Promise<void>): ModelStream {
	calls = fixtureToolIntents(calls);
	const content = calls.length ? '' : '已完成核对。';
	return {
		async *[Symbol.asyncIterator]() { /* 此测试无需模拟逐字输出。 */ },
		result: async () => {
			await beforeResult?.();
			return { content, toolCalls:calls, stopReason:calls.length ? 'tool-calls' : 'end', raw:{
			role:'assistant', api:'openai-completions', provider:'test', model:'local', timestamp:Date.now(), stopReason:calls.length ? 'toolUse' : 'stop',
			content:[...calls.map((call) => ({type:'toolCall' as const, id:call.id, name:call.name, arguments:call.input as Record<string,string>})),
				...(content ? [{type:'text' as const, text:content}] : [])],
			usage:{input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
			} };
		}, cancel() {},
	};
}

function reviewResults(request: ModelRequest): ToolCall[] {
	const reviews: ToolCall[] = [];
	const processed = new Set(request.messages.filter(({ toolName, isError }) => toolName === 'review_subagent_result' && !isError)
		.map(({ toolCallId }) => toolCallId));
	const prompt = request.messages.flatMap(({ promptSections }) => promptSections ?? [])
		.filter(({ tag, text }) => tag === 'collaboration-update' && text.startsWith('协作资料\n')).at(-1);
	const notes = prompt ? JSON.parse(prompt.text.slice(prompt.text.indexOf('\n') + 1)) as Partial<SubagentNote>[] : [];
	for (const note of notes) {
		if (note.kind === 'result' && note.review?.status === 'pending' && note.id && !processed.has('review-' + note.id)) {
			const decision = note.status === 'done' ? { decision:'use' } : { decision:'blocked', reason:'分派未完成。' };
			reviews.push({ id:'review-' + note.id, name:'review_subagent_result', input:{result_id:note.id, ...decision} });
		}
	}
	return reviews;
}

interface Scenario {
	parent: string;
	child: string;
	readOnly?: boolean;
	explorer?: boolean;
	forkCompacted?: boolean;
	pick?: boolean;
	direct?: boolean;
	mcp?: boolean;
	afterParentReceives?: (directory: string) => Promise<void>;
	childCalls(skillId: string): ToolCall[];
}

async function delegate(t: TestContext, scenario: Scenario) {
	const role = scenario.explorer ? 'explorer' : scenario.direct || scenario.readOnly ? 'proofreader' : 'worker';
	const root = await realpath(await mkdtemp(join(tmpdir(),'scribe-child-skill-')));
	const dir = join(root,'.agents','skills','manual-guide');
	await mkdir(join(dir,'agents'),{recursive:true});
	await writeFile(join(dir,'SKILL.md'),'---\nname: manual-guide\ndescription: 手动使用的核稿方法\n---\n核稿时先检查来源。');
	await writeFile(join(dir,'agents','openai.yaml'),'policy:\n  allow_implicit_invocation: false\n');
	await writeFile(join(dir,'example.md'),'样本编号 S407。');
	const app = { vault:{configDir:'fixture-config', adapter:{getBasePath:() => root},getFileByPath:() => null},
		workspace:{getActiveFile:() => null} } as unknown as App;
	const settings = normalizeSettings({providerId:'test', model:'local', providerModels:{test:['local','review-model']},
		subagents:{mode:scenario.direct ? 'explicit' : 'auto',maxDepth:1,maxConcurrent:4,roles:[
		{name:'proofreader', description:'核对出处', instructions:'核对任务涉及的材料。', readOnly:true,
			...(scenario.direct && {model:{providerId:'test',model:'review-model'}})},
	]}});
	const dialogs: string[] = [];
	const skills = createSkillRegistry(app, settings, async () => {}, {
		draft: async () => { dialogs.push('draft'); return false; }, install: async () => { dialogs.push('install'); return false; },
	});
	const mcpConfig = normalizeMcpSettings({servers: ['example', 'other'].map((id, index) => ({
		id, name:id, enabled:true, type:'http', url:`http://127.0.0.1:${4000 + index}/`,
	}))});
	const mcp = scenario.mcp ? createMcpManager({settings:() => mcpConfig, commit:() => Promise.resolve(), cwd:root,
		clientInfo:{name:'fixture',version:'1'}, openBrowser:() => {}, storage:{getSecret:() => null,setSecret:() => {}},
		connect({server}) {
			const tools = [{name:`${server.id}_tool`,description:`${server.id} helper`,inputSchema:{type:'object'}}];
			const catalog = () => Promise.resolve({tools,resources:false});
			const empty = () => Promise.resolve({content:'',isError:false});
			return {start:catalog,login:catalog,listTools:() => Promise.resolve(tools), callTool:empty,listResources:empty,
				readResource:empty,close:() => Promise.resolve(),redact:(text) => text};
		},
	}) : undefined;
	mcp?.reconcile();
	const registry = createToolRegistry([subagentTools, skillTools, writeTools, () => mcp ? createMcpTools(mcp) : []]);
	const toolCoordinator = createToolCoordinator(app, createToolExecutor(registry));
	const parentRequests: ModelRequest[] = [], childRequests: ModelRequest[] = [];
	let id: string;
	const skillId = join(dir,'SKILL.md');
	const models = createModelCoordinator({contextLimits: () => ({contextWindow: 200000, maxTokens: 8000}), stream(request) {
		if (request.sessionId === id) {
			if (scenario.direct) {
				assert.equal(sessions.subagents?.snapshot(id).agents[0]?.role, role);
				assert.ok(!request.tools.some(({ name }) => name === 'spawn_agent'));
				parentRequests.push(request);
				return respond(reviewResults(request));
			}
			parentRequests.push(request);
			return respond(parentRequests.length === 1 ? [{id:'spawn',name:'spawn_agent',input:{message:scenario.child,
				agent_type:role,fork_turns:scenario.forkCompacted ? 'all' : 'none'}}] : reviewResults(request),
			parentRequests.length === 1 && scenario.afterParentReceives ? () => scenario.afterParentReceives!(dir) : undefined);
		}
		childRequests.push(request);
		return respond(childRequests.length === 1 ? scenario.childCalls(skillId) : []);
	}}, createContextBuilder(registry));
	const runtime = { newState:createRunState, createAgent:bindAgent(createAgentLoop(models,toolCoordinator,mcp)),models,tools:toolCoordinator };
	const store = createConversationStore(join(root, 'history'));
	const sessions = createSessionController(app,settings,runtime,store,undefined,undefined,undefined,skills);
	t.after(async () => { sessions.dispose(); mcp?.dispose(); await rm(root,{recursive:true,force:true}); });
	id = await sessions.createConversation();
	if (scenario.forkCompacted) {
		const task = createTask({ conversationId: id, instruction: '压缩前的材料', refs: [] });
		await store.append(id, [{ type: 'start', task, model: { providerId: 'test', model: 'local' } },
			{ type: 'messages', taskId: task.id, messages: [{ role: 'user', content: task.request.instruction }] },
			{ type: 'finish', taskId: task.id, status: 'done', turn: 1 }]);
		await store.saveManualCompaction(id, { throughTaskId: task.id, text: '核对规则已确认' });
	}
	const all = await skills.list();
	const skillMentions: SkillMention[] = scenario.pick ? all.flatMap((skill) => {
		const start = scenario.parent.indexOf('$'+skill.name);
		return start < 0 ? [] : [{name:skill.name,id:skill.id,start,end:start + skill.name.length + 1}];
	}) : [];
	const result = await sessions.submit({conversationId:id,instruction:scenario.parent,refs:[],skillMentions,
		...(scenario.direct && {target:{kind:'agent', id:role,label:role} as const}),
		...(scenario.mcp && {target:{kind:'mcp', id:'example',label:'示例服务'} as const}),
	}, {}, undefined,{executionMode:scenario.explorer ? 'full-access' : 'ask'}).result;
	assert.equal(result.status,'done', result.error);
	const agents = sessions.subagents!.snapshot(id).agents;
	const child = agents[0];
	assert.ok(child?.runs.length);
	return {parentRequests, childRequests, dialogs, state:child.runs.at(-1)!.state, agents};
}

const readExample = (id: string): ToolCall[] => [{id:'sample',name:'read_skill',input:{id,file:'example.md'}}];

void test('继承完整对话的子任务沿用手动压缩摘要', async (t) => {
	const result = await delegate(t, { parent: '分工核对。', child: '查找资料。', forkCompacted: true, childCalls: () => [] });
	const inherited = result.childRequests[0]!.messages.map(promptText).join('\n');
	assert.match(result.childRequests[0]?.system ?? '', /你是(?:独立)?子助手/u);
	assert.match(inherited, /核对规则已确认/u);
	assert.doesNotMatch(inherited, /压缩前的材料/u);
});

for (const direct of [false, true]) {
	void test(`完全访问下${direct ? '点选' : '委派'}的内置探索角色仍只读`, async (t) => {
		const result = await delegate(t, { direct, explorer: true, parent: '查找资料。', child: '核对资料。', childCalls: () => [] });
		assert.ok(result.parentRequests[0]?.tools.some(({ name }) => name === 'Write'));
		assert.ok(result.childRequests.length);
		assert.ok(result.childRequests.every(({ tools }) => !tools.some(({ name }) => name === 'Write')));
	});
}

void test('用户直接选择的子 Agent 立即使用角色模型和点选技能，主聊天收取同一份结果', {timeout:10000}, async (t) => {
	const result = await delegate(t, {direct:true, parent:'请用 $manual-guide 核对样本。', child:'', pick:true, childCalls:readExample});
	assert.equal(result.agents.length, 1);
	assert.equal(result.agents[0]?.role, 'proofreader');
	assert.equal(result.childRequests[0]?.model, 'review-model');
	assert.ok(result.childRequests[0]?.messages.flatMap(({ promptSections }) => promptSections ?? [])
		.some(({ tag, text }) => tag === 'subagent-assignment' && text === '核对任务涉及的材料。'));
	assert.ok(result.parentRequests[0]?.messages.flatMap(({ promptSections }) => promptSections ?? [])
		.some(({ tag, text }) => tag === 'subagent-state' && text.includes('用户选定的子助手 proofreader')));
	assert.ok(result.childRequests[0]?.messages.some((message) => promptText(message).includes('核稿时先检查来源')));
	assert.ok(result.parentRequests.some(({ messages }) => messages.some(({ toolName }) => toolName === 'review_subagent_result')));
	assert.equal(result.state.status, 'done', result.state.error);
});

void test('分派时 MCP 范围随任务交给可调用的子 Agent', {timeout:10000}, async (t) => {
	const scenario: Scenario = {mcp:true, parent:'请分派核对资料。', child:'核对资料。', childCalls:() => []};
	const writable = await delegate(t, scenario);
	assert.deepEqual(writable.agents[0]?.runs[0]?.request.target, {kind:'mcp', id:'example',label:'示例服务'});
	assert.ok(writable.childRequests[0]?.tools.some(({ description }) => description.includes('example helper')));
	assert.ok(!writable.childRequests[0]?.tools.some(({ description }) => description.includes('other helper')));
	const readOnly = await delegate(t, {...scenario, readOnly:true});
	assert.equal(readOnly.agents[0]?.runs[0]?.request.target, undefined);
	assert.ok(!readOnly.childRequests[0]?.tools.some(({ name }) => name.startsWith('mcp_')));
});

for (const pick of [true,false]) {
	void test((pick ? '菜单点选' : '直接键入') + '的手动技能可随分派继承并读取附件', {timeout:10000}, async (t) => {
		const result = await delegate(t, {parent:'请用 $manual-guide 分派核稿。', child:'请核对这次指定技能的配套样本。', pick, childCalls:readExample});
		assert.ok(result.parentRequests[0]?.messages.some((message) => promptText(message).includes('核稿时先检查来源')));
		assert.equal(result.state.status, 'done',result.state.error);
		const sample = result.childRequests.flatMap((request) => request.messages).find((m) => m.toolCallId === 'sample');
		assert.equal(sample?.isError, false, sample?.content);
		assert.match(sample.content,/样本编号 S407/u);
	});
}

void test('主模型在分派里自行点名不会授权仅限手动的技能', {timeout:10000}, async (t) => {
	const result = await delegate(t,{parent:'分派核稿。',child:'请用 $manual-guide 核稿。',childCalls:readExample});
	assert.equal(result.state.status,'failed');
	assert.match(result.state.error ?? '', /仅限用户点选/u);
	assert.equal(result.childRequests.length,0);
});

void test('分派前原技能改名且出现同名来源时，子任务保留最初选择', {timeout:10000}, async (t) => {
	const result = await delegate(t,{parent:'用 $manual-guide 核稿。',child:'请用 $manual-guide 核稿。',pick:true,childCalls:() => [],
		afterParentReceives:async (dir) => {
			await writeFile(join(dir,'SKILL.md'),'---\nname: renamed\ndescription: 另一个用法\n---\n原位置的新指令。');
			const duplicate = join(dir,'..','alternative');
			await mkdir(duplicate);
			await writeFile(join(duplicate,'SKILL.md'),'---\nname: manual-guide\ndescription: 另外的来源\n---\n同名替代来源的指令。');
		},
	});
	assert.equal(result.state.status,'done',result.state.error);
	assert.ok(result.childRequests.length);
	for (const request of result.childRequests) for (const message of request.messages) {
		assert.doesNotMatch(promptText(message),/原位置的新指令|同名替代来源的指令/u);
	}
});

void test('明确选定了创建和安装技能后，只读子任务仍不能创建或安装', {timeout:10000}, async (t) => {
	const request = '用 $skill-creator 和 $skill-installer 核对安装流程。';
	const result = await delegate(t,{parent:request,child:request,readOnly:true,pick:true,childCalls:() => [
		{id:'draft',name:'propose_skill',input:{content:'---\nname: test\ndescription: 示例\n---\n示例内容'}},
		{id:'install',name:'install_skill',input:{source:'https://example.invalid/fixture'}},
	]});
	assert.equal(result.state.status, 'done',result.state.error);
	for (const name of ['propose_skill','install_skill']) {
		assert.ok(result.parentRequests[0]!.tools.some((tool) => tool.name === name));
		assert.ok(!result.childRequests[0]!.tools.some((tool) => tool.name === name));
		const rejected = result.state.messages.find((m) => m.toolName === name);
		assert.equal(rejected?.isError,true);
		assert.match(rejected.content,/未授权/u);
	}
	assert.deepEqual(result.dialogs,[]);
});
