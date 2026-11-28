import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { GeneratedMediaRef } from '../../types';

export const SCRIBE_DATA_DIRECTORY = '.scribe-ai';
export const SKILL_LIBRARY = `${SCRIBE_DATA_DIRECTORY}/skills`;
export const IMAGE_CACHE_PREFIX = 'scribe-ai-image-';
export const VIDEO_CACHE_PREFIX = 'scribe-ai-video-';
export const GENERATED_MEDIA_CACHE_PREFIX = 'scribe-ai-generated-';

export function conversationPlanPrefix(conversationId: string): string {
	return `${conversationId}.plan.`;
}

export function runProgressFilename(conversationId: string, taskId: string): string {
	return `${conversationId}.${taskId}.progress.json`;
}

export function conversationPlanFilename(conversationId: string, taskId: string): string {
	return `${conversationPlanPrefix(conversationId)}${taskId}.md`;
}

export function scribeDataPaths(vaultRoot: string) {
	const root = join(vaultRoot, SCRIBE_DATA_DIRECTORY);
	return {
		root,
		settings: join(root, 'settings.json'),
		state: join(root, 'state.json'),
		conversations: join(root, 'conversations'),
		logs: join(root, 'logs'),
		memory: join(root, 'memory'),
		cache: join(root, 'cache'),
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

const generatedMediaExtensions = {
	image: /\.(?:avif|gif|jpe?g|png|webp)$/iu,
	video: /\.(?:m4v|mov|mp4|webm)$/iu,
	audio: /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|pcm|wav)$/iu,
};

export function isGeneratedMediaCachePath(path: string, conversationId?: string, subagentId?: string): boolean {
	const [root, cache, conversation, owner, directory, file, ...extra] = path.split('/');
	return root === SCRIBE_DATA_DIRECTORY && cache === 'cache' && !extra.length
		&& !!conversation && safeId.test(conversation) && !!owner && safeId.test(owner)
		&& (conversationId === undefined || (conversation === conversationId && owner === (subagentId ?? primaryScope)))
		&& /^scribe-ai-generated-[A-Za-z0-9]{6}$/u.test(directory ?? '')
		&& !!file && /^[A-Za-z0-9_-]{1,96}\.[A-Za-z0-9]{2,5}$/u.test(file)
		&& Object.values(generatedMediaExtensions).some((pattern) => pattern.test(file));
}

export function isGeneratedMediaRef(value: unknown): value is GeneratedMediaRef {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const { kind, path, sampleRate } = value as Partial<GeneratedMediaRef>;
	if ((kind !== 'image' && kind !== 'video' && kind !== 'audio') || typeof path !== 'string' || path.length > 4_096
		|| /[:\\]/u.test(path) || Array.from(path).some((character) => character.charCodeAt(0) < 32)
		|| !generatedMediaExtensions[kind].test(path)) return false;
	if (/\.pcm$/iu.test(path)) {
		if (typeof sampleRate !== 'number' || !Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) return false;
	} else if (sampleRate !== undefined) return false;
	const parts = path.split('/');
	if (parts.some((part) => !part || part === '.' || part === '..')) return false;
	const root = parts[0]!.toLowerCase();
	return root !== SCRIBE_DATA_DIRECTORY || isGeneratedMediaCachePath(path);
}

export function isGeneratedVideoJobId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
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
