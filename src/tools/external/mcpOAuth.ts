import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientInformationSchema, OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const callbackPath = '/mcp/callback';
const callbackHost = '127.0.0.1';

export class McpAuthRequiredError extends Error {
	constructor() { super('此 MCP 服务器需要登录或有效的访问凭据。'); }
}

export interface McpOAuthStorage {
	read(): string | undefined;
	write(value: string): void;
}

interface OAuthSettings {
	clientId?: string;
	clientSecret?: string;
	scopes?: string[];
	callbackPort?: number;
}

interface OAuthCredentials {
	redirectUrl: string;
	client?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
}

export interface McpOAuthChallenge {
	resourceMetadataUrl?: URL;
	scope?: string;
}

function readCredentials(store: McpOAuthStorage): OAuthCredentials | undefined {
	const value = store.read();
	if (!value) return;
	try {
		const { redirectUrl, client, tokens } = JSON.parse(value) as Record<string, unknown>;
		const callback = typeof redirectUrl === 'string' ? new URL(redirectUrl) : undefined;
		if (!callback || callback.hostname !== callbackHost || callback.protocol !== 'http:' || callback.pathname !== callbackPath) return;
		const parsed = OAuthTokensSchema.safeParse(tokens);
		return {
			redirectUrl: callback.href,
			client: OAuthClientInformationSchema.safeParse(client).data,
			tokens: parsed.data?.issuer ? parsed.data : undefined,
		};
	} catch { return; }
}

export function oauthSecretValues(store: McpOAuthStorage): Array<string | undefined> {
	const saved = readCredentials(store);
	return [saved?.client?.client_secret, saved?.tokens?.access_token, saved?.tokens?.refresh_token, saved?.tokens?.id_token];
}

export function oauthURLAllowed(url: URL): boolean {
	return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:'
		&& [callbackHost, 'localhost', '[::1]'].includes(url.hostname)));
}

export function oauthTargetAllowed(serverUrl: URL, target: URL): boolean {
	return oauthURLAllowed(target) && (serverUrl.protocol !== 'https:' || target.protocol === 'https:');
}

function makeProvider(settings: OAuthSettings, options: {
	redirectUrl: string;
	read(): OAuthCredentials;
	write(value: OAuthCredentials): void;
	state?: string;
	open?(url: URL): void;
}): OAuthClientProvider {
	let verifier: string | undefined;
	let discovery: OAuthDiscoveryState | undefined;
	const configured = settings.clientId ? { client_id: settings.clientId, client_secret: settings.clientSecret } : undefined;
	return {
		redirectUrl: options.redirectUrl,
		clientMetadata: {
			client_name: 'Scribe Ai', redirect_uris: [options.redirectUrl], response_types: ['code'],
			grant_types: ['authorization_code', 'refresh_token'], scope: settings.scopes?.join(' '),
			token_endpoint_auth_method: configured?.client_secret ? 'client_secret_post' : 'none',
		},
		state: () => options.state ?? randomBytes(32).toString('base64url'),
		clientInformation: () => options.read().client ?? configured,
		saveClientInformation(client) {
			// 固定客户端资料只能绑定到首次授权的发行方。
			if (configured && client.client_id !== configured.client_id) throw new McpAuthRequiredError();
			options.write({ ...options.read(), client });
		},
		tokens: () => options.read().tokens,
		saveTokens: (tokens) => options.write({ ...options.read(), tokens }),
		redirectToAuthorization(url) {
			if (!options.open) throw new McpAuthRequiredError();
			if (!oauthURLAllowed(url)) throw new Error('登录地址必须使用安全连接。');
			options.open(url);
		},
		saveCodeVerifier: (codeVerifier) => { verifier = codeVerifier; },
		codeVerifier: () => {
			if (!verifier) throw new Error('登录验证已失效。');
			return verifier;
		},
		saveDiscoveryState: (value) => { discovery = value; },
		discoveryState: () => discovery,
	};
}

export function savedOAuthProvider(settings: OAuthSettings, store: McpOAuthStorage, signal: AbortSignal): OAuthClientProvider | undefined {
	const saved = readCredentials(store);
	if (!saved?.tokens) return;
	return makeProvider(settings, {
		redirectUrl: saved.redirectUrl,
		read: () => readCredentials(store) ?? { redirectUrl: saved.redirectUrl },
		write: (value) => {
			signal.throwIfAborted();
			store.write(JSON.stringify(value));
		},
	});
}

async function callbackListener(port: number, expectedState: string, expectedIssuer: () => { issuer?: string; required: boolean }, signal: AbortSignal) {
	let host = '';
	let received = false;
	let resolveCode!: (code: string) => void;
	let rejectCode!: (reason: unknown) => void;
	const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
	void code.catch(() => {});
	const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => {
		response.setHeader('Content-Type', 'text/plain; charset=utf-8');
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('Connection', 'close');
		const url = new URL(request.url?.startsWith('/') && !request.url.startsWith('//') ? request.url : '/', `http://${host}`);
		if (request.method !== 'GET' || request.headers.host !== host || url.pathname !== callbackPath || received) {
			response.writeHead(404).end();
			return;
		}
		const value = (key: string) => url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : undefined;
		const { issuer, required } = expectedIssuer();
		const actualIssuer = value('iss');
		if (value('state') !== expectedState || (url.searchParams.has('iss') ? !actualIssuer || actualIssuer !== issuer : required)) {
			response.writeHead(400).end('无法验证登录回调。');
			return;
		}
		received = true;
		const authorizationCode = value('code');
		if (!authorizationCode || url.searchParams.has('error')) {
			response.writeHead(400).end('登录未完成。', () => rejectCode(new Error('登录未获授权。')));
			return;
		}
		response.end('已收到登录结果，可以返回 Obsidian。', () => resolveCode(authorizationCode));
	});
	const onAbort = () => {
		const reason: unknown = signal.reason;
		rejectCode(reason instanceof Error ? reason : new Error('登录已取消。'));
	};
	signal.addEventListener('abort', onAbort, { once: true });
	const close = () => {
		signal.removeEventListener('abort', onAbort);
		server.close();
		server.closeAllConnections();
	};
	try {
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.once('close', () => reject(new Error('本机登录回调已关闭。')));
			server.listen({ host: callbackHost, port, signal }, resolve);
		});
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('无法打开本机登录回调。');
		host = `${callbackHost}:${address.port}`;
		return { code, redirectUrl: `http://${host}${callbackPath}`, close };
	} catch (error) {
		close();
		throw error;
	}
}

export async function loginMcpOAuth(options: {
	serverUrl: URL;
	settings: OAuthSettings;
	store: McpOAuthStorage;
	challenge?: McpOAuthChallenge;
	openBrowser(this: void, url: string): void;
	fetch: typeof fetch;
	signal: AbortSignal;
}): Promise<void> {
	const { serverUrl, settings, store, challenge, openBrowser, fetch, signal } = options;
	if (!oauthURLAllowed(serverUrl)) throw new Error('MCP 登录需要 HTTPS，或使用本机地址。');
	const state = randomBytes(32).toString('base64url');
	const loginSignal = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
	let provider: OAuthClientProvider | undefined;
	const callback = await callbackListener(settings.callbackPort ?? 0, state, () => {
		const discovery = provider?.discoveryState?.() as OAuthDiscoveryState | undefined;
		const metadata = discovery?.authorizationServerMetadata;
		return { issuer: metadata?.issuer ?? discovery?.authorizationServerUrl,
			required: Boolean(metadata && 'authorization_response_iss_parameter_supported' in metadata && metadata.authorization_response_iss_parameter_supported === true) };
	}, loginSignal);
	try {
		const previous = readCredentials(store);
		let credentials: OAuthCredentials = { redirectUrl: callback.redirectUrl };
		if (previous && (settings.clientId || previous.redirectUrl === callback.redirectUrl)) credentials.client = previous.client;
		provider = makeProvider(settings, {
			redirectUrl: callback.redirectUrl, state, read: () => credentials, write: (value) => { credentials = value; },
			open: (url) => {
				loginSignal.throwIfAborted();
				if (!oauthTargetAllowed(serverUrl, url)) throw new Error('登录地址必须使用安全连接。');
				openBrowser(url.href);
			},
		});
		const request = {
			serverUrl, ...challenge, scope: settings.scopes?.join(' ') || challenge?.scope,
			fetchFn: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const req = new Request(input, init);
				if (!oauthTargetAllowed(serverUrl, new URL(req.url))) throw new Error('OAuth 请求地址必须使用安全连接。');
				return fetch(req, { signal: AbortSignal.any([req.signal, loginSignal]) });
			},
		};
		if (await auth(provider, request) === 'REDIRECT') {
			await auth(provider, { ...request, authorizationCode: await callback.code });
		}
		loginSignal.throwIfAborted();
		if (!credentials.tokens) throw new McpAuthRequiredError();
		store.write(JSON.stringify(credentials));
	} finally { callback.close(); }
}
