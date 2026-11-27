import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Notice, Setting } from 'obsidian';
import type ScribeAiPlugin from '../main';
import { nodeRequire } from '../communication/nodeRequire';
import { clearSpillFiles, sweepSpillFiles } from '../tools/support/spillCleanup';
import { retainedImagePaths } from '../orchestration/storage/retainedImages';
import { uiText } from './uiText';

const RETENTION_DAYS = [7, 30, 90, 180, 0] as const;

/** 只统计目录；缓存目录根部的模型资料不参与清理提示。 */
function directoryBytes(path: string, directoriesOnly = false): number {
	let entries;
	try { entries = readdirSync(path, { withFileTypes: true }); }
	catch { return 0; }
	let total = 0;
	for (const entry of entries) {
		const child = join(path, entry.name);
		try {
			if (entry.isDirectory()) total += directoryBytes(child);
			else if (!directoriesOnly && entry.isFile()) total += statSync(child).size;
		} catch { /* 统计期间文件消失，忽略。 */ }
	}
	return total;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function openDirectory(data: string, selected: string): void {
	let path: string;
	try {
		const root = join(realpathSync(dirname(data)), basename(data));
		if (!lstatSync(root).isDirectory()) throw new Error();
		path = selected === data ? root : join(root, basename(selected));
		if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o700 });
		if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error();
	} catch {
		new Notice('数据目录位置不可用，请检查笔记库。');
		return;
	}
	try {
		const { shell } = nodeRequire('electron') as { shell?: { openPath(path: string): Promise<string> } };
		if (shell) { void shell.openPath(path); return; }
	} catch { /* 回落到系统命令。 */ }
	try {
		const { spawn } = nodeRequire('node:child_process') as typeof import('node:child_process');
		const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
		spawn(opener, [path], { detached: true, stdio: 'ignore' }).unref();
	} catch { /* 打不开目录时界面仍然可用。 */ }
}

/** 高级设置中的「数据目录」：位置、保留期与缓存清理 */
export function renderDataDirectorySettings(panel: HTMLElement, plugin: ScribeAiPlugin): void {
	const text = uiText();
	const settings = plugin.services.settings;
	const { paths, logs } = plugin.services;

	new Setting(panel).setName(text.dataDirectory).setHeading();

	for (const [name, path] of [[text.appData, paths.data], [text.appLogs, paths.logs]] as const) {
		const setting = new Setting(panel).setName(name).setDesc(path);
		setting.descEl.addClass('scribe-data-path');
		setting.addButton((button) => button.setButtonText(text.openDirectory).onClick(() => openDirectory(paths.data, path)));
	}

	const label = (days: number) => days ? `${days} ${text.days}` : text.keepForever;
	const retention = (name: string, description: string, current: number, apply: (days: number) => Promise<void>) => {
		new Setting(panel).setName(name).setDesc(description).addDropdown((dropdown) => {
			for (const days of RETENTION_DAYS) dropdown.addOption(String(days), label(days));
			// 旧配置里可能存过选项之外的天数，保留它以免下拉框显示为空。
			if (!(RETENTION_DAYS as readonly number[]).includes(current)) dropdown.addOption(String(current), label(current));
			dropdown.setValue(String(current)).onChange(async (value) => {
				await apply(Number(value));
				await plugin.saveSettings();
			});
		});
	};
	retention(text.logRetentionDays, text.logRetentionDescription, settings.logRetentionDays, async (days) => {
		settings.logRetentionDays = days;
		logs.sweep(days);
	});
	retention(text.spillCleanupDays, text.spillCleanupDaysDescription, settings.spillCleanupDays, async (days) => {
		settings.spillCleanupDays = days;
	});

	const cache = new Setting(panel).setDesc(text.clearCacheDescription);
	const updateCache = () => {
		const size = logs.size() + directoryBytes(paths.cache, true);
		cache.setName(size ? `${text.clearCache} (${formatBytes(size)})` : text.clearCache);
	};
	updateCache();
	// 用样式类而不是新版设置按钮 API，保持对最低支持版本可用。
	cache.addButton((button) => button.setButtonText(text.clearCache).setClass('mod-warning').onClick(async () => {
		button.setDisabled(true);
		try {
			logs.clear();
			await clearSpillFiles(paths.cache, () => retainedImagePaths(plugin.services.orchestration.conversations));
			new Notice(text.cacheCleared);
		} catch {
			new Notice(text.cacheClearFailed);
		} finally {
			button.setDisabled(false);
			updateCache();
		}
	}));
}

/** 启动时按保留期清理日志与临时结果 */
export async function sweepRetainedFiles(plugin: ScribeAiPlugin): Promise<void> {
	const { settings, logs, paths } = plugin.services;
	try {
		logs.sweep(settings.logRetentionDays);
		await sweepSpillFiles({ cacheDirectory: paths.cache, cleanupPeriodDays: settings.spillCleanupDays },
			() => retainedImagePaths(plugin.services.orchestration.conversations));
	} catch { /* 清理失败时留待下次。 */ }
}
