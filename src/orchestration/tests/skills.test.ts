import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { App } from 'obsidian';
import { createSkillRegistry } from '../context/skills';
import { createSkillRun, renderSkillCatalog } from '../context/skillRun';
import { createContextBuilder, taskMessage } from '../context/contextBuilder';
import { createRunContext } from '../runContext';
import { normalizeSettings } from '../settings/defaults';
import { createTask } from '../taskManager';
import { createToolRegistry } from '../../tools';
import { skillTools } from '../../tools/skillTools';
import { installSharedPackage } from '../../skills/installTarget';
import type { Message, TaskRequest } from '../../types';

void test('技能从真实文件发现，点名首次投递，自动加载按页重验并服从当前权限', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-skill-run-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const vault = join(root, 'vault'), shared = join(root, 'shared');
	await mkdir(vault);
	const config = normalizeSettings(null);
	config.skillSettings!.sharedDirectories = [shared];
	const body = '先摘录引文，再标注出处。';
	for (const [base, label] of [[join(vault, '小说', '.agents', 'skills'), '项目'], [shared, '个人']]) {
		const skill = join(base!, 'outline');
		await mkdir(join(skill, 'agents'), { recursive: true });
		await writeFile(join(skill, 'SKILL.md'), `---\nname: outline\ndescription: 整理章节提纲\n---\n${label} ${body}`);
		await writeFile(join(skill, 'example.md'), '资源内容' + 'a'.repeat(21000));
		await writeFile(join(skill, 'agents/openai.yaml'), `interface:\n  display_name: "${label}提纲"\npolicy:\n  allow_implicit_invocation: ${label === '个人'}\n`);
	}
	const app = { vault: { adapter: { getBasePath: () => vault }, configDir: '.test-settings' },
		workspace: { getActiveFile: () => ({ path: '小说/第一章.md' }) } } as unknown as App;
	const registry = createSkillRegistry(app, config, () => Promise.resolve(), { draft: async () => false, install: async () => false });
	const list = await registry.list();
	const options = list.filter((s) => s.name === 'outline');
	assert.equal(options.length, 2);
	const local = options.find((s) => !s.implicit)!, personal = options.find((s) => s.implicit)!;
	assert.ok(local.displayName === '项目提纲' && personal.displayName === '个人提纲');
	assert.equal((await registry.list([], '')).filter((s) => s.name === 'outline').length, 1);
	assert.equal(list.filter((s) => s.sourceLabel === '内置').length, 7);
	const signal = new AbortController().signal;
	const request: TaskRequest = { conversationId: 'chat', instruction: '$outline 帮我写', refs: [], skillScope: registry.scope() };
	const runtime = createSkillRun(registry, request, 32_000, signal);
	await assert.rejects(runtime.project([taskMessage(request)], true), /选择来源/);
	request.skillMentions = [{ id: local.id, name: local.name, start: 0, end: 8 }];
	const task = createTask(request);
	const ctx = await createRunContext(task, { cwd: vault, model: { model: 'test', providerId: 'test' }, observer: {}, signal }, '.test-settings', () => true, true);
	ctx.skillRun = runtime;
	const tools = createToolRegistry([skillTools]);
	const builder = createContextBuilder(tools);
	const initial = taskMessage(request);
	const first = await builder.build(ctx, [initial], 100_000);
	assert.ok(first.messages.some((m) => m.content.includes('项目 ' + body)));
	assert.ok(!first.messages.some((m) => m.content.includes('个人 ' + body)));
	assert.ok(!first.system!.includes('项目 ' + body));
	assert.ok(first.tools.some((s) => s.name === 'read_skill'));
	assert.ok(!first.tools.some((s) => s.name === 'propose_skill' || s.name === 'install_skill'));
	assert.doesNotMatch(initial.content, /摘录/);
	const localText = await readFile(local.id, 'utf8');
	await writeFile(local.id, localText.replace('name: outline', 'name: renamed'));
	await assert.rejects(runtime.read(local.id, 'example.md', 0), /需要用户点名/);
	assert.doesNotMatch(await runtime.list(0), /"renamed"/);
	await writeFile(local.id, localText);
	const receipt = await runtime.read(personal.id, 'example.md', 0);
	// 模型可能把清单里的名称当作标识传入；名称唯一时按名称也能读取，并返回真实标识。
	const builtin = list.find((s) => s.sourceLabel === '内置' && s.implicit)!;
	const namedReceipt = await runtime.read(builtin.name, 'SKILL.md', 0);
	assert.equal((JSON.parse(namedReceipt.split('\n').at(-1)!) as { id: string }).id, builtin.id);
	const call: Message = { role: 'assistant', content: '', toolCalls: [{ id: 'read1', name: 'read_skill', input: { id: personal.id, file: 'example.md' } }] };
	const result: Message = { role: 'tool', content: receipt, toolCallId: 'read1', toolName: 'read_skill' };
	const next = await builder.build(ctx, [initial, call, result], 100_000);
	assert.match(next.messages.at(-1)!.content, /资源内容[\s\S]*下一页 offset=20000/u);
	assert.doesNotMatch(receipt, /资源内容/u);
	await writeFile(join(shared, 'outline/example.md'), '已更新的资源');
	assert.match((await builder.build(ctx, [initial, call, result], 100_000)).messages.at(-1)!.content, /重新读取/u);
	await symlink(join(root, 'outside'), join(shared, 'outline/outside.md'));
	await writeFile(join(root, 'outside'), '外部文件');
	await assert.rejects(runtime.read(personal.id, 'outside.md', 0), /授权目录/);
	config.skillSettings!.sharedDirectories = [];
	await assert.rejects(runtime.read(personal.id, 'SKILL.md', 0), /不在本轮/);
	await registry.setEnabled(local.id, false);
	await assert.rejects(builder.build(ctx, [initial], 100_000), /已停用/);
	const tiny = renderSkillCatalog(list, { ...config.skillSettings!, catalogBudgetMaxTokens: 1 });
	assert.ok(tiny.omitted.length && tiny.list === '');
});

void test('用户选定的共享保存目标独立于本库，重复安装保留原件', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-skill-share-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pkg = { name: 'my-skill', source: { kind: 'agent' as const }, files: [{ path: 'SKILL.md', data: Buffer.from('说明') }] };
	const signal = new AbortController().signal;
	await assert.rejects(installSharedPackage(pkg, root, () => [], signal), /已失效/);
	await installSharedPackage(pkg, root, () => [root], signal);
	await assert.rejects(installSharedPackage(pkg, root, () => [root], signal), /已有同名/);
	assert.equal(await readFile(join(root, 'my-skill/SKILL.md'), 'utf8'), '说明');
});

void test('创建预览只写入确认的位置，同名草稿保留原件', async (t) => {
	const vault = await realpath(await mkdtemp(join(tmpdir(), 'scribe-skill-review-')));
	t.after(() => rm(vault, { recursive: true, force: true }));
	const shared = join(vault, 'shared'), configDir = join(vault, '.test-settings');
	await Promise.all([mkdir(shared), mkdir(configDir)]);
	const settings = normalizeSettings(null);
	settings.skillSettings!.sharedDirectories = [shared, configDir];
	let target: string | undefined;
	const app = { vault: { adapter: { getBasePath: () => vault }, configDir: '.test-settings' } } as unknown as App;
	const registry = createSkillRegistry(app, settings, async () => {}, {
		async draft(content, save) { await save(content, target); return true; }, install: async () => false,
	});
	const signal = new AbortController().signal;
	const draft = '---\nname: review-example\ndescription: 检查保存位置\n---\n原文';
	await registry.propose(draft, signal);
	await assert.rejects(registry.propose(draft + '修改', signal), /同名/);
	assert.match(await registry.library.readFile('review-example', 'SKILL.md'), /原文$/);
	target = shared;
	await registry.propose(draft + '共享', signal);
	assert.match(await readFile(join(shared, 'review-example/SKILL.md'), 'utf8'), /原文共享$/);
	target = configDir;
	await assert.rejects(registry.propose(draft, signal), /配置目录/);
});

void test('技能清单按中文实际字节计算容量，公平保留说明和完整字符', () => {
	const skill = { name: '笔记', id: '本库', enabled: true, implicit: true, manual: true, sourceLabel: '库', description: '📖提纲'.repeat(80) };
	const settings = { ...normalizeSettings(null).skillSettings!, catalogBudgetMaxTokens: 35 };
	const { list, omitted, shortened } = renderSkillCatalog([skill, { ...skill, id: '共享' }], settings, 100_000);
	const lines = list.split('\n');
	assert.equal(lines.length, 2);
	assert.deepEqual(omitted, []);
	assert.ok(shortened);
	assert.ok(lines.reduce((sum, line) => sum + Math.ceil((Buffer.byteLength(line) + 1) / 4), 0) <= 35);
	for (const line of lines) assert.match((JSON.parse(line) as string[])[2]!, /^📖/u);
});
