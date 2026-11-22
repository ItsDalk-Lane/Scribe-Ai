import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import type { SkillPackage } from './library/contracts';
import { hasFileErrorCode, isWithinPath } from '../tools/support/pathUtils';

export async function installSharedPackage(pkg: SkillPackage, target: string, shared: () => string[], signal: AbortSignal) {
	if (!shared().includes(target) || !isAbsolute(target) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(pkg.name)) throw new Error('共享位置或技能名称已失效。');
	const root = await realpath(target);
	if (root !== resolve(target)) throw new Error('共享目录的位置已变化，请重新选择。');
	const destination = join(root, pkg.name);
	const check = async () => {
		signal.throwIfAborted();
		if (!shared().includes(target) || await realpath(target) !== root) throw new Error('共享目录已变化。');
		if (await lstat(destination).then(() => true, (error: unknown) => {
			if (!hasFileErrorCode(error, 'ENOENT')) throw error;
			return false;
		})) throw new Error('共享目录中已有同名技能，原件已保留。');
	};
	await check();
	const stage = await mkdtemp(join(root, '.scribe-install-'));
	try {
		for (const file of pkg.files) {
			signal.throwIfAborted();
			const path = resolve(stage, file.path);
			if (!isWithinPath(stage, path) || file.path.includes('\\') || win32.isAbsolute(file.path) || isAbsolute(file.path)
				|| file.path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('技能包中的路径无效。');
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, file.data, { flag: 'wx' });
		}
		await check();
		await rename(stage, destination);
	} finally { await rm(stage, { recursive: true, force: true }); }
}
