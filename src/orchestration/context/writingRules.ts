import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FileSystemAdapter, Vault } from 'obsidian';
import { hasFileErrorCode, isWithinPath } from '../../tools/support/pathUtils';
import type { LegacyWritingRules } from '../../types';

export const WRITING_RULE_FILENAME = 'AGENTS.md';

export class WritingRuleChangedError extends Error {}

async function safeLocation(vault: Vault, path: string): Promise<string | undefined> {
	const root = await realpath((vault.adapter as FileSystemAdapter).getBasePath());
	const expected = resolve(root, path);
	if (!isWithinPath(root, expected) || isWithinPath(resolve(root, vault.configDir), expected)) return;
	const actual = await realpath(expected).catch((error: unknown) => {
		if (!hasFileErrorCode(error, 'ENOENT')) throw error;
	});
	// 真实地址必须与规则所在位置一致，避免软链接让别处的文档成为本处规则。
	return actual === expected ? actual : undefined;
}

export async function readWritingRule(vault: Vault): Promise<string | undefined> {
	const path = WRITING_RULE_FILENAME;
	const file = vault.getFileByPath(path);
	if (!file) return;
	try {
		const actual = await safeLocation(vault, path);
		if (!actual || (await stat(actual)).nlink !== 1) return;
		return await vault.read(file);
	} catch (error) {
		if (!hasFileErrorCode(error, 'ENOENT')) throw error;
		return undefined;
	}
}

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
	const rule = (await readWritingRule(vault))?.trim();
	if (!rule) return;
	return [
		'全库自定义指令来自笔记库根目录的 AGENTS.md，只用于写作风格、结构和格式。本次用户明确提出的要求优先，操作范围、资料授权和工具权限仍由原有规则决定。',
		rule,
	].join('\n\n');
}
