import { skillWriteProtected } from '../../skills/library/writeProtection';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExecutionMode, NoteRef, PermissionPolicy } from '../../types';

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

export async function createPermissionPolicy(
	cwd: string, configDir: string, refs: NoteRef[], toolsEnabled: () => boolean = () => true,
	executionMode?: ExecutionMode,
): Promise<PermissionPolicy> {
	const vaultRoot = await realpath(cwd);
	const roots = [cwd, vaultRoot];
	const protectedRoots = roots.map((root) => resolve(root, configDir));
	protectedRoots.push(await canonicalPath(resolve(vaultRoot, configDir)));
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
		if (forWrite && executionMode !== 'full-access' && roots.some((root) =>
			includesPath(root, path) && skillWriteProtected(vaultRoot, resolve(vaultRoot, relative(root, path))))) return false;
		const matches = matchingReferences(path);
		if (matches.some(({ ref, paths }) => !ref.lines && (
				executionMode === 'full-access' || !isProtected(path) || paths.some(isProtected)
		))) return true;
		if (matches.some(({ ref }) => ref.lines)) {
			return !forWrite && matches.some(({ paths }) => executionMode === 'full-access' || !isProtected(path) || paths.some(isProtected));
		}
		return executionMode === 'full-access' || (!isProtected(path) && inVault(path));
	}

	return {
		executionMode,
		canRequestPath: executionMode && executionMode !== 'full-access'
			? (path) => !inVault(path) && !isProtected(path) && !matchingReferences(path).some(({ ref }) => ref.lines)
			: undefined,
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
