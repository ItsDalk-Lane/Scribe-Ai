import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { videoMime } from '../../communication/modelVideo';
import { hasFileErrorCode } from '../../tools/support/pathUtils';
import { openRemoteMedia } from '../../tools/support/remoteImage';
import { createSpillDirectory } from '../../tools/support/resultSpill';
import type { ModelVideo, RunContext } from '../../types';
import { scribeDataPaths, VIDEO_CACHE_PREFIX } from '../storage/paths';
import { MAX_VIDEO_BYTES, openVideoAttachment, type VideoSource } from './videoAttachments';

const runFile = promisify(execFile);
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const localMedia = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,mp4,matroska,webm,avi,mpeg,mpegts,flv,asf,ogg'];

export function transcodableVideo(path: string) {
	return videoMime(path) ?? (/\.(?:avi|m4v|mpg|mpeg|ts|mts|m2ts|flv|wmv|ogv)$/iu.test(path) ? 'video/unknown' : undefined);
}

async function runMediaTool(tool: 'ffprobe' | 'ffmpeg', args: string[], signal: AbortSignal): Promise<string> {
	const executables = process.platform === 'darwin' ? [tool, '/opt/homebrew/bin/' + tool, '/usr/local/bin/' + tool] : [tool];
	for (const executable of executables) {
		try {
			const { stdout } = await runFile(executable, args, {
				signal, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
			});
			return stdout;
		} catch (error) {
			signal.throwIfAborted();
			if (hasFileErrorCode(error, 'ENOENT')) continue;
			const failure = error as { killed?: boolean; stderr?: string };
			const cause = failure.stderr?.trim().split(/\r?\n/u).at(-1)?.slice(0, 250);
			throw new Error(failure.killed ? '本地视频处理超时。' : (tool === 'ffprobe' ? '无法读取视频格式。' : '视频转码失败。') + (cause ? ' ' + cause : ''));
		}
	}
	throw new Error('找不到 ' + tool + '。请安装 FFmpeg 后重新打开 Obsidian。');
}

async function probe(path: string, signal: AbortSignal) {
	const output = await runMediaTool('ffprobe', ['-v', 'error', ...localMedia, '-show_entries',
		'format=duration:format_tags=major_brand:stream=codec_type,codec_name,pix_fmt:stream_disposition=attached_pic', '-of', 'json', '-i', path], signal);
	const { streams = [], format } = JSON.parse(output) as {
		streams?: { codec_type?: string; codec_name?: string; pix_fmt?: string; disposition?: { attached_pic?: number } }[];
		format?: { duration?: string; tags?: { major_brand?: string } };
	};
	const video = streams.find(({ codec_type, disposition }) => codec_type === 'video' && !disposition?.attached_pic);
	if (!video) throw new Error('文件没有可读取的视频轨道。');
	const duration = Number(format?.duration);
	return {
		duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
		compatible: /^(?:isom|iso[2-9]|mp4[12]|avc1)$/u.test(format?.tags?.major_brand?.trim() ?? '')
			&& video.codec_name === 'h264' && video.pix_fmt === 'yuv420p'
			&& streams.filter(({ codec_type }) => codec_type === 'audio').every(({ codec_name }) => codec_name === 'aac'),
	};
}

async function* boundedSource(input: AsyncIterable<Buffer>, signal: AbortSignal) {
	let bytes = 0;
	for await (const chunk of input) {
		signal.throwIfAborted();
		bytes += chunk.length;
		if (bytes > MAX_SOURCE_BYTES) throw new Error('原始视频不能超过 128 MiB。');
		yield chunk;
	}
	if (!bytes) throw new Error('视频文件为空。');
}

export async function prepareVideo(ctx: RunContext, source: VideoSource, signal: AbortSignal): Promise<ModelVideo> {
	const directory = createSpillDirectory({
		cacheDirectory: scribeDataPaths(ctx.cwd).cache, conversationId: ctx.task.request.conversationId,
	}, VIDEO_CACHE_PREFIX);
	if (!directory) throw new Error('无法创建视频处理所需的库内缓存目录。');
	const input = join(directory, 'source');
	const output = join(directory, 'converted.mp4');
	const save = (stream: AsyncIterable<Buffer>) => pipeline(
		boundedSource(stream, signal), createWriteStream(input, { flags: 'wx', mode: 0o600 }), { signal });
	try {
		if (source.path !== undefined) {
			const { file, size } = await openVideoAttachment(ctx, source.path, signal);
			try {
				if (size > MAX_SOURCE_BYTES) throw new Error('原始视频不能超过 128 MiB。');
				await save(file.createReadStream({ start: 0, end: size, autoClose: false }));
				if ((await stat(input)).size !== size) throw new Error('视频读取期间已变化，请重新选择。');
			} finally { await file.close(); }
		} else {
			const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
			try {
				const { body, length } = await openRemoteMedia(new URL(source.url), downloadSignal, 'video', true);
				if (length > MAX_SOURCE_BYTES) {
					await body.cancel();
					throw new Error('原始视频不能超过 128 MiB。');
				}
				await save(Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>));
			} catch (error) {
				signal.throwIfAborted();
				if (downloadSignal.aborted) throw new Error('下载视频链接超时。');
				throw error;
			}
		}
		const original = await probe(input, signal);
		let prepared = input;
		if (!original.compatible || !original.duration || (await stat(input)).size > MAX_VIDEO_BYTES) {
			await runMediaTool('ffmpeg', ['-v', 'error', '-nostdin', '-xerror', ...localMedia, '-i', input,
				'-map', '0:V:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
				'-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '24',
				'-c:a', 'aac', '-movflags', '+faststart', '-fs', String(MAX_VIDEO_BYTES + 65_536), '-f', 'mp4', output], signal);
			if ((await stat(output)).size > MAX_VIDEO_BYTES) throw new Error('转码后的 MP4 仍超过 12 MiB，请选用较短或较小的视频。');
			const converted = await probe(output, signal);
			if (!converted.compatible || !converted.duration
				|| (original.duration !== undefined && Math.abs(converted.duration - original.duration) > 0.25)) {
				throw new Error('转码结果不完整或格式不符合要求，请更换视频。');
			}
			prepared = output;
		}
		return { mimeType: 'video/mp4', data: (await readFile(prepared, { signal })).toString('base64') };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
