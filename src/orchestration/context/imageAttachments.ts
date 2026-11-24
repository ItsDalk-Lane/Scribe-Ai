import { Buffer } from 'node:buffer';
import { isAbsolute, posix } from 'node:path';
import type { App } from 'obsidian';
import type { ImageContent } from '@earendil-works/pi-ai';
import { videoMime } from '../../communication/modelVideo';
import type { ImageReference, Message, ModelRequest, RunContext, TaskRequest } from '../../types';
import { isImageFile, MAX_IMAGES, MAX_REQUEST_IMAGE_BYTES, readCachedImage, readImageFile } from '../../tools/support/imageData';
import { normalizeVaultRelativePath, resolveToolPath } from '../../tools/support/pathUtils';
import { publicImageUrl, readRemoteImage } from '../../tools/support/remoteImage';

export function userImageReferences({ refs, instruction, imageSourcePath, imageLinkEnd, subagentCallerTaskId }: Pick<
	TaskRequest, 'refs' | 'instruction' | 'imageSourcePath' | 'imageLinkEnd' | 'subagentCallerTaskId'
>): ImageReference[] {
	if (subagentCallerTaskId) return [];
	const images = new Map<string, ImageReference>();
	const add = (reference: ImageReference) => images.set(reference.path, images.get(reference.path) ?? reference);
	for (const { path, kind, lines, pastedImage } of refs) {
		if (kind !== 'folder' && !lines && isImageFile(path)) add({ kind: pastedImage ? 'pasted' : 'file', path });
	}
	const links: { offset: number; path: string; explicitImage?: boolean }[] = [];
	const addLink = (value: string, explicitImage = false) => {
		const path = value.trim();
		const url = URL.parse(path);
		if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
			if (isImageFile(url.pathname) || (explicitImage && !videoMime(url.pathname))) add({ kind: 'url', path: url.href });
		} else if (url?.protocol === 'obsidian:' && url.hostname === 'open') {
			if (isImageFile(url.searchParams.get('file') ?? '')) add({ kind: 'vault-link', path: url.href, sourcePath: imageSourcePath });
		} else if (!url && isImageFile(path.split('#', 1)[0] ?? '')) {
			add({ kind: 'vault-link', path, sourcePath: imageSourcePath });
		}
	};
	const text = instruction.slice(0, imageLinkEnd)
		.replace(/^[ \t]*([~\x60]{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|$(?![\s\S]))/gmu, '')
		.replace(/\x60+[^\n\x60]+\x60+/gu, '')
		.replace(/!?\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/gu, (match, path: string, offset: number) => {
			links.push({ path, offset });
			return ' '.repeat(match.length);
		})
		.replace(/(!?)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^()\s]|\([^()\n]*\))+))\s*(?:["'][^"'\n]*["']\s*)?\)/gu,
			(match, mark: string, angled: string | undefined, path: string, offset: number) => {
				links.push({ path: (angled ?? path).replace(/\\([()])/gu, '$1'), offset, explicitImage: mark === '!' });
				return ' '.repeat(match.length);
			});
	for (const match of text.matchAll(/(?:https?|obsidian):\/\/[^\s<>"'\x60[\]]+/giu)) {
		links.push({ path: match[0].replace(/[。，、；！？）》),;!?.]+$/gu, ''), offset: match.index });
	}
	for (const { path, explicitImage } of links.sort((a, b) => a.offset - b.offset)) addLink(path, explicitImage);
	return [...images.values()].slice(0, MAX_IMAGES + 1);
}

function vaultLink(app: App | undefined, link: string, sourcePath: string): string | undefined {
	const uri = URL.parse(link);
	if (uri?.protocol === 'obsidian:') {
		const vault = uri.searchParams.get('vault');
		if (vault && vault !== app?.vault.getName()) throw new Error('只能读取当前笔记库中的图片。');
		return normalizeVaultRelativePath(uri.searchParams.get('file') ?? '');
	}
	const raw = link.split('#', 1)[0]!;
	let path = raw;
	try { path = decodeURIComponent(raw); } catch { /* Literal percent signs are valid in vault paths. */ }
	if (isAbsolute(path) || path.includes('\\')) return;
	const linked = app?.metadataCache?.getFirstLinkpathDest(path, sourcePath);
	if (linked) return normalizeVaultRelativePath(linked.path);
	return normalizeVaultRelativePath(path.startsWith('./') || path.startsWith('../')
		? posix.join(posix.dirname(sourcePath), path) : path);
}

export function createImageAttachments(app?: App, fetchRemote = readRemoteImage) {
	const remoteCache = new WeakMap<RunContext['task'], Map<string, ImageContent>>();
	return (ctx: RunContext, messages: Message[], current: Message[]): ModelRequest['images'] => {
		const active = new Set(current.map(({ imageRefs }) => imageRefs).filter(Boolean));
		const selected = messages.flatMap(({ role, imageRefs }, index) =>
			imageRefs?.length && active.has(imageRefs) && (role === 'user' || role === 'tool') ? [{ role, imageRefs, index }] : []);
		if (!selected.length) return;
		const user = selected.filter(({ role }) => role === 'user');
		const tool = selected.filter(({ role }) => role === 'tool').reverse();
		return {
			required: user.length > 0,
			references: new Map(selected.map(({ index, imageRefs }) => [index, imageRefs])),
			async load(signal) {
				if (user.reduce((sum, { imageRefs }) => sum + imageRefs.length, 0) > MAX_IMAGES) {
					throw new Error('一次模型请求最多发送 12 张图片。');
				}
				const output = new Map<number, ImageContent[]>();
				const loaded = new Map<string, ImageContent>();
				let available = MAX_REQUEST_IMAGE_BYTES;
				let count = 0;
				for (const { role, imageRefs, index } of [...user, ...tool]) {
					const images: ImageContent[] = [];
					for (const ref of imageRefs) {
						signal.throwIfAborted();
						if (role === 'tool' && (ref.kind !== 'tool' || count >= MAX_IMAGES || available <= 0)) continue;
						try {
							const key = JSON.stringify(ref);
							const image = loaded.get(key) ?? await loadImage(ctx, ref, signal);
							const size = Buffer.byteLength(image.data, 'base64');
							if (size > available || count >= MAX_IMAGES) {
								if (role === 'tool') continue;
								throw new Error('一次模型请求的图片合计不能超过 12 MiB。');
							}
							loaded.set(key, image);
							images.push(image);
							available -= size;
							count++;
						} catch (error) {
							signal.throwIfAborted();
							if (role === 'user') throw new Error('无法发送图片。' + (error instanceof Error ? error.message : ''));
						}
					}
					if (images.length) output.set(index, images);
				}
				return output;
			},
		};
	};

	async function loadImage(ctx: RunContext, ref: ImageReference, signal: AbortSignal): Promise<ImageContent> {
		if (ref.kind === 'pasted') return readCachedImage(ctx.cwd, ref.path, signal);
		if (ref.kind === 'tool') return readCachedImage(ctx.cwd, ref.path, signal, ctx.task.request.conversationId, ctx.subagentId);
		if (ref.kind === 'url') {
			const url = publicImageUrl(ref.path);
			let cache = remoteCache.get(ctx.task);
			if (!cache) remoteCache.set(ctx.task, cache = new Map<string, ImageContent>());
			const existing = cache.get(url.href);
			if (existing) return existing;
			const image = await fetchRemote(url, signal);
			if (cache.size < MAX_IMAGES && [...cache.values()].reduce((sum, item) => sum + item.data.length, image.data.length)
				<= MAX_REQUEST_IMAGE_BYTES * 4 / 3 + MAX_IMAGES * 4) cache.set(url.href, image);
			return image;
		}
		const source = ref.kind === 'vault-link'
			? ref.sourcePath ?? ctx.task.request.skillNotePaths?.[0] ?? app?.workspace?.getActiveFile()?.path ?? '' : '';
		const path = ref.kind === 'vault-link' ? vaultLink(app, ref.path, source) : ref.path;
		if (!path) throw new Error('找不到笔记库中的图片。');
		const resolved = await resolveToolPath({ ...ctx, signal }, path, 'read');
		const configDir = app?.vault.configDir;
		if ((ref.kind === 'vault-link' && (!resolved.vaultPath || (configDir && resolved.vaultPath.startsWith(configDir + '/'))))
			|| ctx.permissions.readLines?.(resolved.absolutePath)) throw new Error('本次任务未授权读取整张图片。');
		return readImageFile(resolved, signal);
	}
}
