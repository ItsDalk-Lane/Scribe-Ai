import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readStoredJson, storageStat, writeStoredJson } from '../storage/jsonFile';
import { openVaultStorage, STORAGE_VERSION } from '../storage/vaultStorage';

void test('聊天与配置验证后才收起旧版本，重启保留新位置上的更新', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-vault-storage-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const legacy = join(root, 'vault-config', 'plugins', 'scribe-ai', 'conversations');
	await mkdir(legacy, { recursive: true });
	const files = { 'chat.jsonl': '原会话\n', 'chat.title': '旧标题', 'last-opened': 'chat\n' };
	for (const [name, content] of Object.entries(files)) {
		const file = join(legacy, name);
		await writeFile(file, content);
		await utimes(file, 1700000000, 1700000000);
	}
	let data: unknown = { model: '旧模型' };
	let cleared = 0;
	const mark = () => { data = { storageVersion: STORAGE_VERSION }; return Promise.resolve(); };
	const clear = () => { cleared++; return Promise.resolve(); };
	const first = await openVaultStorage(root, legacy, data);
	const settings = { model: '旧模型', slashPresets: [{ label: '预设', content: '继续' }] };
	await writeStoredJson(first.paths.settings, settings);
	await first.complete(mark, clear);
	assert.deepEqual(data, { model: '旧模型' });
	assert.equal(cleared, 0);
	for (const [name, content] of Object.entries(files)) {
		const copy = join(first.paths.conversations, name);
		assert.equal(await readFile(copy, 'utf8'), content);
		assert.equal((await stat(copy)).mtimeMs, (await stat(join(legacy, name))).mtimeMs);
	}
	await writeFile(join(first.paths.conversations, 'chat.title'), '新标题');
	const next = await openVaultStorage(root, legacy, data);
	assert.deepEqual(next.stored, settings);
	await next.complete(mark, clear);
	assert.deepEqual(data, { storageVersion: STORAGE_VERSION });
	assert.equal(cleared, 1);
	assert.equal(await storageStat(legacy), undefined);
	assert.deepEqual(await readStoredJson(first.paths.settings), settings);
	assert.equal(await readFile(join(first.paths.conversations, 'chat.title'), 'utf8'), '新标题');
	const reopened = await openVaultStorage(root, legacy, data);
	await reopened.complete(mark, clear);
	assert.equal(cleared, 1);
});

void test('旧记录在确认后又被修改时保留原件和已搬副本', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-vault-storage-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const legacy = join(root, 'vault-config', 'conversations');
	await mkdir(legacy, { recursive: true });
	const file = join(legacy, 'chat.jsonl');
	await writeFile(file, '旧聊天\n');
	const data = { model: '旧模型' };
	const first = await openVaultStorage(root, legacy, data);
	await writeStoredJson(first.paths.settings, data);
	const unexpected = () => { assert.fail('不应清除旧记录'); };
	await first.complete(unexpected, unexpected);
	await writeFile(file, '另一处补写的聊天\n');
	const next = await openVaultStorage(root, legacy, data);
	await assert.rejects(next.complete(unexpected, unexpected), /旧数据在迁移期间发生变化/u);
	assert.equal(await readFile(file, 'utf8'), '另一处补写的聊天\n');
	assert.equal(await readFile(join(first.paths.conversations, 'chat.jsonl'), 'utf8'), '旧聊天\n');
});
