import { skillWriteLocations } from '../../skills/library/writeProtection';
import { storageStat } from '../../orchestration/storage/jsonFile';
import { scribeDataPaths } from '../../orchestration/storage/paths';
import { accessSync, constants } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolContext } from '../../types';
import { hasFileErrorCode } from '../support/pathUtils';

export const macSandboxExecutable = '/usr/bin/sandbox-exec';

export function hasMacShellSandbox(): boolean {
	if (process.platform !== 'darwin') return false;
	try {
		accessSync(macSandboxExecutable, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function macShellSandboxArgs(ctx: ToolContext): Promise<string[]> {
	const vault = await realpath(ctx.cwd);
	const data = scribeDataPaths(vault);
	for (const path of [data.root, data.skills]) {
		const entry = await storageStat(path);
		if (entry && !entry.isDirectory()) throw new Error('插件数据目录位置已变化，无法启动受限终端。');
	}
	const protectedPaths = new Set([resolve(vault, ctx.app.vault.configDir)]);
	for (const ref of ctx.task.request.refs) {
		const path = resolve(vault, ref.path);
		if (ref.lines && ctx.permissions.readLines?.(path)) protectedPaths.add(path);
	}
	const canonicalPaths = await Promise.all([...protectedPaths].map(async (path) => {
		try {
			return await realpath(path);
		} catch (error) {
			if (!hasFileErrorCode(error, 'ENOENT')) throw error;
			return path;
		}
	}));
	for (const path of canonicalPaths) protectedPaths.add(path);
	const skills = skillWriteLocations(vault);
	const restrictedWrites = [...skills.exact.map((path) => ({ scope: 'literal', path })), ...skills.trees.map((path) => ({ scope: 'subpath', path }))]
		.map((entry, index) => ({ ...entry, key: 'SKILL_RO_' + index }));
	const parameters = [...protectedPaths].map((path, index) => ({ key: `PROTECTED_${index}`, path }));
	// 系统命令及其依赖只开放读取，笔记库外的其他资料与网络默认拒绝。
	const profile = `
		(version 1)
		(deny default)
		(allow process-exec process-fork)
		(allow signal (target same-sandbox))
		(allow file-read*
			(literal "/")
			(subpath "/System/Library")
			(subpath "/usr/lib") (subpath "/usr/share")
			(subpath "/usr/bin") (subpath "/bin")
			(subpath "/usr/sbin") (subpath "/sbin")
			(subpath (param "VAULT")))
		(allow file-read* file-write-data (literal "/dev/null"))
		(allow file-write* (subpath (param "VAULT")))
		(deny file-write* ${restrictedWrites.map(({ scope, key }) => `(${scope} (param "${key}"))`).join(' ')})
		(deny file-read* file-write* ${parameters.map(({ key }) => `(subpath (param "${key}"))`).join(' ')})
		(deny file-read* file-write* (require-all (subpath (param "SCRIBE_DATA"))
			(require-not (subpath (param "SCRIBE_SKILLS")))))
	`;
	return ['-D', `VAULT=${vault}`, '-D', `SCRIBE_DATA=${data.root}`, '-D', `SCRIBE_SKILLS=${data.skills}`,
		...[...parameters,...restrictedWrites].flatMap(({ key, path }) => ['-D', `${key}=${path}`]), '-p', profile];
}
