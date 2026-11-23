import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Vault } from 'obsidian';
import { migrateWritingRules, readWritingRule, saveWritingRule, WritingRuleChangedError } from '../context/writingRules';

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
