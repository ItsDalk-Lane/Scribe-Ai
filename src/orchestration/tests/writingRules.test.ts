import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Vault } from 'obsidian';
import { createDirectoryRules, migrateWritingRules, readWritingRule, saveWritingRule, WritingRuleChangedError } from '../context/writingRules';

void test('legacy global rules migrate without overwriting existing notes, and old folder rules are only backed up', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-writing-rules-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = (path: string) => join(root, path);
	const vault = {
		configDir: 'fixture-config',
		adapter: { getBasePath: () => root },
		getFileByPath: (path: string) => statSync(file(path), { throwIfNoEntry: false })?.isFile() ? { path } : null,
		read: ({ path }: { path: string }) => readFile(file(path), 'utf8'),
		create: (path: string, text: string) => writeFile(file(path), text, { flag: 'wx' }),
		async process({ path }: { path: string }, update: (text: string) => string) {
			const next = update(await readFile(file(path), 'utf8'));
			await writeFile(file(path), next);
			return next;
		},
	} as unknown as Vault;
	await mkdir(file('已有规则'));
	await mkdir(file('项目'));
	await writeFile(file('已有规则/AGENTS.md'), '现有文档原文。\n');

	const folders = { 已有规则: '旧同名规则。', 项目: '旧项目规则。', 已删除: '旧目录规则。' };
	const backup = await migrateWritingRules(vault, { vault: '旧全库规则。', folders });
	assert.deepEqual(backup, { vault: '', folders });
	const old = await readWritingRule(vault);
	assert.equal(old, '旧全库规则。');
	assert.equal(await readFile(file('已有规则/AGENTS.md'), 'utf8'), '现有文档原文。\n');
	await assert.rejects(readFile(file('项目/AGENTS.md')), { code: 'ENOENT' });

	const newer = '刚在 Obsidian 编辑的原文。';
	await writeFile(file('AGENTS.md'), newer);
	const legacy = { vault: '另一版旧全库规则。', folders: {} };
	assert.deepEqual(await migrateWritingRules(vault, legacy), legacy);
	await assert.rejects(saveWritingRule(vault, '先前的设置草稿。', old), WritingRuleChangedError);
	assert.equal(await readWritingRule(vault), newer);
	assert.equal(await saveWritingRule(vault, '  ', newer), '');
	assert.equal(await readWritingRule(vault), '');
});

void test('目录规则仅加载受信路径的祖先并实时核对改动，跳过私有目录和软链接', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-directory-rules-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = (path: string) => join(root, path);
	const vault = {
		configDir: 'fixture-config',
		adapter: { getBasePath: () => root },
		getFileByPath: (path: string) => statSync(file(path), { throwIfNoEntry: false })?.isFile() ? { path } : null,
		read: ({ path }: { path: string }) => readFile(file(path), 'utf8'),
	} as unknown as Vault;
	await mkdir(file('notes/chapter'), { recursive: true });
	await mkdir(file('.scribe-ai'));
	await writeFile(file('AGENTS.md'), '全库已有规则。');
	await writeFile(file('.scribe-ai/AGENTS.md'), '不得读取这些内容。');
	await writeFile(file('notes/AGENTS.md'), '笔记规则。');
	await writeFile(file('notes/chapter/AGENTS.md'), '章节规则。');
	if (process.platform !== 'win32') await symlink(file('notes'), file('alias'), 'dir');
	let trusted = false;
	const rules = createDirectoryRules(vault, () => trusted);
	assert.deepEqual(await rules.forPath('notes/chapter/new.md'), []);
	trusted = true;
	assert.deepEqual(await rules.forPath('notes/chapter/new.md'), [
		{ path: 'notes/AGENTS.md', text: '笔记规则。' },
		{ path: 'notes/chapter/AGENTS.md', text: '章节规则。' },
	]);
	assert.deepEqual(await rules.forPath('notes/chapter', true), await rules.forPath('notes/chapter/new.md'));
	assert.deepEqual(await rules.forPath('.scribe-ai/new.md'), []);
	assert.deepEqual(await rules.forPath('alias/chapter/new.md'), []);
	await writeFile(file('notes/chapter/AGENTS.md'), '新的章节规则。');
	assert.equal((await rules.forPath('notes/chapter/new.md')).at(-1)?.text, '新的章节规则。');
	trusted = false;
	assert.deepEqual(await rules.forPath('notes/chapter/new.md'), []);
});
