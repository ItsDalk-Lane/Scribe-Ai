import { realpath, stat } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import type { FileSystemAdapter, Vault } from 'obsidian';
import { hasFileErrorCode, isWithinPath, normalizeVaultRelativePath } from '../../tools/support/pathUtils';
import { scribeDataPaths } from '../storage/paths';
import type { LegacyWritingRules } from '../../types';

export const WRITING_RULE_FILENAME = 'AGENTS.md';

export class WritingRuleChangedError extends Error {}

async function safeLocation(vault: Vault, path: string): Promise<string | undefined> {
	const root = await realpath((vault.adapter as FileSystemAdapter).getBasePath());
	const expected = resolve(root, path);
	if (!isWithinPath(root, expected) || isWithinPath(resolve(root, vault.configDir), expected)
		|| isWithinPath(scribeDataPaths(root).root, expected)) return;
	const actual = await realpath(expected).catch((error: unknown) => {
		if (!hasFileErrorCode(error, 'ENOENT')) throw error;
	});
	// 真实地址必须与规则所在位置一致，避免软链接让别处的文档成为本处规则。
	return actual === expected ? actual : undefined;
}

export async function readWritingRule(vault: Vault, path = WRITING_RULE_FILENAME): Promise<string | undefined> {
	if (normalizeVaultRelativePath(path) !== path || path.includes('\\') || posix.basename(path) !== WRITING_RULE_FILENAME) return;
	const file = vault.getFileByPath(path);
	if (!file) return;
	try {
		const actual = await safeLocation(vault, path);
		if (!actual) return;
		const info = await stat(actual);
		if (!info.isFile() || info.nlink !== 1) return;
		if (info.size > 32_768) throw new Error('AGENTS.md 超过 32 KiB，请精简后重试。');
		return await vault.read(file);
	} catch (error) {
		if (!hasFileErrorCode(error, 'ENOENT')) throw error;
		return undefined;
	}
}

export function createDirectoryRules(vault: Vault, trusted: () => boolean) {
	return {
		trusted,
		async forPath(vaultRelativePath: string, isDirectory = false) {
			if (!trusted() || vaultRelativePath.includes('\\')) return [];
			const path = normalizeVaultRelativePath(vaultRelativePath);
			if (!path) return [];
			const folders = (isDirectory ? path : posix.dirname(path)).split('/');
			const results: { path: string; text: string }[] = [];
			for (const [index, folder] of folders.entries()) {
				if (folder === '.') continue;
				const rulePath = posix.join(...folders.slice(0, index + 1), WRITING_RULE_FILENAME);
				const text = (await readWritingRule(vault, rulePath))?.trim();
				if (text) results.push({ path: rulePath, text });
			}
			return trusted() ? results : [];
		},
	};
}

export type DirectoryRules = ReturnType<typeof createDirectoryRules>;

export async function saveWritingRule(vault: Vault, value: string, expected: string | undefined): Promise<string> {
	const path = WRITING_RULE_FILENAME;
	const file = vault.getFileByPath(path);
	const rule = value.trim() ? value : '';
	if (file) {
		const actual = await safeLocation(vault, path);
		if (!actual || (await stat(actual)).nlink !== 1) throw new Error('无法安全编辑这份写作规则。');
		return vault.process(file, (current) => {
			if (current !== expected || file.path !== path) throw new WritingRuleChangedError();
			return rule;
		});
	}
	if (expected !== undefined) throw new WritingRuleChangedError();
	if (!rule) return '';
	if (!await safeLocation(vault, '.')) throw new Error('无法安全编辑这份写作规则。');
	try {
		await vault.create(path, rule);
	} catch (error) {
		if (vault.getFileByPath(path)) throw new WritingRuleChangedError();
		throw error;
	}
	return rule;
}

export async function migrateWritingRules(vault: Vault, rules: LegacyWritingRules): Promise<LegacyWritingRules | undefined> {
	let { vault: backup, folders } = rules;
	if (backup) {
		try {
			const current = await readWritingRule(vault);
			if (current === undefined) await saveWritingRule(vault, backup, undefined);
			if (current === undefined || current.trim() === backup.trim()) backup = '';
		} catch {
			// 保留无法写入笔记的旧内容，方便用户恢复。
		}
	}
	return backup || Object.keys(folders).length ? { vault: backup, folders } : undefined;
}

export async function buildWritingRulesPrompt(vault: Vault): Promise<string | undefined> {
	return (await readWritingRule(vault))?.trim() || undefined;
}
