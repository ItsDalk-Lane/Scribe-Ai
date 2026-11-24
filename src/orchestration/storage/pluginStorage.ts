import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileSystemAdapter, Plugin, Vault } from 'obsidian';
import { clearLegacyPresets, readLegacyPresets } from '../../interaction/slashPresets';
import type { ScribeSettings } from '../../types';
import { migrateWritingRules } from '../context/writingRules';
import { normalizeSettings } from '../settings/defaults';
import { createConversationStore } from './conversationStore';
import { readStoredJson, writeStoredJson } from './jsonFile';
import { initializeLocalState } from './localState';
import { openVaultStorage, STORAGE_VERSION } from './vaultStorage';

async function prepareSettings(raw: Partial<ScribeSettings>, vault: Vault): Promise<ScribeSettings> {
	const settings = normalizeSettings(raw);
	if (!settings.writingRules) return settings;
	const { writingRules, ...migrated } = settings;
	const backup = await migrateWritingRules(vault, writingRules);
	if (backup) migrated.writingRulesBackup = {
		vault: backup.vault || migrated.writingRulesBackup?.vault || '',
		folders: { ...migrated.writingRulesBackup?.folders, ...backup.folders },
	};
	return migrated;
}

export async function initializePluginStorage(plugin: Plugin) {
	const { app, manifest } = plugin;
	const root = await realpath((app.vault.adapter as FileSystemAdapter).getBasePath());
	const previous = resolve(root, manifest.dir ?? join(app.vault.configDir, 'plugins', manifest.id), 'conversations');
	const storage = await openVaultStorage(root, previous, await plugin.loadData() as unknown);
	const source = storage.stored ?? storage.legacy;
	const settings = await prepareSettings(source, app.vault);
	settings.slashPresets ??= readLegacyPresets(app);
	if (storage.importing && storage.stored && Object.keys(storage.legacy).some((key) => key !== 'storageVersion')) {
		const oldSettings = await prepareSettings(storage.legacy, app.vault);
		oldSettings.slashPresets ??= readLegacyPresets(app);
		if (JSON.stringify(oldSettings) !== JSON.stringify(settings)) {
			throw new Error('新旧设置有冲突，已保留两份数据。');
		}
	}

	const writeSettings = (next: ScribeSettings) => writeStoredJson(storage.paths.settings, next);
	if (!storage.stored || JSON.stringify(source) !== JSON.stringify(settings)) {
		await writeSettings(settings);
		if (JSON.stringify(await readStoredJson(storage.paths.settings)) !== JSON.stringify(settings)) {
			throw new Error('无法验证新位置的 Scribe Ai 设置。');
		}
	}

	const conversations = createConversationStore(storage.paths.conversations);
	const legacyIds = new Set<string>();
	if (storage.needsLegacyMigration) {
		for (const { id } of await conversations.list()) legacyIds.add(id);
		const last = await conversations.lastOpened();
		if (last) legacyIds.add(last);
	}
	const localState = await initializeLocalState(storage.paths.state, app, [...legacyIds]);
	if (storage.needsLegacyMigration) await localState.migrateLegacyGoals(conversations);
	const staged = await storage.stageMigration(() => localState.hasLegacy() || readLegacyPresets(app).some(Boolean));

	return {
		settings, conversations, localState, writeSettings, cache: storage.paths.cache, modelCatalog: storage.paths.modelCatalog,
		complete: () => staged ? Promise.resolve() : storage.complete(
			() => plugin.saveData({ storageVersion: STORAGE_VERSION }),
			async () => {
				await localState.clearLegacy(conversations);
				clearLegacyPresets(app);
			},
		),
	};
}
