import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { NoteRef, PermissionPolicy } from '../../types';

function includesPath(root: string, target: string): boolean {
	const child = relative(root, target);
	return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if (!isMissing(error)) throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return resolve(await canonicalPath(parent), relative(parent, path));
	}
}

/** 笔记库是默认工作范围，库外范围只由用户提交的路径扩展。 */
export async function createPermissionPolicy(
	cwd: string, configDir: string, refs: NoteRef[], toolsEnabled: () => boolean = () => true,
): Promise<PermissionPolicy> {
	const vaultRoot = await realpath(cwd);
	const roots = [cwd, vaultRoot];
	const protectedRoots = roots.map((root) => resolve(root, configDir));
	const inVault = (path: string) => roots.some((root) => includesPath(root, path));
	const explicit = (await Promise.all(refs.map(async (ref) => {
		const path = resolve(cwd, ref.path);
		const external = isAbsolute(ref.path);
		if (!external && !inVault(path)) return;
		const canonical = await canonicalPath(path);
		if (!external && !inVault(canonical)) return;
		return { ref, paths: [path, canonical] };
	}))).filter((entry) => entry !== undefined);

	const matchingReferences = (path: string) => explicit.filter(({ ref, paths }) => paths.some((item) => (
			ref.kind === 'folder' ? includesPath(item, path) : relative(item, path) === ''
	)));
	const isProtected = (path: string) => protectedRoots.some((root) => includesPath(root, path));

	function access(path: string, forWrite: boolean): boolean {
		const matches = matchingReferences(path);
		if (matches.some(({ ref, paths }) => !ref.lines && (
			!isProtected(path) || paths.some(isProtected)
		))) return true;
		if (!forWrite && matches.some(({ ref, paths }) => ref.lines && (!isProtected(path) || paths.some(isProtected)))) return true;
		if (matches.some(({ ref }) => ref.lines) || isProtected(path)) return false;
		return inVault(path);
	}

	return {
		canRead: (path) => access(path, false),
		readLines: (path) => {
			const matches = matchingReferences(path);
			return matches.some(({ ref }) => !ref.lines) ? undefined : matches[0]?.ref.lines;
		},
		canWrite: (path) => access(path, true),
		canCallTool: () => toolsEnabled(),
		canSendOutbound: () => true,
	};
}
