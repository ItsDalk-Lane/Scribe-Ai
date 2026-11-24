import { Buffer } from 'node:buffer';
import { isAbsolute } from 'node:path';
import { videoMime } from '../../communication/modelVideo';
import { openToolFile } from '../../tools/support/fileAccess';
import { resolveToolPath } from '../../tools/support/pathUtils';
import type { ModelRequest, ModelVideo, RunContext, TaskRequest, VideoSourceKind } from '../../types';

// Reserve headroom for Base64 expansion and text inside Gemini's 20 MB inline request limit.
export const MAX_VIDEO_BYTES = 12 * 1024 * 1024;

export type VideoSource = { mimeType: string } & ({ path: string; url?: never } | { url: string; path?: never });

export function videoSourceKind(source: VideoSource): VideoSourceKind {
	return source.path === undefined ? 'link' : 'file';
}

export function videoSources(request: TaskRequest, detect = videoMime): VideoSource[] {
	const files = request.refs.flatMap(({ path, kind, lines, addedExternal }) => {
		const mimeType = kind !== 'folder' && !lines && (!isAbsolute(path) || addedExternal) && detect(path);
		return mimeType ? [{ path, mimeType }] : [];
	});
	const links = [...request.instruction.matchAll(/!\[[^\]\n]*\]\((https:\/\/[^\s)]+)\)/gu)].flatMap((match) => {
		const url = URL.parse(match[1]!);
		const mimeType = url && !url.username && !url.password && detect(url.pathname);
		return mimeType ? [{ url: url.href, mimeType }] : [];
	});
	return [...links, ...files];
}

export async function openVideoAttachment(ctx: RunContext, path: string, signal: AbortSignal) {
	const resolved = await resolveToolPath({ ...ctx, signal }, path, 'read');
	if (ctx.permissions.readLines?.(resolved.absolutePath)) throw new Error('此视频未授权为完整附件。');
	return openToolFile(resolved);
}

export function videoAttachments(ctx: RunContext, messageIndex: number): ModelRequest['video'] {
	if (ctx.sideChat || ctx.subagentId || ctx.task.request.intent || messageIndex < 0) return;
	const sources = videoSources(ctx.task.request).filter((source) => !ctx.videoAnalysis?.sources.includes(videoSourceKind(source)));
	if (!sources.length) return;
	return {
		messageIndex, hasFiles: sources.some(({ path }) => path !== undefined),
		async load(signal) {
			let available = MAX_VIDEO_BYTES;
			const videos: ModelVideo[] = [];
			for (const { path, url, mimeType } of sources) {
				if (url !== undefined) { videos.push({ url, mimeType }); continue; }
				signal.throwIfAborted();
				const { file, size } = await openVideoAttachment(ctx, path, signal);
				try {
					if (!size || size > available) throw new Error('本次视频附件必须为非空文件，总大小不得超过 12 MiB。');
					const buffer = Buffer.alloc(size + 1);
					let read = 0;
					while (read < buffer.length) {
						signal.throwIfAborted();
						const { bytesRead } = await file.read(buffer, read, buffer.length - read, read);
						if (!bytesRead) break;
						read += bytesRead;
					}
					if (read !== size) throw new Error('视频附件已变化，请重新选择后发送。');
					available -= size;
					videos.push({ mimeType, data: buffer.subarray(0, read).toString('base64') });
				} finally {
					await file.close();
				}
			}
			signal.throwIfAborted();
			return videos;
		},
	};
}
