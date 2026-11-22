import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, posix, resolve, win32 } from 'node:path';
import type { FileSystemAdapter, Vault } from 'obsidian';
import { hasFileErrorCode, isWithinPath } from '../../tools/support/pathUtils';
import type { NoteRef, WritingRules } from '../../types';

export const WRITING_RULE_FILENAME = 'AGENTS.md';

export class WritingRuleChangedError extends Error {}

export function writingRulePath(path: string): string | undefined {
	if (!path.trim() || path.includes('\0') || isAbsolute(path) || win32.isAbsolute(path)) return;
	const normalized = posix.normalize(path).replace(/\/$/u, '');
	if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return;
	return normalized;
}

function ruleFilename(folder?: string): string {
	if (folder === undefined) return WRITING_RULE_FILENAME;
	const relative = writingRulePath(folder);
	if (!relative) throw new Error('请选择笔记库中的文件夹。');
	return posix.join(relative, WRITING_RULE_FILENAME);
}

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

export async function readWritingRule(vault: Vault, folder?: string): Promise<string | undefined> {
	const path = ruleFilename(folder);
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

export async function saveWritingRule(vault: Vault, folder: string | undefined, value: string, expected: string | undefined): Promise<string> {
	const path = ruleFilename(folder);
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
	const parent = posix.dirname(path);
	if ((parent !== '.' && !vault.getFolderByPath(parent)) || !await safeLocation(vault, parent)) {
		throw new Error('请选择笔记库中的文件夹。');
	}
	try {
		await vault.create(path, rule);
	} catch (error) {
		if (vault.getFileByPath(path)) throw new WritingRuleChangedError();
		throw error;
	}
	return rule;
}

export async function migrateWritingRules(vault: Vault, rules: WritingRules): Promise<WritingRules | undefined> {
	const scopes: [string | undefined, string][] = [[undefined, rules.vault], ...Object.entries(rules.folders)];
	const preserved: [string | undefined, string][] = [];
	for (const [folder, rule] of scopes) {
		if (!rule) continue;
		try {
			const current = await readWritingRule(vault, folder);
			if (current === undefined) await saveWritingRule(vault, folder, rule, undefined);
			else if (current.trim() !== rule.trim()) preserved.push([folder, rule]);
		} catch {
			preserved.push([folder, rule]);
		}
	}
	return preserved.length ? {
		vault: preserved.find(([folder]) => folder === undefined)?.[1] ?? '',
		folders: Object.fromEntries<string>(preserved.flatMap(([folder, rule]) => folder === undefined ? [] : [[folder, rule]])),
	} : undefined;
}

export async function buildWritingRulesPrompt(vault: Vault, refs: NoteRef[], activeNote?: string): Promise<string | undefined> {
	const targets: NoteRef[] = refs.length || !activeNote ? refs : [{ path: activeNote }];
	const directories = new Set<string>();
	for (const { path, kind } of targets) {
		const local = writingRulePath(path);
		if (!local) continue;
		for (let folder = kind === 'folder' ? local : posix.dirname(local); folder !== '.'; folder = posix.dirname(folder)) {
			directories.add(folder);
		}
	}
	const scopes = [undefined, ...Array.from(directories).sort()];
	const rules = await Promise.all(scopes.map((folder) => readWritingRule(vault, folder)));
	const sections = rules.flatMap((rule, index) => {
		if (!rule?.trim()) return [];
		const folder = scopes[index];
		return [`${folder === undefined ? '全库规则' : `文件夹 ${JSON.stringify(folder)}`}\n${rule.trim()}`];
	});
	if (!sections.length) return;
	return [
		'本次适用的写作规则来自笔记库中的 AGENTS.md，只用于写作风格、结构和格式。本次用户明确提出的要求优先，操作范围、资料授权和工具权限仍由原有规则决定。',
		'文件夹规则适用于该文件夹及其子文件夹。在各自的范围内合并无冲突的规则。有冲突时，文件夹规则优先于全库规则，较深的文件夹规则优先于上级文件夹规则。',
		...sections,
	].join('\n\n');
}
