import type { Agent, ClientRequest, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { diagnostics } from './diagnostics';
import { toLogEntry } from './events';
import type { NodeFetchObserver } from './events';
import { confirmModelRequest } from './modelRequestConfirmation';
import type { ModelRequestConfirmation } from './modelRequestConfirmation';
import { nodeRequire } from './nodeRequire';
import { bridgeResponse } from './nodeResponse';
import { getProxyAgentWithStatus } from './proxy';
import type { ProxyAgentResolver, ProxySource } from './proxy';
import { DEFAULT_TIMEOUTS, timeoutError } from './timeouts';
import type { NetworkTimeouts } from './timeouts';

interface NodeFetchOptions {
	timeouts?: Partial<NetworkTimeouts>;
	observer?: NodeFetchObserver;
	lookup?: LookupFunction;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Aborted'));
}

export function createNodeFetch(
	getAgent: ProxyAgentResolver = getProxyAgentWithStatus,
	options: NodeFetchOptions = {},
) {
	const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
	let nextRequestId = 0;

	return async (input: Parameters<typeof fetch>[0], init?: RequestInit, confirm?: (url: URL) => Promise<void>) => {
		const request = new Request(input, init);
		request.signal.throwIfAborted();
		const initialUrl = new URL(request.url);
		if (!['http:', 'https:'].includes(initialUrl.protocol)) {
			throw new TypeError(`Unsupported URL protocol: ${initialUrl.protocol}`);
		}
		const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
		const initialHeaders: Record<string, string> = {};
		request.headers.forEach((value, key) => { initialHeaders[key] = value; });
		const requestId = `scribe-${Date.now()}-${++nextRequestId}`;
		const emit = options.observer ?? (() => {});
		const origin = initialUrl.origin;
		const path = initialUrl.pathname;

		const send = async (
			url: URL,
			method: string,
			headers: Record<string, string>,
			requestBody: Buffer | undefined,
			redirects: number,
		): Promise<Response> => {
			request.signal.throwIfAborted();
			await confirm?.(url);
			request.signal.throwIfAborted();
			const resolution = await getAgent(url);
			let agent: Agent | undefined;
			let proxySource: ProxySource = 'direct';
			if (resolution && 'source' in resolution) {
				agent = resolution.agent;
				proxySource = resolution.source;
			} else {
				agent = resolution;
				if (agent) proxySource = 'configured';
			}
			request.signal.throwIfAborted();
			const http = nodeRequire('node:http') as typeof import('node:http');
			const https = nodeRequire('node:https') as typeof import('node:https');
			const requestHeaders: Record<string, string> = { ...headers, 'accept-encoding': 'gzip, deflate, br' };
			if (requestBody) requestHeaders['content-length'] = String(requestBody.byteLength);

			return new Promise<Response>((resolve, reject) => {
				emit({ requestId, method, origin, path, phase: 'connecting', proxy: proxySource, at: Date.now() });
				const req: ClientRequest = (url.protocol === 'https:' ? https : http).request(url, {
					method,
					headers: requestHeaders,
					agent,
					...(options.lookup && !agent && { lookup: options.lookup, agent: false }),
				});
				let timer: ReturnType<typeof setTimeout> | undefined;
				let activeResponse: IncomingMessage | undefined;
				let responded = false;
				const clearTimer = () => {
					if (timer) globalThis.clearTimeout(timer);
					timer = undefined;
				};
				const arm = (kind: 'connect' | 'first-byte' | 'stream-idle', ms: number) => {
					clearTimer();
					if (ms <= 0) return;
					timer = globalThis.setTimeout(() => req.destroy(timeoutError(kind, ms)), ms);
				};
				const onAbort = () => {
					const reason = abortReason(request.signal);
					activeResponse?.destroy(reason);
					req.destroy(reason);
				};
				const cleanup = () => {
					clearTimer();
					request.signal.removeEventListener('abort', onAbort);
				};
				const fail = (error: unknown) => {
					cleanup();
					emit({
						requestId, method, origin, path, phase: 'error', proxy: proxySource, at: Date.now(),
						error: error instanceof Error ? error.message : String(error),
					});
					if (!responded) {
						const reason = request.signal.aborted
							? abortReason(request.signal)
							: error instanceof Error ? error : new Error(String(error));
						reject(reason);
					}
				};

				request.signal.addEventListener('abort', onAbort, { once: true });
				arm('connect', timeouts.connectMs);
				req.on('socket', (socket) => {
					if (!socket.connecting) {
						arm('first-byte', timeouts.firstByteMs);
						return;
					}
					const connected = url.protocol === 'https:' ? 'secureConnect' : 'connect';
					socket.once(connected, () => arm('first-byte', timeouts.firstByteMs));
				});
				req.on('error', (error) => {
					activeResponse?.destroy(error);
					fail(error);
				});
				req.on('response', (response) => {
					activeResponse = response;
					const status = response.statusCode ?? 500;
					const location = response.headers.location;
					const redirect = [301, 302, 303, 307, 308].includes(status) && location;
					if (redirect && request.redirect !== 'manual') {
						response.resume();
						cleanup();
						if (request.redirect === 'error') {
							fail(new Error('Redirect rejected by request settings.'));
							return;
						}
						if (redirects >= 20) {
							fail(new Error('Too many redirects'));
							return;
						}
						let nextUrl: URL;
						try {
							nextUrl = new URL(location, url);
						} catch {
							fail(new TypeError('Invalid redirect URL.'));
							return;
						}
						// 认证信息可能在任意请求头里，保留方法的转址也会重发正文。
						if (nextUrl.protocol !== initialUrl.protocol || nextUrl.origin !== origin) {
							fail(new Error('Cross-origin redirect blocked. Configure the final service URL directly.'));
							return;
						}
						const nextMethod = status === 303 || ((status === 301 || status === 302) && method === 'POST')
							? 'GET'
							: method;
						const nextHeaders = { ...headers };
						if (nextMethod === 'GET') {
							delete nextHeaders['content-length'];
							delete nextHeaders['content-type'];
						}
						void send(nextUrl, nextMethod, nextHeaders, nextMethod === 'GET' ? undefined : requestBody, redirects + 1).then(resolve, reject);
						return;
					}
					if (status === 101) {
						response.resume();
						fail(new Error('HTTP upgrade responses are not supported by fetch'));
						return;
					}

					responded = true;
					emit({ requestId, method, origin, path, phase: 'streaming', proxy: proxySource, at: Date.now(), status });
					arm('stream-idle', timeouts.streamIdleMs);
					const result = bridgeResponse(response, {
						request: req,
						signal: request.signal,
						cleanup,
						onData: () => arm('stream-idle', timeouts.streamIdleMs),
						onDone: () => emit({ requestId, method, origin, path, phase: 'done', proxy: proxySource, at: Date.now(), status }),
						onError: fail,
					});
					resolve(result);
				});
				req.end(requestBody);
			});
		};

		return send(initialUrl, request.method, initialHeaders, body, 0);
	};
}

const fetchWithOptionalConfirmation = createNodeFetch(getProxyAgentWithStatus, {
	observer: (event) => diagnostics.record(toLogEntry(event)),
});

export const nodeFetch: typeof fetch = fetchWithOptionalConfirmation;
export const modelNodeFetch = (input: Parameters<typeof fetch>[0], init: RequestInit | undefined, confirmation: ModelRequestConfirmation) =>
	fetchWithOptionalConfirmation(input, init, (url) => confirmModelRequest(url, confirmation));
