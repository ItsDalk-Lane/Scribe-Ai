import { Buffer } from 'node:buffer';
import { boundedMedia } from './arkVisual';
import { MediaHttpError } from './mediaApi';
import type { MediaCall, MediaExtension, MediaResult, MediaSource } from './mediaApi';

export function mediaObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务商返回了无效的媒体数据。');
	return value as Record<string, unknown>;
}

export function mediaProperty(value: unknown, key: string): string {
	const entry = mediaObject(value)[key];
	if (typeof entry !== 'string' || !entry.trim()) throw new Error('服务商没有返回所需的媒体字段。');
	return entry;
}

export function mediaItems(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

export function mediaSource(ctx: MediaCall): MediaSource {
	if (!ctx.source) throw new Error('请附加相应的媒体文件。');
	return ctx.source;
}

export function mediaPart(form: FormData, key: string, source: MediaSource): void {
	form.append(key, new Blob([Uint8Array.from(source.bytes)], { type: source.mimeType }), source.filename);
}

export async function directPost(ctx: MediaCall, body: FormData | object, headers?: Record<string, string>): Promise<Response> {
	const multipart = body instanceof FormData;
	const response = await ctx.fetch(ctx.endpoint, {
		method: 'POST', redirect: 'error', signal: ctx.signal,
		headers: { ...!multipart && { 'content-type': 'application/json' }, ...(headers ?? { authorization: `Bearer ${ctx.key}` }) },
		body: multipart ? body : JSON.stringify(body),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new MediaHttpError(response.status);
	}
	return response;
}

async function responseBytes(response: Response, signal: AbortSignal, limit: number): Promise<Buffer> {
	if (!response.body) throw new Error('服务商没有返回媒体数据。');
	const chunks: Uint8Array[] = [];
	for await (const chunk of boundedMedia(response.body, limit, signal)) chunks.push(chunk);
	return Buffer.concat(chunks);
}

export async function directFormJson(ctx: MediaCall, form: FormData, headers?: Record<string, string>): Promise<unknown> {
	const response = await directPost(ctx, form, headers);
	return JSON.parse((await responseBytes(response, ctx.signal, 40 * 1024 * 1024)).toString('utf8')) as unknown;
}

export async function directPostAudio(ctx: MediaCall, body: object, extension: MediaExtension,
	sampleRate?: number, headers?: Record<string, string>): Promise<MediaResult> {
	const response = await directPost(ctx, body, headers);
	const contentType = response.headers.get('content-type');
	if (contentType && !/^(?:audio\/|application\/octet-stream)/iu.test(contentType)) {
		await response.body?.cancel();
		throw new Error('服务商没有返回音频文件。');
	}
	const bytes = await responseBytes(response, ctx.signal, 24 * 1024 * 1024);
	return { bytes, extension, ...(sampleRate && { sampleRate }) };
}

export function mediaBase64(value: string): Buffer {
	if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 === 1) throw new Error('服务商返回了无效的媒体编码。');
	return Buffer.from(value, 'base64');
}

export function mediaImageResult(value: unknown, fallback: 'jpg' | 'png' | 'webp'): MediaResult {
	const entry = mediaObject(mediaItems(mediaObject(value).data)[0]);
	const mimeType = entry.mime_type;
	const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : fallback;
	if (typeof entry.b64_json === 'string') return { bytes: mediaBase64(entry.b64_json), extension };
	return { url: mediaProperty(entry, 'url'), extension };
}

export function mediaTranscript(value: unknown): MediaResult {
	const entry = mediaObject(value);
	if (typeof entry.text !== 'string') throw new Error('服务商没有返回语音转写。');
	return { text: entry.text };
}

export function appendMediaOptions(form: FormData, options: Record<string, unknown>): void {
	for (const [field, value] of Object.entries(options)) {
		if (value !== undefined && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
			form.append(field, String(value));
		}
	}
}
