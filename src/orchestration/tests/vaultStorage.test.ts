import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plugin } from 'obsidian';
import { setProviderEnabled } from '../settings/modelAvailability';
import { createConversationStore } from '../storage/conversationStore';
import { initializePluginStorage } from '../storage/pluginStorage';
import { executionModeKey } from '../storage/localState';
import { readStoredJson, storageStat, writeStoredJson } from '../storage/jsonFile';
import { openVaultStorage, STORAGE_VERSION } from '../storage/vaultStorage';
import { testSecretStorage } from './testSecretStorage';

void test('服务商启停单独保存，旧设置与新设置重开都保留配置', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-provider-settings-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	let legacy: unknown = { providerId: 'first', model: 'one', providerModels: { first: ['one'], second: ['two'] },
		modelOverrides: {
			first: { one: { capabilities: { nativeWebSearch: true, structuredOutput: false }, input: ['text', 'video'] } },
			second: { two: { capabilities: { nativeWebSearch: false } } },
		} };
	const plugin = {
		app: {
			secretStorage: testSecretStorage(),
			vault: { configDir: 'vault-config', adapter: { getBasePath: () => root } },
			loadLocalStorage: () => null,
			saveLocalStorage: (_key: string, value: unknown) => assert.equal(value, null),
		},
		manifest: { id: 'scribe-ai' },
		loadData: () => Promise.resolve(legacy),
		saveData: (data: unknown) => { legacy = data; return Promise.resolve(); },
	} as unknown as Plugin;
	const first = await initializePluginStorage(plugin);
	assert.deepEqual(first.settings.disabledProviderIds, []);
	assert.equal(first.settings.confirmFullAccessExternalActions, true);
	assert.equal(first.settings.videoModel, undefined);
	assert.equal(first.settings.videoLinkModel, null);
	await first.complete();
	const migrated = await initializePluginStorage(plugin);
	await migrated.complete();
	const previousVideo = { providerId: 'first', model: 'one' };
	await migrated.writeSettings({ ...migrated.settings, videoModel: previousVideo, videoLinkModel: undefined });
	assert.deepEqual((await initializePluginStorage(plugin)).settings.videoLinkModel, previousVideo);
	setProviderEnabled(migrated.settings, 'first', false);
	migrated.settings.confirmFullAccessExternalActions = false;
	migrated.settings.videoModel = previousVideo;
	migrated.settings.videoLinkModel = { providerId: 'second', model: 'two' };
	await migrated.writeSettings(migrated.settings);
	const reopened = await initializePluginStorage(plugin);
	assert.deepEqual(legacy, { storageVersion: STORAGE_VERSION });
	assert.deepEqual(reopened.settings.disabledProviderIds, ['first']);
	assert.equal(reopened.settings.confirmFullAccessExternalActions, false);
	assert.deepEqual(reopened.settings.providerModels, { first: ['one'], second: ['two'] });
	assert.deepEqual(reopened.settings.videoModel, { providerId: 'first', model: 'one' });
	assert.deepEqual(reopened.settings.videoLinkModel, { providerId: 'second', model: 'two' });
	assert.deepEqual(reopened.settings.modelOverrides, { first: { one: { capabilities: { structuredOutput: false }, input: ['text', 'video'] } } });
	assert.doesNotMatch(await readFile(join(root, '.scribe-ai', 'settings.json'), 'utf8'), /nativeWebSearch/u);
	assert.equal(reopened.settings.providerId, 'second');
	assert.equal(reopened.settings.model, 'two');
});

void test('仅有旧本机设置时，重开确认后才清理，中断后继续清理并保留新修改', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-vault-storage-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const configDir = 'vault-config';
	const directory = join(root, configDir, 'plugins', 'scribe-ai');
	await mkdir(directory, { recursive: true });
	const marker = join(directory, 'data.json');
	const preset = { label: '继续', content: '继续上一轮' };
	const presetsKey = 'scribe-ai:slash-presets';
	const local = new Map<string, unknown>([[executionModeKey(), 'auto-review'], [presetsKey, [preset]]]);
	let canClear = false;
	const plugin = {
		app: {
			secretStorage: testSecretStorage(),
			vault: { configDir, adapter: { getBasePath: () => root } },
			loadLocalStorage: (key: string) => local.get(key),
			saveLocalStorage: (key: string, value: unknown) => {
				assert.equal(value, null);
				if (key === presetsKey && !canClear) throw new Error('清理中断');
				local.delete(key);
			},
		},
		manifest: { id: 'scribe-ai' },
		loadData: () => readStoredJson(marker),
		saveData: (data: unknown) => writeStoredJson(marker, data),
	} as unknown as Plugin;
	const first = await initializePluginStorage(plugin);
	await first.complete();
	assert.equal(local.size, 2);
	assert.equal(await readStoredJson(marker), undefined);
	assert.deepEqual(first.settings.slashPresets?.[0], preset);
	assert.equal(first.localState.loadExecutionMode(), 'auto-review');
	await first.localState.saveExecutionMode('ask');
	const next = await initializePluginStorage(plugin);
	assert.equal(next.localState.loadExecutionMode(), 'ask');
	assert.deepEqual(next.settings.slashPresets?.[0], preset);
	await assert.rejects(next.complete(), /清理中断/u);
	assert.deepEqual(await readStoredJson(marker), { storageVersion: STORAGE_VERSION });
	assert.ok(local.has(presetsKey));
	canClear = true;
	const retry = await initializePluginStorage(plugin);
	await retry.complete();
	assert.equal(local.size, 0);
	const reopened = await initializePluginStorage(plugin);
	assert.deepEqual(reopened.settings.slashPresets?.[0], preset);
	assert.equal(reopened.localState.loadExecutionMode(), 'ask');
});

void test('聊天与配置验证后才收起旧版本，重启保留新位置上的更新', async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-vault-storage-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const legacy = join(root, 'vault-config', 'plugins', 'scribe-ai', 'conversations');
	await mkdir(legacy, { recursive: true });
	const body = JSON.stringify({ type: 'queue-add', message: { id: 'q', request: { conversationId: 'chat', instruction: '原会话', refs: [] } } }) + '\n';
	const files = { 'chat.jsonl': body, 'chat.title': '旧标题', 'last-opened': 'chat\n' };
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
	assert.equal(await first.stageMigration(() => false), true);
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
	assert.equal(await first.stageMigration(() => false), true);
	await writeFile(file, '另一处补写的聊天\n');
	const next = await openVaultStorage(root, legacy, data);
	await assert.rejects(next.complete(unexpected, unexpected), /旧数据在迁移期间发生变化/u);
	assert.equal(await readFile(file, 'utf8'), '另一处补写的聊天\n');
	assert.equal(await readFile(join(first.paths.conversations, 'chat.jsonl'), 'utf8'), '旧聊天\n');
});

void test('迁移第二次启动遇到正文缺失或损坏保留旧件，用户主动删除或编辑后可以收尾', async (t) => {
	for (const scenario of ['missing', 'damaged', 'truncated', 'removed', 'edited'] as const) {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-migration-body-')));
		t.after(() => rm(root, { recursive: true, force: true }));
		const legacy = join(root, 'legacy');
		const data = { model: 'old' };
		const log = 'chat.jsonl';
		const prior = createConversationStore(legacy);
		const task = { id: 'first', request: { conversationId: 'chat', instruction: 'first', refs: [] },
			status: 'pending' as const, createdAt: 1, updatedAt: 1 };
		const entry = { type: 'start' as const, task, model: { providerId: 'test', model: 'test' } };
		await prior.append('chat', [entry, { type: 'finish', taskId: task.id, status: 'done', turn: 1 }]);
		const first = await openVaultStorage(root, legacy, data);
		await writeStoredJson(first.paths.settings, data);
		await first.stageMigration(() => false);
		const fresh = join(first.paths.conversations, log);
		const current = createConversationStore(first.paths.conversations, first.recordConversationChange);
		if (scenario === 'missing') await rm(fresh);
		if (scenario === 'damaged') await writeFile(fresh, 'broken\n');
		if (scenario === 'truncated') await writeFile(fresh, JSON.stringify(entry) + '\n');
		if (scenario === 'removed') await current.delete('chat');
		if (scenario === 'edited') await current.replaceFrom('chat', task.id, [{ ...entry, task: { ...task, id: 'revised' } }]);
		const next = await openVaultStorage(root, legacy, data);
		const finish = next.complete(() => Promise.resolve(), () => Promise.resolve());
		if (scenario === 'removed' || scenario === 'edited') {
			await finish;
			assert.equal(await storageStat(legacy), undefined);
		} else {
			await assert.rejects(finish);
			assert.ok(await storageStat(join(legacy, log)));
		}
	}
});
