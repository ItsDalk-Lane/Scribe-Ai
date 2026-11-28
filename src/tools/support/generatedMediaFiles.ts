import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { GENERATED_MEDIA_CACHE_PREFIX, isGeneratedMediaRef, scribeDataPaths } from '../../orchestration/storage/paths';
import { normalizeMediaDirectory } from '../../orchestration/settings/mediaSettings';
import type { GeneratedMediaRef } from '../../types';
import { hasFileErrorCode } from './pathUtils';
import { createSpillDirectory } from './resultSpill';
import type { MediaExtension } from '../../communication/mediaApi';
import type { MediaOutput } from '../../communication/mediaApi';
import { boundedMedia } from '../../communication/arkVisual';
import { openRemoteMedia } from './remoteImage';

export interface MediaDestination {
	cwd: string;
	conversationId: string;
	subagentId?: string;
	directory?: string;
	configDir: string;
}

export async function publishMediaOutput(destination: MediaDestination, kind: GeneratedMediaRef['kind'], output: MediaOutput,
	signal: AbortSignal, beforePublish?: (media: GeneratedMediaRef) => Promise<void>): Promise<GeneratedMediaRef> {
	const limit = kind === 'video' ? 200 * 1024 * 1024 : 32 * 1024 * 1024;
	const format = output.extension === 'pcm'
		? { extension: 'pcm' as const, sampleRate: 'sampleRate' in output ? output.sampleRate ?? 0 : 0 } : output.extension;
	if ('bytes' in output) {
		if (!output.bytes.length || output.bytes.length > limit) throw new Error('服务返回的媒体文件大小无效。');
		return saveGeneratedMedia(destination, kind, format, output.bytes, signal, beforePublish);
	}
	const url = URL.parse(output.url);
	if (url?.protocol !== 'https:') throw new Error('媒体服务未返回有效的 HTTPS 下载地址。');
	const { body, length } = await openRemoteMedia(url, signal, kind);
	if (length > limit) {
		await body.cancel();
		throw new Error('生成的媒体超过本地保存大小限制。');
	}
	return saveGeneratedMedia(destination, kind, format, boundedMedia(body, limit, signal), signal, beforePublish);
}

export async function checkMediaDirectory({ cwd, directory, configDir }: MediaDestination, create = false) {
	const selected = directory ? normalizeMediaDirectory(directory) : '';
	if (!selected) return;
	const config = configDir.replace(/\\/gu, '/').toLowerCase();
	if (config && (selected.toLowerCase() === config || selected.toLowerCase().startsWith(config + '/'))) {
		throw new Error('请选择笔记库中用来保存附件的目录。');
	}
	let path = await realpath(cwd);
	for (const part of selected.split('/')) {
		path = join(path, part);
		let item = await lstat(path).catch((error: unknown) => {
			if (!hasFileErrorCode(error, 'ENOENT')) throw error;
			return undefined;
		});
		if (!item) {
			if (!create) return path;
			await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
				if (!hasFileErrorCode(error, 'EEXIST')) throw error;
			});
			item = await lstat(path);
		}
		if (!item.isDirectory() || await realpath(path) !== path) throw new Error('媒体保存目录包含文件或符号链接，请重新选择。');
	}
	return path;
}

export async function saveGeneratedMedia(destination: MediaDestination, kind: GeneratedMediaRef['kind'],
	format: Exclude<MediaExtension, 'pcm'> | { extension: 'pcm'; sampleRate: number },
	bytes: Uint8Array | AsyncIterable<Uint8Array>, signal: AbortSignal,
	beforePublish?: (media: GeneratedMediaRef) => Promise<void>): Promise<GeneratedMediaRef> {
	signal.throwIfAborted();
	const root = await realpath(destination.cwd);
	const custom = await checkMediaDirectory(destination, true);
	const stage = custom ? await mkdtemp(join(custom, '.scribe-media-')) : createSpillDirectory({
		cacheDirectory: scribeDataPaths(destination.cwd).cache,
		conversationId: destination.conversationId, subagentId: destination.subagentId,
	}, GENERATED_MEDIA_CACHE_PREFIX);
	if (!stage) throw new Error('无法建立生成媒体的缓存目录。');
	const partial = join(stage, 'partial');
	const name = kind === 'audio' ? 'speech' : kind;
	const extension = typeof format === 'string' ? format : format.extension;
	const target = custom ? join(custom, `${name}-${randomUUID()}.${extension}`) : join(stage, `${name}.${extension}`);
	const media = { kind, path: relative(root, target).split(sep).join('/'),
		...(typeof format !== 'string' && { sampleRate: format.sampleRate }) };
	let saved = false;
	try {
		if (!isGeneratedMediaRef(media)) throw new Error('媒体文件格式或路径无效。');
		if (await realpath(stage) !== stage) throw new Error('媒体保存目录位置已变化。');
		await pipeline(bytes instanceof Uint8Array ? [bytes] : bytes, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal });
		if (kind === 'video') {
			const file = await open(partial, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const header = Buffer.alloc(8);
				const { bytesRead } = await file.read(header);
				if (bytesRead < 8 || header.toString('ascii', 4) !== 'ftyp') throw new Error('服务返回的文件不是可播放的 MP4。');
			} finally { await file.close(); }
		}
		await beforePublish?.(media);
		if (await realpath(stage) !== stage || (custom && await checkMediaDirectory(destination) !== custom)) {
			throw new Error('媒体保存目录位置已变化。');
		}
		signal.throwIfAborted();
		await rename(partial, target);
		saved = true;
		return media;
	} finally {
		if (await realpath(stage).catch(() => undefined) === stage) {
			await rm(custom || !saved ? stage : partial, { recursive: Boolean(custom || !saved), force: true }).catch(() => {});
		}
	}
}
