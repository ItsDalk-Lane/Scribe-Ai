import { dirname, isAbsolute, join, relative, sep } from 'node:path';

export const SCRIBE_DATA_DIRECTORY = '.scribe-ai';
export const SKILL_LIBRARY = `${SCRIBE_DATA_DIRECTORY}/skills`;
export const IMAGE_CACHE_PREFIX = 'scribe-ai-image-';
export const VIDEO_CACHE_PREFIX = 'scribe-ai-video-';

export function scribeDataPaths(vaultRoot: string) {
	const root = join(vaultRoot, SCRIBE_DATA_DIRECTORY);
	return {
		root,
		settings: join(root, 'settings.json'),
		state: join(root, 'state.json'),
		conversations: join(root, 'conversations'),
		logs: join(root, 'logs'),
		cache: join(root, 'cache'),
		modelCatalog: join(root, 'cache', 'model-catalog.json'),
		skills: join(vaultRoot, SKILL_LIBRARY),
		migration: join(root, '.migration'),
	};
}

const safeId = /^(?!(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$)[A-Z0-9][A-Z0-9-]{0,95}$/i;
const primaryScope = 'root';

export function scribeCacheScope(cacheRoot: string, conversationId: string | undefined, subagentId?: string): string | undefined {
	if (!conversationId || !safeId.test(conversationId)) return;
	if (subagentId !== undefined && (!safeId.test(subagentId) || subagentId.toLowerCase() === primaryScope)) return;
	return join(cacheRoot, conversationId, subagentId ?? primaryScope);
}

export function isCachedImagePath(path: string, conversationId?: string, subagentId?: string): boolean {
	const [root, cache, conversation, owner, directory, file, ...extra] = path.split('/');
	return root === SCRIBE_DATA_DIRECTORY && cache === 'cache' && !extra.length
		&& !!conversation && safeId.test(conversation) && !!owner && safeId.test(owner)
		&& (conversationId === undefined || (conversation === conversationId && owner === (subagentId ?? primaryScope)))
		&& /^scribe-ai-image-[A-Za-z0-9]{6}$/u.test(directory ?? '')
		&& /^(?:image|screenshot)\.(?:png|jpg|gif|webp)$/u.test(file ?? '');
}

export function isScribeCacheOutput(cacheRoot: string, path: string, conversationId: string, subagentId?: string): boolean {
	const scope = scribeCacheScope(cacheRoot, conversationId, subagentId);
	if (!scope) return false;
	const child = relative(dirname(scope), path);
	if (isAbsolute(child)) return false;
	const [owner, outputDir, file, ...rest] = child.split(sep);
	if (rest.length || !owner || !safeId.test(owner) || !outputDir || !file || (subagentId !== undefined && owner !== subagentId)) return false;
	return (/^scribe-ai-tools-[A-Za-z0-9]{6}$/u.test(outputDir) && file === 'result.txt')
		|| (/^scribe-ai-shell-[A-Za-z0-9]{6}$/u.test(outputDir) && (file === 'stdout.log' || file === 'stderr.log'));
}
