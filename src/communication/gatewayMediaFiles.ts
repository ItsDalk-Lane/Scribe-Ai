import { Buffer } from 'node:buffer';
import { boundedMedia } from './arkVisual';
import type { MediaCall, MediaExtension, MediaField, MediaSource } from './mediaApi';

export function mediaSource(ctx: MediaCall): MediaSource {
	if (!ctx.source) throw new Error('请明确附加此操作需要的素材。');
	return ctx.source;
}

export function sourceBlob(source: MediaSource) {
	return new Blob([Uint8Array.from(source.bytes)], { type: source.mimeType });
}

export function base64Result(value: unknown, extension: MediaExtension) {
	if (typeof value !== 'string') throw new Error('服务未返回媒体内容。');
	const encoded = value.replace(/^data:[\w.+/-]+;base64,/u, '');
	if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('媒体编码无效。');
	const bytes = Buffer.from(encoded, 'base64');
	if (!bytes.length) throw new Error('服务返回了空媒体。');
	return { bytes, extension };
}

export function imageResult(value: unknown) {
	const { bytes } = base64Result(value, 'png');
	return imageBytesResult(bytes);
}

export function imageBytesResult(bytes: Buffer) {
	const result = { bytes, extension: 'png' as const };
	if (!bytes.length) throw new Error('服务返回了空媒体。');
	if (bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return result;
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ...result, extension: 'jpg' as const };
	if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
		return { ...result, extension: 'webp' as const };
	}
	throw new Error('服务未返回受支持的图片格式。');
}

export function transcriptResult(text: unknown) {
	if (typeof text !== 'string') throw new Error('服务未返回转写文本。');
	return { text };
}

export function videoJobId(value: unknown) {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) throw new Error('服务未返回有效的视频任务编号。');
	return value;
}

export async function postMedia(ctx: MediaCall, body: FormData | Blob | object, headers: Record<string, string> = {}) {
	const multipart = body instanceof FormData;
	const binary = body instanceof Blob;
	const response = await ctx.fetch(ctx.endpoint, {
		method: 'POST', redirect: 'error', signal: ctx.signal,
		headers: { Authorization: `Bearer ${ctx.key}`, ...(!multipart && !binary && { 'Content-Type': 'application/json' }), ...headers },
		body: multipart || binary ? body : JSON.stringify(body),
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`媒体服务请求失败（HTTP ${response.status}）。`);
	}
	return response;
}

async function readMediaReply(response: Response, limit: number, signal: AbortSignal) {
	if (!response.body) throw new Error('服务未返回预期的媒体格式。');
	const chunks: Uint8Array[] = [];
	for await (const bytes of boundedMedia(response.body, limit, signal)) chunks.push(bytes);
	return Buffer.concat(chunks);
}

export async function mediaReplyJson<T>(response: Response, signal: AbortSignal): Promise<T> {
	return JSON.parse((await readMediaReply(response, 48 * 1024 * 1024, signal)).toString('utf8')) as T;
}

export async function mediaReplyBytes(response: Response, extension: MediaExtension, signal: AbortSignal) {
	const type = response.headers.get('content-type')?.toLowerCase() ?? '';
	if (!response.body || (!type.startsWith('audio/') && !type.startsWith('image/') && !type.startsWith('application/octet-stream'))) {
		await response.body?.cancel().catch(() => {});
		throw new Error('服务未返回预期的媒体格式。');
	}
	return { bytes: await readMediaReply(response, 32 * 1024 * 1024, signal), extension };
}

export const ratioField: MediaField = { key: 'aspect_ratio', label: ['宽高比', 'Aspect ratio'], choices: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'] };
export const seedField: MediaField = { key: 'seed', label: ['随机种子', 'Seed'], type: 'number', min: 0, max: 2_147_483_647 };
export const languageField: MediaField = { key: 'language', label: ['语言代码', 'Language code'], type: 'string' };
