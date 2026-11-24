import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { LibraryDependency } from './contracts';

async function executable(name: string): Promise<string | undefined> {
	if (!/^[\w.-]+$/u.test(name)) return;
	const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD').split(';')] : [''];
	for (const dir of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
		for (const extension of extensions) {
			const candidate = join(dir, name + extension);
			if ((await stat(candidate).catch(() => undefined))?.isFile()
				&& await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
		}
	}
	return undefined;
}
export interface DependencyChecks {
	pluginVersion?: (id: string) => string | undefined;
	mcpConnected?: (name: string) => boolean;
}
export async function checkDependency(dependency: LibraryDependency, checks: DependencyChecks) {
	let result: string | undefined;
	switch (dependency.type) {
		case 'command': result = await executable(dependency.name); break;
		case 'obsidian-plugin': result = checks.pluginVersion?.(dependency.name); break;
		case 'python-package': {
			const python = await executable('python3');
			if (python) result = await promisify(execFile)(python,
				['-I','-c','import sys, importlib.metadata as m; print(m.version(sys.argv[1]))', dependency.name],
				{ timeout: 5000, maxBuffer: 8192 }).then(({ stdout }) => stdout.trim(), () => undefined);
			break;
		}
		case 'mcp': result = checks.mcpConnected?.(dependency.name) ? '已连接' : undefined; break;
	}
	return { name: dependency.name, ready: Boolean(result), detail: result ?? dependency.note ?? '未发现所需工具' };
}
