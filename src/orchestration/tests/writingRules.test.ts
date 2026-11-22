import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Vault } from 'obsidian';
import { migrateWritingRules, readWritingRule, saveWritingRule, WritingRuleChangedError } from '../context/writingRules';

void test('legacy writing rules migrate without overwriting existing rule notes or later edits', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'scribe-writing-rules-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = (path: string) => join(root, path);
	const vault = {
		configDir: 'fixture-config',
		adapter: { getBasePath: () => root },
		getFileByPath: (path: string) => statSync(file(path), { throwIfNoEntry: false })?.isFile() ? { path } : null,
		getFolderByPath: (path: string) => statSync(file(path), { throwIfNoEntry: false })?.isDirectory() ? { path } : null,
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

	const backup = await migrateWritingRules(vault, {
		vault: '旧全库规则。', folders: { 已有规则: '旧同名规则。', 项目: '旧项目规则。', 已删除: '旧目录规则。' },
	});
	assert.deepEqual(backup, { vault: '', folders: { 已有规则: '旧同名规则。', 已删除: '旧目录规则。' } });
	assert.equal(await readWritingRule(vault), '旧全库规则。');
	assert.equal(await readWritingRule(vault, '已有规则'), '现有文档原文。\n');
	const old = await readWritingRule(vault, '项目');
	assert.equal(old, '旧项目规则。');

	await writeFile(file('项目/AGENTS.md'), '刚在 Obsidian 编辑的原文。');
	await assert.rejects(saveWritingRule(vault, '项目', '先前的设置草稿。', old), WritingRuleChangedError);
	assert.equal(await readWritingRule(vault, '项目'), '刚在 Obsidian 编辑的原文。');
	assert.equal(await saveWritingRule(vault, '项目', '  ', '刚在 Obsidian 编辑的原文。'), '');
	assert.equal(await readWritingRule(vault, '项目'), '');
});
