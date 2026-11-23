import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createSkillLibrary } from './index';
import { createPermissionPolicy } from '../../orchestration/policies/permissions';
import { hasMacShellSandbox, macSandboxExecutable, macShellSandboxArgs } from '../../tools/external/macosShellSandbox';
import type { ToolContext } from '../../types';
import { resolveSystemSkillRoots } from './systemSkillSearch';

const zip = 'UEsDBAoAAAAAAIgydl0AAAAAAAAAAAAAAAAHAAAAemlwcGVkL1BLAwQUAAgACACIMnZdAAAAAAAAAAA0AAAADwAAAHppcHBlZC9TS0lMTC5tZNPV1eXKS8xNtVKoyiwoSE3hSkktTi7KLCjJzM+zUogCiykUZ2fm5HDpApV6pObk5AMAUEsHCOrWhGIyAAAANAAAAFBLAwQUAAgACACIMnZdAAAAAAAAAAAIAAAAEQAAAHppcHBlZC9zYW1wbGUudHh0K0otzi8tSk4FAFBLBwgW9JG8CgAAAAgAAABQSwECHgMKAAAAAACIMnZdAAAAAAAAAAAAAAAABwAAAAAAAAAAABAA7UEAAAAAemlwcGVkL1BLAQIeAxQACAAIAIgydl3q1oRiMgAAADQAAAAPAAAAAAAAAAEAAACkgSUAAAB6aXBwZWQvU0tJTEwubWRQSwECHgMUAAgACACIMnZdFvSRvAoAAAAIAAAAEQAAAAAAAAABAAAApIGUAAAAemlwcGVkL3NhbXBsZS50eHRQSwUGAAAAAAMAAwCxAAAA3QAAAAAA';
function document(name: string, description = '整理会议记录') {
	return '---\nname: ' + name + '\ndescription: ' + description + '\n---\n按照日期整理。\n';
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'scribe-skill-test-'));
	return { root, lib: createSkillLibrary(root), close: () => rm(root, { recursive: true, force: true }) };
}

void test('内置技能随许可安装，修改保护、停用、卸载和恢复均跨重开生效', async () => {
	const { lib, root, close } = await fixture();
	try {
		const list = await lib.list();
		assert.equal(list.length, 7);
		assert.ok(list.every((skill) => skill.source.kind === 'builtin' && skill.enabled && !skill.error));
		for (const skill of list) {
			assert.ok((await lib.listFiles(skill.name)).some((path) => /^LICENSE/iu.test(path)));
		}
		const text = await lib.readFile('skill-creator','SKILL.md');
		await assert.rejects(lib.saveFile('skill-creator','SKILL.md',text+'a',text), /只读/u);
		await lib.setEnabled('skill-creator',false);
		assert.equal((await lib.builtinStatus()).find((item) => item.name === 'skill-creator')?.status,'installed');
		assert.equal((await createSkillLibrary(root).list()).find((item) => item.name === 'skill-creator')?.enabled, false);
		await lib.remove('knap');
		assert.ok(!(await createSkillLibrary(root).list()).some((item) => item.name === 'knap'));
		await lib.restore('knap');
		assert.ok((await lib.list()).some((item) => item.name === 'knap'));
		const main = join(lib.directory,'knap','SKILL.md');
		const saved = await readFile(main,'utf8');
		await writeFile(main, saved + '第一次外部修改');
		const rev = await lib.revision('knap');
		await writeFile(main, saved + '最新修改');
		await assert.rejects(lib.restore('knap','modified',rev), /已改变/u);
		assert.equal(await readFile(main,'utf8'),saved + '最新修改');
		await lib.restore('knap','modified',await lib.revision('knap'));
		assert.equal(await readFile(main,'utf8'),saved);
	} finally { await close(); }
});

void test('导入前显示修复和来源，更新需重新预览；个人草稿、计数和改名保留', async () => {
	const { lib, root, close } = await fixture();
	try {
		const path = join(root, 'minutes.md');
		const original = document('minutes','purpose: weekly');
		await writeFile(path, original);
		const first = await lib.previewLocal(path);
		assert.equal(first.repairs.length,1);
		assert.equal(first.status,'new');
		assert.ok(!(await lib.list()).some((skill) => skill.name === first.name));
		await lib.install(first);
		assert.equal(await readFile(path,'utf8'), original);
		const stale = await lib.previewLocal(path);
		assert.equal(stale.status,'replace');
		const expected = await lib.readFile('minutes','SKILL.md');
		const edited = expected + 'a';
		await lib.saveFile('minutes','SKILL.md',edited,expected);
		await assert.rejects(lib.install(stale));
		await assert.rejects(lib.saveFile('minutes','SKILL.md',expected,expected));
		await lib.recordUse('minutes','manual');
		const state = (await lib.list({ withRevisions: true })).find((entry) => entry.name === 'minutes')!;
		await lib.saveMetadata('minutes',{displayName:'会议纪要'},state);
		await assert.rejects(lib.saveMetadata('minutes',{displayName:'旧草稿'},state));
		await assert.rejects(lib.remove('minutes',state.revision));
		const latest = await lib.readFile('minutes','SKILL.md');
		await lib.saveFile('minutes','SKILL.md', latest.replace('name: minutes','name: notes'),latest);
		const renamed = (await lib.list()).find((item) => item.name === 'notes')!;
		assert.equal(renamed.usage.count,1);
		assert.equal(renamed.usage.lastSource,'manual');
		const again = await lib.previewLocal(path);
		assert.equal(again.name, 'notes');
		assert.equal(again.status, 'replace');
		const aborted = new AbortController();
		const draft = await lib.previewDraft(document('future'));
		aborted.abort();
		await assert.rejects(lib.install(draft,aborted.signal));
		assert.ok(!(await lib.list()).some((item) => item.name === 'future'));
	} finally { await close(); }
});

void test('压缩包保留配套文件，同名不同来源不会覆盖；链接与危险路径被拒绝', async () => {
	const { lib, root, close } = await fixture();
	try {
		const archive = join(root,'package.zip');
		await writeFile(archive,Buffer.from(zip,'base64'));
		const packed = await lib.previewLocal(archive);
		assert.deepEqual(packed.files,['SKILL.md','sample.txt']);
		await lib.install(packed);
		assert.equal(await lib.readFile('zipped','sample.txt'),'resource');
		const external = join(root,'zipped');
		await mkdir(external);
		await writeFile(join(external,'SKILL.md'), document('zipped'));
		const other = await lib.previewLocal(external,'system');
		assert.equal(other.status,'conflict');
		await assert.rejects(lib.install(other));
		await assert.rejects(lib.readFile('zipped','../future/SKILL.md'));
		await symlink(archive, join(external,'other.zip'));
		await assert.rejects(lib.previewLocal(external,'system'));
		assert.ok(resolveSystemSkillRoots(root, { CODEX_HOME: 'custom' }).some((item) => item.path === join(root,'custom','skills')));
		await assert.rejects(lib.previewGithub('https://example.org/one/two'));
	} finally { await close(); }
});


void test('Codex 显示信息、图标及 MCP 提示按真实文件读取并更新', async () => {
	const { lib, root, close } = await fixture();
	try {
		const source = join(root, 'review');
		await mkdir(join(source,'agents'), {recursive:true});
		await mkdir(join(source,'assets'));
		await writeFile(join(source,'SKILL.md'), document('review'));
		await writeFile(join(source,'assets','mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h8v8z"/></svg>');
		const spec = ['interface:', '  display_name: Original', '  icon_large: ./assets/mark.svg', '  brand_color: "#112233"',
			'policy:', '  allow_implicit_invocation: false','dependencies:', '  tools:', '    - type: mcp', '      value: example',
			'upstream_version: 90071992547409931413', ''].join('\n');
		await writeFile(join(source,'agents','openai.yaml'), spec);
		await lib.install(await lib.previewLocal(source));
		const skill = (await lib.list()).find((item) => item.name === 'review')!;
		assert.equal(skill.allowImplicit, false);
		assert.equal(skill.displayName, 'Original');
		assert.equal(skill.dependencies[0]?.name, 'example');
		assert.match((await lib.readIcon('review'))!, /^data:image\/svg\+xml;base64,/u);
		await lib.saveMetadata('review',{displayName:'Revised', defaultPrompt:'请检查'}, skill);
		const revised = await lib.readFile('review','agents/openai.yaml');
		assert.ok(revised.includes('display_name: Revised'));
		assert.ok(revised.includes('default_prompt: 请检查'));
		assert.ok(revised.includes('upstream_version: 90071992547409931413'));
		assert.equal(await readFile(join(source,'agents','openai.yaml'),'utf8'),spec);
	} finally { await close(); }
});

void test('自动推荐范围写入技能说明、保护并发修改，并可清空', async () => {
	const { lib, close } = await fixture();
	try {
		const info = async () => (await lib.list()).find((item) => item.name === 'scoped')!;
		const text = document('scoped').replace('\n---\n', '\npaths:\n  - "旧笔记.md"\ncustom: keep\n---\n');
		await lib.install(await lib.previewDraft(text));
		const original = await info();
		assert.deepEqual(original.paths, ['旧笔记.md']);
		await lib.saveMetadata('scoped', { paths: ['  会议/ ', '', '项目/**/*.{md,txt}', '会议/'] }, original);
		const changed = await info();
		assert.deepEqual(changed.paths, ['会议/', '项目/**/*.{md,txt}']);
		assert.equal(changed.userInvocable, true);
		assert.equal(changed.allowImplicit, true);
		await assert.rejects(lib.saveMetadata('scoped', { paths: ['旧笔记.md'] }, original), /重新载入/u);
		await assert.rejects(lib.saveMetadata('scoped', { paths: ['../私人.md'] }, changed), /无效/u);
		await assert.rejects(lib.saveMetadata('scoped', { paths: ['/私人.md'] }, changed), /无效/u);
		await assert.rejects(lib.saveMetadata('scoped', { paths: ['项目/*.{md,txt'] }, changed), /无效/u);
		const saved = await lib.readFile('scoped', 'SKILL.md');
		assert.match(saved, /custom: keep\n/u);
		assert.match(saved, /按照日期整理。/u);
		await lib.saveMetadata('scoped', { paths: ['  '] }, changed);
		assert.equal((await info()).paths, undefined);
		assert.doesNotMatch(await lib.readFile('scoped', 'SKILL.md'), /^paths:/mu);
	} finally { await close(); }
});


void test('普通文件工具只读管理记录和内置包，同名个人技能仍可修复', async () => {
	const { lib, root, close } = await fixture();
	try {
		const collision = join(lib.directory,'defuddle');
		await mkdir(collision,{recursive:true});
		await writeFile(join(collision,'SKILL.md'),document('defuddle'));
		await lib.list();
		const policy = await createPermissionPolicy(root,'vault-settings',[{path:'.scribe-ai/skills',kind:'folder'}],() => true,'ask');
		for (const file of ['.registry.json','.operations/active','.usage.json','knap/SKILL.md']) {
			const target = join(lib.directory,file);
			assert.equal(policy.canRead(target), true);
			assert.equal(policy.canWrite(target), false);
		}
		assert.equal(policy.canWrite(join(collision,'SKILL.md')), true);
		assert.equal(policy.canWrite(join(lib.directory,'minutes','SKILL.md')), true);
		const full = await createPermissionPolicy(root,'vault-settings',[],() => true,'full-access');
		assert.equal(full.canWrite(join(lib.directory,'knap','SKILL.md')),true);
	} finally { await close(); }
});

void test('macOS 受限命令保护内置文件与管理记录，个人技能的本地脚本照常执行', {skip:!hasMacShellSandbox()}, async () => {
	const {lib,root,close} = await fixture();
	try {
		await lib.list();
		const permission = await createPermissionPolicy(root,'vault-settings',[],() => true,'ask');
		const ctx = {cwd:root, app:{vault:{configDir:'vault-settings'}},task:{request:{refs:[]}}, permissions:permission} as unknown as ToolContext;
		const args = await macShellSandboxArgs(ctx);
		const command = (text: string, file: string) => promisify(execFile)(macSandboxExecutable,[...args,'/bin/bash','--noprofile','--norc','-c',text,'scribe',relative(root,file)],{cwd:root});
		for (const file of ['.registry.json','knap/SKILL.md']) {
			const target = join(lib.directory,file);
			const original = await readFile(target,'utf8');
			await command('test -s "$1"',target);
			await assert.rejects(command('printf x >> "$1"',target));
			assert.equal(await readFile(target,'utf8'),original);
		}
		const sample = join(lib.directory,'sample');
		await command('/bin/mkdir "$1"',sample);
		const script = join(sample, 'example.sh');
		await writeFile(script, 'printf ready');
		assert.equal((await command('/bin/bash "$1"',script)).stdout,'ready');
		await command('printf updated > "$1"',join(sample,'output.txt'));
		assert.equal(await readFile(join(sample,'output.txt'),'utf8'),'updated');
	} finally { await close(); }
});
