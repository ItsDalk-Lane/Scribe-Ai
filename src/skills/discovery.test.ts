import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createLiveSkillCache, discoverLiveSkills, listSkillFiles, skillScope, skillText } from './discovery';
import type { SkillScanIssue } from './discovery';

const configDir = '.test-settings';

async function fixture(t: TestContext) {
	const temp = await realpath(await mkdtemp(join(tmpdir(), 'scribe-skill-discovery-')));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const vault = join(temp, 'vault'), shared = join(temp, 'shared');
	await Promise.all([mkdir(vault), mkdir(shared)]);
	return { temp, vault, shared };
}
async function skill(directory: string, name: string, description = '示例') {
	await mkdir(directory, { recursive: true });
	const id = join(directory, 'SKILL.md');
	await writeFile(id, '---\nname: ' + name + '\ndescription: ' + description + '\n---\n正文');
	return id;
}

void test('项目技能按笔记祖先逐级发现，同名分开，外部引用不会扩大范围', async (t) => {
	const { vault, shared } = await fixture(t);
	for (const folder of ['', '项目', '项目/章节', '其他']) {
		await skill(join(vault, folder, '.agents/skills/test'), 'test');
	}
	const projectPath = join(vault, '项目/章节/.agents/skills/test/SKILL.md');
	await writeFile(projectPath, '---\nname: test\ndescription: 示例\npaths: "项目/章节/A.md"\n---\n正文');
	const sharedPath = await skill(join(shared, 'test'), 'test');
	await writeFile(sharedPath, '---\nname: test\ndescription: 示例\npaths:\n  - " 项目/**/*.md "\n  - "其他/"\n---\n正文');
	assert.deepEqual(skillScope([{ path: '/outside/note.md' }], '项目/章节/A.md'), ['项目/章节']);
	assert.deepEqual(skillScope([{ path: '其他', kind: 'folder' }], '项目/章节/A.md'), ['其他']);
	const all = await discoverLiveSkills(vault, configDir, ['项目/章节', '../', configDir], [shared], new Set());
	assert.equal(all.length, 4);
	assert.equal(new Set(all.map((item) => item.id)).size, 4);
	assert.ok(all.every((item) => item.name === 'test' && !item.id.includes('其他')));
	assert.deepEqual(all.find((item) => item.id === projectPath)?.paths, ['项目/章节/A.md']);
	assert.deepEqual(all.find((item) => item.id === sharedPath)?.paths, ['项目/**/*.md', '其他/']);
	assert.equal(all.find((item) => item.id === join(vault, '.agents/skills/test/SKILL.md'))?.paths, undefined);
});

void test('技能元数据按文件状态复用，修改说明、增删界面说明和失效文件都能反映', async (t) => {
	const { vault, shared } = await fixture(t);
	const dir = join(shared, 'usable'), cache = createLiveSkillCache();
	const id = await skill(dir, 'usable', '初版');
	const invalid = await skill(join(shared, 'bad'), 'x'.repeat(65));
	const sidecar = join(dir, 'agents/openai.yaml');
	async function inspect(disabled = new Set<string>()) {
		const issues: SkillScanIssue[] = [];
		const result = await discoverLiveSkills(vault, configDir, [], [shared], disabled, { cache, issues });
		assert.deepEqual(result.map((item) => item.id), [id]);
		assert.ok(issues.some((issue) => issue.path === invalid && issue.reason.includes('64')));
		return { item: result[0]!, issues };
	}
	assert.equal((await inspect()).item.description, '初版');
	const hit = cache.get(id);
	assert.ok(hit);
	assert.equal((await inspect(new Set([id]))).item.enabled, false);
	assert.equal(cache.get(id), hit);
	await skill(dir, 'usable', '新版: 含冒号');
	assert.equal((await inspect()).item.description, '新版: 含冒号');
	await mkdir(join(dir, 'agents'));
	await writeFile(sidecar, 'interface:\n  display_name: 新名称\npolicy:\n  allow_implicit_invocation: false\n');
	const changed = (await inspect()).item;
	assert.equal(changed.displayName, '新名称');
	assert.equal(changed.implicit, false);
	await writeFile(sidecar, 'policy: [');
	assert.ok((await inspect()).issues.some((issue) => issue.path === sidecar));
	await rm(sidecar);
	const removed = await inspect();
	assert.equal(removed.item.displayName, undefined);
	assert.ok(removed.item.implicit && !removed.issues.some((issue) => issue.path === sidecar));
});

void test('已授权目录链接可发现并去重，其他位置、配置目录和多重链接不会成为可读取资源', async (t) => {
	const { temp, vault, shared } = await fixture(t);
	const project = join(vault, '.agents/skills');
	const dir = join(shared, 'good'), outside = join(temp, 'outside');
	const id = await skill(dir, 'good');
	await skill(outside, 'elsewhere');
	const other = join(outside, 'other.md');
	await writeFile(other, '---\nname: linked\ndescription: 测试\n---\n正文');
	await skill(join(vault, configDir), 'config');
	await skill(vault, 'broad');
	await mkdir(project, { recursive: true });
	await symlink(dir, join(project, 'same'), 'junction');
	await symlink(outside, join(project, 'other'), 'junction');
	await symlink(join(vault, configDir), join(project, 'config'), 'junction');
	const hard = join(project, 'hard', 'SKILL.md');
	await mkdir(join(project, 'hard'));
	await link(other, hard);
	await link(other, join(dir, 'multi.md'));
	await symlink(outside, join(dir, 'resources'), 'junction');
	await writeFile(join(dir, 'example.txt'), '可读取内容');
	const issues: SkillScanIssue[] = [];
	const result = await discoverLiveSkills(vault, configDir, [], [shared, vault], new Set(), { issues });
	assert.deepEqual(result.map((item) => item.id), [id]);
	assert.ok(issues.some((issue) => issue.path === hard));
	assert.ok(issues.some((issue) => issue.path === join(vault, 'SKILL.md')));
	assert.ok(issues.some((issue) => issue.path === join(project, 'other')));
	assert.deepEqual(await listSkillFiles(dir), ['SKILL.md', 'example.txt']);
	assert.equal(await skillText(dir, 'example.txt'), '可读取内容');
	await assert.rejects(skillText(dir, 'resources/SKILL.md'), /授权目录/u);
	await assert.rejects(skillText(dir, 'multi.md'), /授权目录/u);
	await assert.rejects(skillText(dir, '../outside/SKILL.md'));
	await rename(dir, dir + '-moved');
	await symlink(outside, dir, 'junction');
	await assert.rejects(listSkillFiles(dir), /授权目录/u);
	await assert.rejects(skillText(dir, 'SKILL.md'), /授权目录/u);
	await rename(shared, shared + '-moved');
	await symlink(outside, shared, 'junction');
	assert.equal((await discoverLiveSkills(vault, configDir, [], [shared], new Set())).length, 0);
	const hidden = join(vault, '私人目录');
	await skill(hidden, 'private');
	await rename(project, project + '-moved');
	await symlink(hidden, project, 'junction');
	const refused: SkillScanIssue[] = [];
	assert.equal((await discoverLiveSkills(vault, configDir, [], [], new Set(), { issues: refused })).length, 0);
	assert.ok(refused.some((issue) => issue.path === project && issue.reason.includes('授权')));
});

void test('扫描层数超限时保留可用技能并返回所属目录和上限提示', async (t) => {
	const { vault, shared } = await fixture(t);
	const issues: SkillScanIssue[] = [];
	await skill(join(shared, 'a/b/c/d/e/f'), 'six');
	await skill(join(shared, 'second/b/c/d/e/f/g'), 'seven');
	const result = await discoverLiveSkills(vault, configDir, [], [shared], new Set(), { issues });
	assert.deepEqual(result.map((item) => item.name), ['six']);
	assert.ok(issues.some((issue) => issue.path === shared && issue.reason.includes('6 层')));
});
