import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { nodeRequire } from './nodeRequire';

const NULL_BODY = new Set([204, 205, 304]);

interface ResponseBridgeOptions {
	request: ClientRequest;
	signal: AbortSignal;
	cleanup: () => void;
	onData: () => void;
	onDone: () => void;
	onError: (error: unknown) => void;
}

function decodeResponse(response: IncomingMessage): Readable {
	const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
	if (!['gzip', 'br', 'deflate'].includes(encoding)) return response;
	const zlib = nodeRequire('node:zlib') as typeof import('node:zlib');
	const decoder = encoding === 'gzip'
		? zlib.createGunzip()
		: encoding === 'br'
			? zlib.createBrotliDecompress()
			: zlib.createInflate();
	response.on('error', (error) => decoder.destroy(error));
	response.pipe(decoder);
	return decoder;
}

export function bridgeResponse(
	response: IncomingMessage,
	options: ResponseBridgeOptions,
): Response {
	const { request, signal, cleanup, onData, onDone, onError } = options;
	const status = response.statusCode ?? 500;
	const headers = new Headers();
	for (const [key, value] of Object.entries(response.headers)) {
		if (key === 'content-encoding' || key === 'content-length') continue;
		for (const item of Array.isArray(value) ? value : [value ?? '']) headers.append(key, item);
	}

	if (NULL_BODY.has(status)) {
		response.resume();
		cleanup();
		onDone();
		return new Response(null, { status, statusText: response.statusMessage, headers });
	}

	const source = decodeResponse(response);
	let done = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			source.on('data', (chunk: Buffer) => {
				if (done) return;
				onData();
				controller.enqueue(new Uint8Array(chunk));
				if ((controller.desiredSize ?? 1) <= 0) source.pause();
			});
			source.on('end', () => {
				if (done) return;
				done = true;
				cleanup();
				onDone();
				controller.close();
			});
			source.on('error', (error) => {
				if (done) return;
				done = true;
				cleanup();
				onError(error);
				controller.error(signal.aborted ? signal.reason : error);
			});
		},
		pull() {
			if (!done) source.resume();
		},
		cancel() {
			if (done) return;
			done = true;
			cleanup();
			request.destroy();
			onDone();
		},
	});
	return new Response(body, { status, statusText: response.statusMessage, headers });
}
