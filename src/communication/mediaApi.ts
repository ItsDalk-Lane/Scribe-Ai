import { Buffer } from 'node:buffer';
import { boundedMedia } from './arkVisual';

export const MEDIA_OPERATIONS = ['image', 'image-edit', 'video', 'video-edit', 'speech-synthesis', 'speech-recognition'] as const;
export type MediaOperation = typeof MEDIA_OPERATIONS[number];
export type MediaExtension = 'png' | 'jpg' | 'webp' | 'mp4' | 'mp3' | 'wav' | 'ogg' | 'pcm' | 'flac' | 'aac';
export type MediaValues = Record<string, string | number | boolean>;
export interface MediaField {
	key: string;
	label: readonly [zh: string, en: string] | string;
	choices?: readonly (string | number)[];
	type?: 'string' | 'number' | 'boolean';
	min?: number;
	max?: number;
	default?: string | number | boolean;
	required?: boolean;
}
export interface MediaRoute { model: string; baseUrl?: string }
export interface MediaSource { bytes: Uint8Array; filename: string; mimeType: string }
export interface MediaCall extends MediaRoute {
	key: string;
	endpoint: string;
	fetch: typeof fetch;
	signal: AbortSignal;
	prompt: string;
	options: MediaValues;
	source?: MediaSource;
	sourceUrl?: string;
}
export type MediaOutput = { bytes: Uint8Array; extension: MediaExtension; sampleRate?: number } | { url: string; extension: MediaExtension };
export type MediaResult = MediaOutput | { text: string } | { id: string };
export type MediaPoll = { status: 'queued' | 'running' | 'failed' } | { status: 'succeeded'; result: MediaOutput };
export interface MediaAdapter {
	providerId: string;
	operation: MediaOperation;
	models: readonly string[];
	endpoint(route: MediaRoute): string;
	fields?: readonly MediaField[] | ((model: string) => readonly MediaField[]);
	input?: 'image' | 'video' | 'audio' | 'image-url' | 'video-url' | 'audio-url';
	requiresSource?: boolean;
	run(ctx: MediaCall): Promise<MediaResult>;
	poll?(this: void, ctx: MediaCall, id: string): Promise<MediaPoll>;
}

export class MediaHttpError extends Error {
	constructor(readonly status: number) { super(`媒体请求失败（HTTP ${status}）。`); }
}

export function mediaDataUrl({ bytes, mimeType }: MediaSource): string {
	return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

export async function responseBytes(response: Response, limit: number, signal: AbortSignal) {
	if (!response.ok) {
		await response.body?.cancel();
		throw new MediaHttpError(response.status);
	}
	if (!response.body) throw new Error('媒体服务没有返回内容。');
	const chunks: Uint8Array[] = [];
	for await (const chunk of boundedMedia(response.body, limit, signal)) chunks.push(chunk);
	return Buffer.concat(chunks);
}

export async function mediaJson<T = Record<string, unknown>>(ctx: MediaCall, url: string, body?: unknown,
	headers: HeadersInit = {}): Promise<T> {
	const actual = new Headers({ Authorization: `Bearer ${ctx.key}`, Accept: 'application/json' });
	if (body !== undefined) actual.set('Content-Type', 'application/json');
	const provided = new Headers(headers);
	if (['x-goog-api-key', 'x-api-key', 'api-key'].some((name) => provided.has(name))) actual.delete('Authorization');
	provided.forEach((value, key) => actual.set(key, value));
	const response = await ctx.fetch(url, {
		method: body === undefined ? 'GET' : 'POST', headers: actual, redirect: 'error', signal: ctx.signal,
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	return JSON.parse((await responseBytes(response, 96 * 1024 * 1024, ctx.signal)).toString('utf8')) as T;
}

export async function mediaBytes(ctx: MediaCall, url: string, extension: MediaExtension,
	headers: HeadersInit = { Authorization: `Bearer ${ctx.key}` }): Promise<MediaOutput> {
	const response = await ctx.fetch(url, { headers, redirect: 'error', signal: ctx.signal });
	return { bytes: await responseBytes(response, extension === 'mp4' ? 200 * 1024 * 1024 : 32 * 1024 * 1024, ctx.signal), extension };
}

export function mediaFields(adapter: MediaAdapter, model: string): readonly MediaField[] {
	return (typeof adapter.fields === 'function' ? adapter.fields(model) : adapter.fields) ?? [];
}

export function mediaOptions(fields: readonly MediaField[], saved: unknown, supplied?: unknown, useDefaults = true): MediaValues {
	const output: MediaValues = {};
	const schema = new Map(fields.map((field) => [field.key, field]));
	for (const source of [saved, supplied]) {
		if (source === undefined) continue;
		if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('媒体参数须为对象。');
		for (const [key, value] of Object.entries(source)) {
			if (value === undefined) continue;
			const field = schema.get(key);
			if (!field) throw new Error(`当前模型和操作不支持参数 ${key}。`);
			const valid = field.choices ? field.choices.includes(value as never)
				: field.type === 'boolean' ? typeof value === 'boolean'
					: field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
						&& value >= (field.min ?? -Infinity) && value <= (field.max ?? Infinity)
						: typeof value === 'string' && value.length <= 1000 && value.trim() !== '';
			if (!valid) throw new Error(`媒体参数 ${key} 的值无效。`);
			output[key] = value as MediaValues[string];
		}
	}
	if (useDefaults) {
		for (const field of fields) {
			if (output[field.key] === undefined && field.default !== undefined) output[field.key] = field.default;
			if (field.required && output[field.key] === undefined) throw new Error(`请配置媒体参数 ${field.key}。`);
		}
	}
	return output;
}
