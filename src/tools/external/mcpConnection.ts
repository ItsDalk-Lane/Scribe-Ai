import { AsyncLocalStorage } from 'node:async_hooks';
import { delimiter, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { extractWWWAuthenticateParams, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { SseError, SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createNodeFetch } from '../../communication/nodeFetch';
import type { ImageToolOutput } from '../../types';
import { decodeToolImage, MAX_IMAGES, MAX_REQUEST_IMAGE_BYTES } from '../support/imageData';
import { mcpArgumentSecretValues, restoreMcpArgumentSecrets } from './mcpArgumentSecrets';
import type { McpServerDraft } from './mcpConfig';
import { loginMcpOAuth, McpAuthRequiredError, oauthSecretValues, oauthTargetAllowed, oauthURLAllowed, savedOAuthProvider } from './mcpOAuth';
import type { McpOAuthChallenge, McpOAuthStorage } from './mcpOAuth';

export { McpAuthRequiredError };

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

interface Catalog {
	tools: McpToolInfo[];
	version?: string;
	resources: boolean;
}

interface CallResult extends ImageToolOutput {
	isError: boolean;
}

export interface McpConnection {
	start(): Promise<Catalog>;
	login(): Promise<Catalog>;
	listTools(signal?: AbortSignal): Promise<McpToolInfo[]>;
	callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallResult>;
	listResources(signal: AbortSignal): Promise<CallResult>;
	readResource(uri: string, signal: AbortSignal): Promise<CallResult>;
	redact(text: string): string;
	close(): Promise<void>;
}

interface ConnectionOptions {
	server: McpServerDraft;
	cwd: string;
	clientInfo: { name: string; version: string };
	signal: AbortSignal;
	oauth: McpOAuthStorage;
	openBrowser(this: void, url: string): void;
	onClose(this: void, error?: unknown): void;
	onToolsChanged(this: void): void;
}

type RequestScope = { signal: AbortSignal; timeout: number };

const networkFetch: typeof fetch = createNodeFetch(undefined, { timeouts: { firstByteMs: 0, streamIdleMs: 0 } });
const credentialName = /credential|token|secret|password|passphrase|cookie|authorization|api[-_]?key|access[-_]?key|private[-_]?key/i;

function fragments(values: Array<string | undefined>): string[] {
	const unique = new Set<string>();
	for (const value of values) if (value) {
		unique.add(value);
		unique.add(JSON.stringify(value).slice(1, -1));
		const encoded = new URLSearchParams({ value }).toString().slice(6);
		unique.add(encoded);
		unique.add(encoded.replaceAll('+', '%20'));
	}
	return [...unique].sort((a, b) => b.length - a.length);
}

function hideSecrets(text: string, sensitive: string[]): string {
	return sensitive.reduce((safe, secret) => safe.split(secret).join('[已隐藏]'), text);
}

async function whileActive<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => {
			const reason: unknown = signal.reason;
			reject(reason instanceof Error ? reason : new Error('MCP 操作已取消。'));
		};
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) abort();
	});
	try { return await Promise.race([promise, cancelled]); }
	finally { signal.removeEventListener('abort', abort); }
}

async function paginate<T>(request: (params: { cursor?: string }) => Promise<{ entries: T[]; nextCursor?: string }>, signal: AbortSignal): Promise<T[]> {
	const results: T[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	do {
		signal.throwIfAborted();
		const page = await request(cursor ? { cursor } : {});
		for (const item of page.entries) results.push(item);
		cursor = page.nextCursor;
		if (cursor && cursors.has(cursor)) throw new Error('服务器返回了重复的分页标记。');
		if (cursor) cursors.add(cursor);
	} while (cursor);
	return results;
}

function optionalResourceList<T>(promise: Promise<T[]>): Promise<T[]> {
	return promise.catch((error: unknown) => {
		if (error instanceof McpError && error.code === Number(ErrorCode.MethodNotFound)) return [];
		throw error;
	});
}

function rpcBody(body: RequestInit['body']): { id?: unknown; method?: unknown } | undefined {
	if (typeof body !== 'string' || !body.startsWith('{')) return;
	const candidate = JSON.parse(body) as { jsonrpc?: string; id?: unknown; method?: unknown };
	return candidate.jsonrpc === '2.0' ? candidate : undefined;
}

async function readMcpServiceError(response: Response): Promise<string | undefined> {
	if (response.status !== 200 || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) return;
	const body: unknown = await response.clone().json().catch(() => undefined);
	if (!body || typeof body !== 'object' || 'jsonrpc' in body || !('success' in body) || body.success !== false) return;
	const code = 'code' in body && typeof body.code === 'number' ? `（${body.code}）` : '';
	const message = 'msg' in body && typeof body.msg === 'string' ? body.msg
		: 'message' in body && typeof body.message === 'string' ? body.message : '';
	return `MCP 服务商拒绝了请求${code}${message ? `，${message}` : '。'}`;
}

function resourceContent(resource: { uri: string; mimeType?: string } & ({ text: string } | { blob: string })): string {
	return `${resource.uri}\n${'text' in resource ? resource.text : `二进制内容（${resource.mimeType ?? '未知格式'}）`}`;
}

function toolImages() {
	const images: NonNullable<ImageToolOutput['images']> = [];
	let remaining = MAX_REQUEST_IMAGE_BYTES * 4 / 3;
	return { images, add(data: string) {
		if (images.length >= MAX_IMAGES || data.length > remaining) return;
		try {
			const image = decodeToolImage(data);
			images.push(image);
			remaining -= image.data.length;
		} catch { /* Preserve the textual result when the media is invalid. */ }
	} };
}

function authFailure(error: unknown): boolean {
	return error instanceof McpAuthRequiredError || error instanceof UnauthorizedError
		|| ((error instanceof StreamableHTTPError || error instanceof SseError) && error.code === 401);
}

export function createMcpConnection(options: ConnectionOptions): McpConnection {
	const { server, cwd, clientInfo, oauth, openBrowser, onClose, onToolsChanged } = options;
	const controller = new AbortController();
	const lifetime = AbortSignal.any([options.signal, controller.signal]);
	const requests = new AsyncLocalStorage<AbortSignal>();
	const oauthSettings = { clientId: server.oauthClientId, clientSecret: server.secrets?.oauthClientSecret,
		scopes: server.oauthScopes, callbackPort: server.oauthCallbackPort };
	const startupMs = Math.max(1, Math.round((server.startupTimeout ?? 10) * 1_000));
	const operationMs = Math.max(1, Math.round((server.toolTimeout ?? 60) * 1_000));
	let client: Client | undefined;
	let live: Client | undefined;
	let pendingClose: Promise<void> | undefined;

	const envValues = (server.envVars ?? []).map((name) => [name, process.env[name]] as const);
	const envHeaders = Object.entries(server.envHeaders ?? {}).map(([header, name]) => [header, process.env[name]] as const);
	const bearer = (server.secrets?.bearerToken || (server.bearerTokenEnv ? process.env[server.bearerTokenEnv] : undefined))
		?.trim().replace(/^Bearer[\t ]+/i, '');
	const headers = new Headers(server.secrets?.headers);
	for (const [key, value] of envHeaders) if (value !== undefined) headers.set(key, value);
	if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
	const endpoint = server.secrets?.url ?? server.url;
	const authorization = headers.get('Authorization') ?? '';
	const credentialValues = [bearer, oauthSettings.clientSecret, server.secrets?.url,
		authorization.replace(/^\w+\s+/, ''), ...Object.values(server.secrets?.headers ?? {}),
		...mcpArgumentSecretValues(server.secrets?.args),
		...Object.entries(server.secrets?.env ?? {}).filter(([key]) => credentialName.test(key) || server.secretRefs?.env?.[key]).map(([, value]) => value),
		...envValues.filter(([key]) => credentialName.test(key)).map(([, value]) => value),
		...envHeaders.map(([, value]) => value)];
	if (endpoint) {
		const url = new URL(endpoint);
		url.searchParams.forEach((value, key) => {
			if (value && (server.secrets?.url || credentialName.test(key))) credentialValues.push(value);
		});
	}
	const usedOAuthSecrets = new Set(oauthSecretValues(oauth));
	const scopedOAuth: McpOAuthStorage = {
		read: () => oauth.read(),
		write: (value) => {
			oauth.write(value);
			for (const secret of oauthSecretValues(oauth)) usedOAuthSecrets.add(secret);
		},
	};
	const credentials = () => fragments([...credentialValues, ...usedOAuthSecrets]);
	const redact = (value: string): string => hideSecrets(value, credentials());
	const safeError = (error: unknown): Error => authFailure(error) ? new McpAuthRequiredError()
		: new Error(redact(error instanceof Error ? error.message : String(error)).slice(0, 2000));
	const scoped = async <T>(timeout: number, taskSignal: AbortSignal | undefined, run: (scope: RequestScope) => Promise<T>): Promise<T> => {
		const deadline = AbortSignal.timeout(timeout);
		const signal = AbortSignal.any(taskSignal ? [deadline, lifetime, taskSignal] : [deadline, lifetime]);
		signal.throwIfAborted();
		try { return await whileActive(requests.run(signal, () => run({ timeout: timeout + 100, signal })), signal); }
		catch (error) {
			if (deadline.aborted && !taskSignal?.aborted && !lifetime.aborted) throw new Error('等待 MCP 服务器响应超时。');
			throw safeError(error);
		}
	};

	function remoteTransport(url: URL, provider?: OAuthClientProvider, onChallenge?: (challenge: McpOAuthChallenge) => void) {
		if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('请输入有效的 HTTP 或 HTTPS 地址。');
		const fetchMcp: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const target = new URL(request.url);
			const message = rpcBody(init?.body);
			const accept = request.headers.get('Accept') ?? '';
			const mcpRequest = target.origin === url.origin && (Boolean(message) || accept.includes('text/event-stream') || request.method === 'DELETE');
			if (mcpRequest) headers.forEach((value, key) => {
				if (!onChallenge || key !== 'authorization') request.headers.set(key, value);
			});
			if (!mcpRequest && provider && !oauthTargetAllowed(url, target)) throw new Error('OAuth 请求地址必须使用安全连接。');
			const current = !mcpRequest || message?.id !== undefined ? requests.getStore() : undefined;
			const response = await networkFetch(request, { signal: AbortSignal.any(current
				? [current, lifetime, request.signal] : [lifetime, request.signal]) });
			if (mcpRequest && onChallenge && response.status === 401) onChallenge(extractWWWAuthenticateParams(response));
			if (mcpRequest && (message?.method === 'initialize' || message?.method === 'tools/list')) {
				const problem = await readMcpServiceError(response);
				if (problem) {
					await response.body?.cancel();
					throw new Error(redact(problem).replace(/\s+/g, ' ').trim());
				}
			}
			return response;
		};
		// 旧版 Scribe 已保存的 SSE 配置仍需使用同一连接方式。
		return server.type === 'sse' ? new SSEClientTransport(url, { fetch: fetchMcp, authProvider: provider })
			: new StreamableHTTPClientTransport(url, { fetch: fetchMcp, authProvider: provider });
	}

	function makeTransport(onChallenge?: (challenge: McpOAuthChallenge) => void) {
		if (server.type === 'stdio') {
			if (!server.command) throw new Error('请输入本地启动命令。');
			const env = getDefaultEnvironment();
			if (process.platform === 'darwin') env.PATH = [env.PATH || '/usr/bin:/bin', '/usr/local/bin', '/opt/homebrew/bin'].join(delimiter);
			for (const [key, value] of envValues) if (value !== undefined && !value.startsWith('()')) env[key] = value;
			return new StdioClientTransport({ command: server.command, args: restoreMcpArgumentSecrets(server.args, server.secrets?.args),
				cwd: server.cwd ? resolve(cwd, server.cwd) : cwd, env: { ...env, ...server.secrets?.env }, stderr: 'ignore' });
		}
		if (!endpoint) throw new Error('请输入服务器地址。');
		const url = new URL(endpoint);
		const provider = !onChallenge && !headers.has('Authorization') && oauthURLAllowed(url)
			? savedOAuthProvider(oauthSettings, scopedOAuth, lifetime) : undefined;
		return remoteTransport(url, provider, onChallenge);
	}

	async function catalog(candidate: Client, scope: RequestScope): Promise<McpToolInfo[]> {
		if (!candidate.getServerCapabilities()?.tools) return [];
		const listed = await paginate(async (params) => {
			const { tools, nextCursor } = await candidate.listTools(params, scope);
			return { entries: tools, nextCursor };
		}, scope.signal);
		const sensitive = credentials();
		const names = new Set<string>();
		return listed.flatMap(({ name, description, inputSchema, annotations }): McpToolInfo[] => {
			if (names.has(name)) throw new Error('MCP 服务器返回了重复的工具名称。');
			names.add(name);
			const schema = JSON.stringify(inputSchema);
			if (sensitive.some((value) => name.includes(value) || schema.includes(value))) return [];
			return [{ name, inputSchema, description: description && hideSecrets(description, sensitive),
				annotations: annotations && { ...annotations, title: annotations.title && hideSecrets(annotations.title, sensitive) } }];
		});
	}

	async function connect(onChallenge?: (challenge: McpOAuthChallenge) => void): Promise<Catalog> {
		lifetime.throwIfAborted();
		const candidate = new Client(clientInfo, { capabilities: {} });
		let lastError: Error | undefined;
		client = candidate;
		candidate.onclose = () => {
			if (client !== candidate) return;
			client = undefined;
			if (live === candidate) {
				live = undefined;
				onClose(lastError ?? new Error('MCP 连接已中断。'));
			}
		};
		candidate.onerror = (error) => {
			lastError = safeError(error);
			if (error instanceof SseError && live === candidate) void candidate.close().catch(() => {});
		};
		candidate.setNotificationHandler(ToolListChangedNotificationSchema, () => {
			if (live === candidate) onToolsChanged();
		});
		try {
			const transport = makeTransport(onChallenge);
			const tools = await scoped(startupMs, undefined, async (scope) => {
				await candidate.connect(transport, scope);
				return onChallenge ? [] : catalog(candidate, scope);
			});
			lifetime.throwIfAborted();
			if (client !== candidate) throw lastError ?? new Error('MCP 连接已中断。');
			if (!onChallenge) live = candidate;
			const version = candidate.getServerVersion()?.version;
			return { tools, version: version && redact(version), resources: Boolean(candidate.getServerCapabilities()?.resources) };
		} catch (error) {
			if (client === candidate) client = undefined;
			await candidate.close().catch(() => {});
			throw safeError(error);
		}
	}

	function ready(): Client {
		if (!live || lifetime.aborted) throw new Error('MCP 服务器尚未连接。');
		return live;
	}

	const disconnect = async () => {
		const current = client;
		client = live = undefined;
		await current?.close().catch(() => {});
	};
	const close = () => {
		if (pendingClose) return pendingClose;
		lifetime.removeEventListener('abort', stop);
		controller.abort();
		pendingClose = disconnect();
		return pendingClose;
	};
	const stop = () => { void close(); };
	lifetime.addEventListener('abort', stop, { once: true });

	return {
		start: () => connect(),
		async login() {
			if (server.type === 'stdio' || !endpoint) throw new Error('此服务器无法使用浏览器登录。');
			const serverUrl = new URL(endpoint);
			if (!oauthURLAllowed(serverUrl) || headers.has('Authorization')) throw new Error('浏览器登录需要安全的连接地址，且不能同时使用访问令牌。');
			let challenge: McpOAuthChallenge | undefined;
			try { await connect((value) => { challenge = value; }); }
			catch (error) { if (!authFailure(error)) throw error; }
			finally { await disconnect(); }
			try { await loginMcpOAuth({ serverUrl, settings: oauthSettings, store: scopedOAuth, challenge, openBrowser, fetch: networkFetch, signal: lifetime }); }
			catch (error) {
				lifetime.throwIfAborted();
				throw new Error(error instanceof McpAuthRequiredError ? error.message : 'MCP 登录未完成，请检查服务器的登录设置后重试。');
			}
			return connect();
		},
		listTools: (signal) => scoped(startupMs, signal, (scope) => catalog(ready(), scope)),
		callTool: (name, args, signal) => scoped(operationMs, signal, async (scope) => {
			const { content, structuredContent, isError } = await ready().callTool({ name, arguments: args }, undefined, scope) as CallToolResult;
			const media = toolImages();
			const text = content.map((item) => {
				switch (item.type) {
					case 'text': return item.text;
					case 'resource':
						if ('blob' in item.resource && item.resource.mimeType?.startsWith('image/')) media.add(item.resource.blob);
						return resourceContent(item.resource);
					case 'resource_link': return JSON.stringify({ uri: item.uri, name: item.name, description: item.description, mimeType: item.mimeType });
					case 'image':
						media.add(item.data);
						return `图片（${item.mimeType}）`;
					case 'audio': return `音频（${item.mimeType}）`;
				}
			});
			if (structuredContent) {
				const output = JSON.stringify(structuredContent);
				if (!text.includes(output)) text.push(output);
			}
			return { content: redact(text.join('\n\n')), isError: isError === true, ...(media.images.length && { images: media.images }) };
		}),
		listResources: (signal) => scoped(operationMs, signal, async (scope) => {
			const current = ready();
			const [resources, templates] = await Promise.all([
				optionalResourceList(paginate(async (params) => {
					const result = await current.listResources(params, scope);
					return { entries: result.resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })), nextCursor: result.nextCursor };
				}, scope.signal)),
				optionalResourceList(paginate(async (params) => {
					const result = await current.listResourceTemplates(params, scope);
					return { entries: result.resourceTemplates.map(({ uriTemplate, name, description, mimeType }) => ({ uriTemplate, name, description, mimeType })), nextCursor: result.nextCursor };
				}, scope.signal)),
			]);
			return { content: redact(JSON.stringify({ resources, templates })), isError: false };
		}),
		readResource: (uri, signal) => scoped(operationMs, signal, async (scope) => {
			const result = await ready().readResource({ uri }, scope);
			const media = toolImages();
			for (const item of result.contents) {
				if ('blob' in item && item.mimeType?.startsWith('image/')) media.add(item.blob);
			}
			return { content: redact(result.contents.map(resourceContent).join('\n\n')), isError: false,
				...(media.images.length && { images: media.images }) };
		}),
		redact,
		close,
	};
}
