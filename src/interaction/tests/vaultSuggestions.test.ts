import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { App, TAbstractFile, TFile } from 'obsidian';
import { vaultSuggestions } from '../vaultSuggestions';

void test('库选择器空查询只浏览最近文件和根目录，并按输入搜索公开目录', () => {
	const file = (path: string) => ({ path, name: path.split('/').at(-1), extension: 'md' });
	const recent = file('drafts/recent.md');
	const privateFile = file('settings/private.md');
	const drafts = { path: 'drafts', name: 'drafts', children: [file('drafts/notes.md'), recent] };
	const sidebar = { path: 'sidebar', name: 'sidebar', get children() { return assert.fail('搜索指定目录时，不应访问无关目录'); } };
	const settings = { path: 'settings', name: 'settings', get children() { return assert.fail('不得打开 Obsidian 配置目录'); } };
	const root = { children: [file('readme.md'), drafts, settings, sidebar] };
	const app = { vault: { configDir: 'settings', getRoot: () => root,
		getAbstractFileByPath: (path: string) => [recent, privateFile, drafts, settings].find((item) => item.path === path) },
	workspace: { getLastOpenFiles: () => [privateFile.path, recent.path] } } as unknown as App;
	const markdown = (item: TAbstractFile): item is TFile => 'extension' in item && item.extension === 'md';
	const paths = (query: string, limit?: number) => vaultSuggestions(app, query, markdown, limit).map(({ path }) => path);
	assert.deepEqual(paths('', 2), ['drafts/recent.md', 'readme.md']);
	assert.deepEqual(paths('drafts/notes'), ['drafts/notes.md']);
	assert.deepEqual(paths('settings/private'), []);
});
