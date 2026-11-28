import { auth, extractWWWAuthenticateParams, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { EventSource } from 'eventsource';

// Servers using the legacy HTTP+SSE protocol send a separate POST endpoint over the event stream.
export class LegacyMcpStream implements Transport {
	onclose?: Transport['onclose'];
	onerror?: Transport['onerror'];
	onmessage?: Transport['onmessage'];
	private stream?: EventSource;
	private endpoint?: URL;
	private protocolVersion?: string;
	private readonly closed = new AbortController();

	constructor(
		private readonly url: URL,
		private readonly fetch: FetchLike,
		private readonly provider?: OAuthClientProvider,
	) {}

	setProtocolVersion(version: string): void {
		this.protocolVersion = version;
	}

	private async fetchWithAuth(url: URL, init: RequestInit): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.protocolVersion) headers.set('mcp-protocol-version', this.protocolVersion);
		const signal = init.signal ? AbortSignal.any([this.closed.signal, init.signal]) : this.closed.signal;
		const request = async () => {
			const token = (await this.provider?.tokens())?.access_token;
			if (token) headers.set('authorization', `Bearer ${token}`);
			return this.fetch(url, { ...init, headers, signal });
		};
		const response = await request();
		if (response.status !== 401) return response;
		const challenge = extractWWWAuthenticateParams(response);
		await response.body?.cancel();
		if (!this.provider || await auth(this.provider, {
			serverUrl: this.url, resourceMetadataUrl: challenge.resourceMetadataUrl,
			scope: challenge.scope, fetchFn: (target, options) => this.fetch(target, { ...options, signal }),
		}) !== 'AUTHORIZED') throw new UnauthorizedError();
		const retry = await request();
		if (retry.status !== 401) return retry;
		await retry.body?.cancel();
		throw new UnauthorizedError();
	}

	async start(): Promise<void> {
		this.closed.signal.throwIfAborted();
		if (this.stream) throw new Error('MCP event stream is already open.');
		await new Promise<void>((resolve, reject) => {
			let fetchError: Error | undefined;
			const stream = new EventSource(this.url, { fetch: async (_url, init) => {
				try { return await this.fetchWithAuth(this.url, init); }
				catch (error) {
					if (error instanceof Error) fetchError = error;
					throw error;
				}
			} });
			this.stream = stream;
			const onClosed = () => reject(new Error('MCP event stream closed.'));
			this.closed.signal.addEventListener('abort', onClosed, { once: true });
			const disconnected = (error: Error) => {
				this.closed.signal.removeEventListener('abort', onClosed);
				reject(error);
				this.onerror?.(error);
				// Close after EventSource finishes its error dispatch so it also clears any reconnect timer.
				queueMicrotask(() => void this.close());
			};
			stream.addEventListener('endpoint', (event) => {
				try {
					if (typeof event.data !== 'string' || !event.data.trim()) throw new Error('Missing MCP message endpoint.');
					const target = new URL(event.data, this.url);
					if (target.origin !== this.url.origin || target.username || target.password) {
						throw new Error('MCP message endpoint must share the origin of the event stream.');
					}
					this.endpoint = target;
					this.closed.signal.removeEventListener('abort', onClosed);
					resolve();
				} catch (error) { disconnected(error instanceof Error ? error : new Error(String(error))); }
			}, { once: true });
			stream.onmessage = (event) => {
				try { this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(String(event.data)))); }
				catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); }
			};
			stream.onerror = (event) => disconnected(fetchError ?? new Error(event.message || 'MCP event stream disconnected.'));
		});
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.endpoint) throw new Error('MCP message endpoint is unavailable.');
		const response = await this.fetchWithAuth(this.endpoint, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
		});
		if (!response.ok) throw new Error(`MCP message request failed (${response.status}): ${await response.text()}`);
		await response.body?.cancel();
	}

	async close(): Promise<void> {
		if (this.closed.signal.aborted) return;
		this.closed.abort();
		this.stream?.close();
		this.endpoint = undefined;
		this.onclose?.();
	}
}
