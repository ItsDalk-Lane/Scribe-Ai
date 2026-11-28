import { Buffer } from 'node:buffer';
import type { ImageOptions, VideoOptions } from '../orchestration/settings/mediaSettings';
import { openRemoteMedia } from '../tools/support/remoteImage';

export const ARK_IMAGE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations';
export const ARK_VIDEO_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks';
export type ArkFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit, confirm?: (target: URL) => Promise<void>) => Promise<Response>;
const imageLimit = 24 * 1024 * 1024;
const videoLimit = 200 * 1024 * 1024;

export function authorizedArkFetch(fetcher: ArkFetch, confirm: () => void): typeof fetch {
	return (input, init) => {
		confirm();
		const expected = new Request(input).url;
		return fetcher(input, init, async (target) => {
			confirm();
			if (target.href !== expected) throw new Error('媒体服务接收地址已变化。');
		});
	};
}

function arkRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('火山方舟返回了无效的结果。');
	return value as Record<string, unknown>;
}

export async function* boundedMedia(body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal) {
	const reader = body.getReader();
	let size = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error('服务返回的数据超过大小限制。');
			yield value;
		}
		if (!size) throw new Error('服务返回了空内容。');
	} finally {
		await reader.cancel().catch(() => {});
	}
}

async function collect(body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal) {
	const chunks: Uint8Array[] = [];
	for await (const bytes of boundedMedia(body, limit, signal)) chunks.push(bytes);
	return Buffer.concat(chunks);
}

export class ArkHttpError extends Error {
	constructor(readonly status: number, operation: string, code?: string) {
		super(`${operation}（HTTP ${status}${code ? `，${code}` : ''}）。`);
	}
}

async function arkErrorCode(response: Response, key: string, signal: AbortSignal): Promise<string | undefined> {
	if (!response.body) return undefined;
	if (!response.headers.get('content-type')?.toLowerCase().includes('json')) {
		await response.body.cancel().catch(() => {});
		return undefined;
	}
	try {
		const payload = JSON.parse((await collect(response.body, 8 * 1024, signal)).toString('utf8')) as { error?: { code?: unknown }; code?: unknown };
		const code = payload.error?.code ?? payload.code;
		if (typeof code === 'string' && /^[a-z][a-z\d_.-]{0,95}$/iu.test(code) && !code.includes(key)) return code;
	} catch { /* Report the HTTP status when the provider error payload is unavailable. */ }
	return undefined;
}

async function readJson(fetcher: typeof fetch, url: string, key: string, signal: AbortSignal, operation: string, input?: object, limit = 256 * 1024) {
	const response = await fetcher(url, {
		method: input ? 'POST' : 'GET', redirect: 'error', signal,
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		...(input && { body: JSON.stringify(input) }),
	});
	if (!response.ok || !response.body) {
		throw new ArkHttpError(response.status, operation, await arkErrorCode(response, key, signal));
	}
	const body = await collect(response.body, limit, signal);
	try { return arkRecord(JSON.parse(body.toString('utf8')) as unknown); }
	catch { throw new Error('火山方舟返回了无效的 JSON 数据。'); }
}

function usage(value: unknown) {
	if (!value || typeof value !== 'object') return undefined;
	const number = (value as { completion_tokens?: unknown; output_tokens?: unknown }).completion_tokens
		?? (value as { output_tokens?: unknown }).output_tokens;
	return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

export async function downloadArkMedia(value: unknown, kind: 'image' | 'video', signal: AbortSignal) {
	const url = typeof value === 'string' ? URL.parse(value) : null;
	if (!url || url.protocol !== 'https:') throw new Error('火山方舟未返回有效的下载地址。');
	const { body, length } = await openRemoteMedia(url, signal, kind, true);
	const limit = kind === 'image' ? imageLimit : videoLimit;
	if (length > limit) {
		await body.cancel();
		throw new Error('生成的媒体超过本地保存大小限制。');
	}
	return { body, limit };
}

export async function generateArkImage(fetcher: typeof fetch, key: string, model: string, prompt: string, options: ImageOptions,
	reference: string | undefined, signal: AbortSignal): Promise<{ bytes: Buffer; extension: 'png' | 'jpg'; tokens?: number }> {
	const { size, background, format } = options;
	const reply = await readJson(fetcher, ARK_IMAGE_URL, key, signal, '方舟生图请求失败', {
		model, prompt, response_format: 'b64_json', size, background, output_format: format, image: reference,
	}, imageLimit * 4 / 3 + 256 * 1024);
	const image = arkRecord(Array.isArray(reply.data) ? reply.data[0] : undefined);
	let bytes: Buffer;
	if (typeof image.b64_json === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(image.b64_json)) {
		bytes = Buffer.from(image.b64_json, 'base64');
	} else {
		const { body, limit } = await downloadArkMedia(image.url, 'image', signal);
		bytes = await collect(body, limit, signal);
	}
	if (bytes.byteLength > imageLimit) throw new Error('生成的图片超过本地保存大小限制。');
	const extension: 'png' | 'jpg' | undefined = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
		: bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'jpg' : undefined;
	if (!extension) throw new Error('方舟返回的文件不是有效的 PNG 或 JPEG。');
	return { bytes, extension, tokens: usage(reply.usage) };
}

export function isArkVideoId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z\d][a-z\d_-]{0,127}$/iu.test(value);
}

export async function createArkVideo(fetcher: typeof fetch, key: string, model: string, prompt: string, options: VideoOptions,
	reference: string | undefined, signal: AbortSignal) {
	const { ratio, duration, resolution, generateAudio } = options;
	const content = [{ type: 'text', text: prompt }, ...(reference ? [{ type: 'image_url', image_url: { url: reference }, role: 'first_frame' }] : [])];
	const { id } = await readJson(fetcher, ARK_VIDEO_URL, key, signal, '方舟视频提交失败', {
		model, content, ratio, duration, resolution, generate_audio: generateAudio,
	});
	if (!isArkVideoId(id)) throw new Error('视频请求没有返回有效的任务编号。');
	return id;
}

export async function queryArkVideo(fetcher: typeof fetch, key: string, id: string, signal: AbortSignal) {
	if (!isArkVideoId(id)) throw new Error('视频任务编号无效。');
	const reply = await readJson(fetcher, `${ARK_VIDEO_URL}/${id}`, key, signal, '方舟视频查询失败');
	if (reply.id !== id) throw new Error('方舟返回的视频任务编号不匹配。');
	const { status } = reply;
	if (status === 'queued' || status === 'running') return { status } as const;
	if (status === 'failed' || status === 'expired' || status === 'cancelled') return { status } as const;
	if (status !== 'succeeded') throw new Error('方舟返回了未知的视频任务状态。');
	return {
		status, url: arkRecord(reply.content).video_url, tokens: usage(reply.usage),
		...(typeof reply.duration === 'number' && Number.isFinite(reply.duration) && { duration: reply.duration }),
		...(typeof reply.resolution === 'string' && /^[\da-z]+$/iu.test(reply.resolution) && { resolution: reply.resolution }),
	} as const;
}
