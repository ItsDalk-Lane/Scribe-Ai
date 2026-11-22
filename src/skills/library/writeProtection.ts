import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { BUILTIN_SKILL_PROVENANCE } from './builtinSkills';
import { SKILL_LIBRARY } from './SkillLibrary';
import { hasFileErrorCode, isWithinPath } from '../../tools/support/pathUtils';

const bundled = BUILTIN_SKILL_PROVENANCE.map((item) => item.name);
const management = ['.registry.json', '.operations', '.usage.json'];
function pathKey(path: string) {
	return process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path;
}
function installedBuiltinPaths(root: string): string[] {
	const library = join(root, SKILL_LIBRARY);
	const registry = join(library, '.registry.json');
	const reserved = bundled.map((name) => join(library, name));
	let data: unknown = { entries: [] };
	try {
		// 位置或来源记录异常时保持保护，也不通过库外链接读取来源。
		if (realpathSync(registry) !== registry) return reserved;
		const handle = openSync(registry, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			const stat = fstatSync(handle);
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) return reserved;
			data = JSON.parse(readFileSync(handle, 'utf8')) as unknown;
		} finally { closeSync(handle); }
	} catch (error) {
		if (!hasFileErrorCode(error, 'ENOENT')) return reserved;
	}
	if (typeof data !== 'object' || !data || !('entries' in data) || !Array.isArray(data.entries)) return reserved;
	const entries = data.entries as { name?: unknown; source?: {kind?: unknown}; state?: unknown }[];
	return reserved.filter((path, index) => {
		const entry = entries.find((item) => item?.name === bundled[index]);
		if (entry?.source?.kind === 'builtin') return true;
		// 未登记的现有同名个人目录也能修复。尚不存在的位置留给后续恢复的内置技能。
		return !existsSync(path);
	});
}
export function skillWriteLocations(root: string) {
	const library = join(root, SKILL_LIBRARY);
	return {
		exact: [dirname(library), library],
		trees: [...management.map((name) => join(library, name)), ...installedBuiltinPaths(root)],
	};
}
export function skillWriteProtected(vaultRoot: string, path: string): boolean {
	const root = pathKey(vaultRoot), target = pathKey(resolve(path));
	const library = join(root, SKILL_LIBRARY);
	if (target === dirname(library) || target === library) return true;
	if (!isWithinPath(library, target)) return false;
	const name = relative(library, target).split(sep)[0]!;
	if (management.includes(name)) return true;
	if (!bundled.includes(name)) return false;
	// 用户可能在当前聊天运行期间安装或恢复技能，文件写入前按当前记录校验。
	return installedBuiltinPaths(vaultRoot).some((entry) => isWithinPath(pathKey(entry), target));
}
