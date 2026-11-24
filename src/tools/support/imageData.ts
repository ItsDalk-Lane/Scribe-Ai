import { Buffer } from 'node:buffer';
import { realpath, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ImageContent } from '@earendil-works/pi-ai';
import { IMAGE_CACHE_PREFIX, isCachedImagePath } from '../../orchestration/storage/paths';
import { openToolFile } from './fileAccess';
import type { ResolvedToolPath } from './pathUtils';
import { createSpillDirectory, type SpillLocation } from './resultSpill';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGES = 12;

export function isImageFile(path: string): boolean {
	return /\.(?:png|jpe?g|gif|webp)$/iu.test(path);
}

function imageType(bytes: Buffer) {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'] as const;
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'jpg'] as const;
	if (/^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6))) return ['image/gif', 'gif'] as const;
	if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', 'webp'] as const;
	throw new Error('无法读取图片，请使用有效的 PNG、JPEG、GIF 或 WebP 文件。');
}

export function imageContent(bytes: Buffer): ImageContent {
	if (bytes.length > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 5 MiB。');
	return { type: 'image', mimeType: imageType(bytes)[0], data: bytes.toString('base64') };
}

export function decodeToolImage(data: string): ImageContent {
	if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('单张图片不能超过 5 MiB。');
	const bytes = Buffer.from(data, 'base64');
	if (bytes.toString('base64').replace(/=+$/u, '') !== data.replace(/=+$/u, '')) throw new Error('工具返回了无效的图片编码。');
	return imageContent(bytes);
}

export async function readImageFile(path: ResolvedToolPath, signal: AbortSignal): Promise<ImageContent> {
	const { file, size } = await openToolFile(path);
	try {
		if (size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 5 MiB。');
		const bytes = Buffer.alloc(size + 1);
		let read = 0;
		while (read < bytes.length) {
			signal.throwIfAborted();
			const chunk = await file.read(bytes, read, bytes.length - read, read);
			if (!chunk.bytesRead) break;
			read += chunk.bytesRead;
		}
		if (read !== size) throw new Error('图片文件已变化，请重试。');
		signal.throwIfAborted();
		return imageContent(bytes.subarray(0, read));
	} finally {
		await file.close();
	}
}

export async function saveCachedImage(cwd: string, location: SpillLocation, bytes: Buffer, name: 'image' | 'screenshot'): Promise<string> {
	if (bytes.length > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 5 MiB。');
	const [, extension] = imageType(bytes);
	const root = await realpath(cwd);
	const directory = createSpillDirectory(location, IMAGE_CACHE_PREFIX);
	if (!directory) throw new Error('无法保存图片到当前笔记库。');
	const path = join(directory, name + '.' + extension);
	await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
	return relative(root, path).split(sep).join('/');
}

export async function readCachedImage(cwd: string, path: string, signal: AbortSignal, conversationId?: string, subagentId?: string) {
	if (!isCachedImagePath(path, conversationId, subagentId)) throw new Error('图片不属于当前任务。');
	const absolutePath = join(await realpath(cwd), path);
	if (relative(absolutePath, await realpath(absolutePath)) !== '') throw new Error('图片缓存的位置已变化。');
	return readImageFile({
		absolutePath, requestedPath: absolutePath, displayPath: path, stat: await stat(absolutePath), cacheOutput: true,
	}, signal);
}
