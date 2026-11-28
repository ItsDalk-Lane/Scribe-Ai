import { createHash, randomUUID } from 'node:crypto';
import { isSecureServiceUrl } from '../../communication/serviceAddress';
import { extractMcpArgumentSecrets, restoreMcpArgumentSecrets, validateMcpArgumentRefs } from './mcpArgumentSecrets';
import { createMcpConnection, McpAuthRequiredError } from './mcpConnection';
import type { McpConnection, McpToolInfo } from './mcpConnection';
import { validateMcpDraft } from './mcpConfig';
import type { McpSecrets, McpServer, McpServerDraft, McpSettings } from './mcpConfig';
import { mergeMcpSecrets, MissingMcpSecretError, readMcpSecrets, storeMcpSecrets, usesMcpSecret } from './mcpSecrets';
import type { McpSecretStorage } from './mcpSecrets';

type Catalog = Awaited<ReturnType<McpConnection['start']>>;
export type McpServerState = 'disabled' | 'connecting' | 'ready' | 'auth' | 'error';

export interface McpServerView {
	server: McpServer;
	state: McpServerState;
	version?: string;
	error?: string;
	signedIn?: boolean;
	prompts?: boolean;
	tools: (McpToolInfo & { enabled: boolean })[];
}

interface ConnectionEntry {
	key: string;
	generation: string;
	controller: AbortController;
	connection?: McpConnection;
	state: McpServerState;
	catalog?: Catalog;
	pending?: Promise<void>;
	error?: string;
	refreshing?: Promise<void>;
	refreshAgain?: boolean;
}

interface ManagerOptions {
	settings(this: void): McpSettings;
	commit(settings: McpSettings): Promise<void>;
	storage: McpSecretStorage;
	cwd: string;
	clientInfo: { name: string; version: string };
	openBrowser(this: void, url: string): void;
	connect?: typeof createMcpConnection;
}

export function mcpDigest(data: unknown) {
	return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function connectionKey({ type, command, args, cwd, url, envVars, envHeaders, bearerTokenEnv, oauthClientId,
	oauthScopes, oauthCallbackPort, startupTimeout, toolTimeout, secretKey, secretRefs }: McpServer): string {
	return mcpDigest([type, command, args, cwd, url, envVars, envHeaders, bearerTokenEnv, oauthClientId,
		oauthScopes, oauthCallbackPort, startupTimeout, toolTimeout, secretKey, secretRefs]);
}

function oauthKey(server: McpServer): string {
	const refs = server.secretRefs;
	return 'scribe-ai-mcp-login-' + mcpDigest([server.id, server.type, server.url, server.oauthClientId,
		server.oauthScopes, server.oauthCallbackPort, server.secretKey, ...(refs ? [refs] : [])]).slice(0, 32);
}

function toolEnabled(server: McpServer, name: string): boolean {
	return (!server.enabledTools || server.enabledTools.includes(name)) && !server.disabledTools?.includes(name);
}

function toolSignature(entry: ConnectionEntry, tool: McpToolInfo): string {
	return mcpDigest([entry.key, tool.name, tool.description, tool.inputSchema, tool.annotations]);
}

async function waitForConnections(entries: readonly ConnectionEntry[], signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const pending = entries.flatMap(({ state, pending }) => state === 'connecting' && pending ? [pending] : []);
	if (!pending.length) return;
	let stop = () => {};
	try {
		const aborted = new Promise<never>((_, reject) => {
			stop = () => {
				const reason: unknown = signal.reason;
				reject(reason instanceof Error ? reason : new Error('MCP 操作已取消。'));
			};
			signal.addEventListener('abort', stop, { once: true });
		});
		await Promise.race([Promise.all(pending), aborted]);
	} finally {
		signal.removeEventListener('abort', stop);
	}
}

export interface McpLiveServer {
	server: McpServer;
	connectionKey: string;
	generation: string;
	connection: McpConnection;
	signal: AbortSignal;
	resources: boolean;
	instructions?: string;
	tools: { tool: McpToolInfo; signature: string }[];
	verify(signature?: string, toolName?: string): void;
}

export function createMcpManager(options: ManagerOptions) {
	const entries = new Map<string, ConnectionEntry>();
	const listeners = new Set<() => void>();
	let queue = Promise.resolve();
	let disposed = false;

	const settings = options.settings;
	const lookup = (id: string) => settings().servers.find((server) => server.id === id);
	const connect = options.connect ?? createMcpConnection;
	const notify = () => listeners.forEach((listener) => listener());
	const erase = (key: string | undefined) => { if (key) options.storage.setSecret(key, ''); };
	const secretInUse = (key: string) => settings().servers.some((server) => server.secretKey === key || usesMcpSecret(server.secretRefs, key));
	const draft = (id: string): McpServerDraft | undefined => {
		const server = lookup(id);
		if (!server) return;
		const raw = server.secretKey && options.storage.getSecret(server.secretKey);
		const secrets = raw ? JSON.parse(raw) as McpSecrets : undefined;
		return { ...server, url: secrets?.url ?? server.url, secrets };
	};

	function connectionDraft(id: string): McpServerDraft {
		const server = draft(id);
		if (!server) throw new Error('MCP 服务器已移除。');
		if (server.secretKey && !server.secrets) throw new MissingMcpSecretError();
		if (!server.secretRefs) return server;
		const secrets = mergeMcpSecrets(server.secrets, readMcpSecrets(options.storage, server.secretRefs));
		const validated = validateMcpDraft({ ...server, secrets });
		return { ...validated, secrets: { ...validated.secrets, args: secrets.args } };
	}

	// The vault's secret store is local to this Obsidian profile.
	const localGrantKey = (id: string) => 'scribe-ai-mcp-local-grant-' + mcpDigest([options.cwd, id]);
	const localGrant = (server: McpServerDraft) => mcpDigest([server.command, server.cwd,
		restoreMcpArgumentSecrets(server.args, server.secrets?.args), server.envVars, server.secretRefs, server.secrets?.env]);
	function localApproved(server: McpServer): boolean {
		if (server.type !== 'stdio') return true;
		try { return options.storage.getSecret(localGrantKey(server.id)) === localGrant(connectionDraft(server.id)); }
		catch { return false; }
	}

	function release(id: string) {
		const entry = entries.get(id);
		if (!entry) return;
		entries.delete(id);
		entry.controller.abort();
		void entry.connection?.close().catch(() => {});
	}

	function fail(entry: ConnectionEntry, error: unknown) {
		entry.state = error instanceof McpAuthRequiredError ? 'auth' : 'error';
		const message = error instanceof Error ? error.message : 'MCP 连接已关闭。';
		entry.error = entry.connection?.redact(message)
			?? (error instanceof MissingMcpSecretError ? error.message : '无法读取 MCP 连接配置。');
		entry.catalog = undefined;
		void entry.connection?.close().catch(() => {});
	}

	function start(server: McpServer, login = false): ConnectionEntry {
		const id = server.id;
		release(id);
		const controller = new AbortController();
		const entry: ConnectionEntry = { key: connectionKey(server), generation: randomUUID(), controller, state: 'connecting' };
		entries.set(id, entry);
		const current = () => entries.get(id) === entry && !controller.signal.aborted;
		const refresh = () => {
			if (!current() || !entry.catalog || !entry.connection) return;
			if (entry.refreshing) { entry.refreshAgain = true; return; }
			const connection = entry.connection;
			entry.refreshing = (async () => {
				do {
					entry.refreshAgain = false;
					const tools = await connection.listTools(controller.signal);
					if (!current() || !entry.catalog) return;
					entry.catalog = { ...entry.catalog, tools };
					notify();
				} while (entry.refreshAgain);
			})().catch((error: unknown) => {
				if (current()) { fail(entry, error); notify(); }
			}).finally(() => { entry.refreshing = undefined; });
		};
		const key = oauthKey(server);
		entry.pending = Promise.resolve().then(async () => {
			if (!current()) return;
			const draft = connectionDraft(id);
			if (draft.type === 'stdio' && options.storage.getSecret(localGrantKey(id)) !== localGrant(draft)) {
				entry.state = 'error';
				entry.error = '请在设置中核对命令，并在此设备启用这项本地服务。';
				return;
			}
			const connection = connect({
				server: draft, cwd: options.cwd, clientInfo: options.clientInfo, signal: controller.signal,
				oauth: {
					read: () => current() ? options.storage.getSecret(key) ?? undefined : undefined,
					write: (value) => { if (current()) options.storage.setSecret(key, value); },
				},
				openBrowser: options.openBrowser,
				onClose: (error) => {
					if (current() && (entry.state === 'connecting' || entry.state === 'ready')) { fail(entry, error); notify(); }
				},
				onToolsChanged: refresh,
			});
			entry.connection = connection;
			const catalog = await (login ? connection.login() : connection.start());
			if (!current() || entry.state !== 'connecting') return;
			entry.catalog = catalog;
			entry.state = 'ready';
		}).catch((error: unknown) => {
			if (current()) fail(entry, error);
		}).finally(() => { if (current()) notify(); });
		notify();
		return entry;
	}

	function reconcile() {
		if (disposed) return;
		for (const id of entries.keys()) {
			const server = lookup(id);
			if (!server?.enabled || connectionKey(server) !== entries.get(id)?.key) release(id);
		}
		for (const server of settings().servers) {
			if (server.enabled && !entries.has(server.id)) start(server);
		}
		notify();
	}

	function serialize(work: () => void | Promise<void>): Promise<void> {
		const action = queue.then(() => {
			if (disposed) throw new Error('MCP 已关闭。');
			return work();
		});
		queue = action.catch(() => {});
		return action;
	}

	async function commit(next: McpSettings, reconnectId?: string) {
		const old = settings().servers;
		await options.commit(next);
		if (reconnectId) release(reconnectId);
		reconcile();
		for (const server of old) {
			const updated = lookup(server.id);
			if (server.type === 'stdio' && server.enabled && (!updated?.enabled || updated.type !== 'stdio')) {
				const key = localGrantKey(server.id);
				if (options.storage.getSecret(key)) erase(key);
			}
			if (server.secretKey && server.secretKey !== updated?.secretKey && !secretInUse(server.secretKey)) erase(server.secretKey);
			if (!updated || oauthKey(server) !== oauthKey(updated)) erase(oauthKey(server));
		}
	}

	function update(id: string, edit: (server: McpServer) => McpServer): Promise<void> {
		return serialize(async () => {
			if (!lookup(id)) throw new Error('MCP 服务器已移除。');
			await commit({ ...settings(), servers: settings().servers.map((server) => server.id === id ? edit(server) : server) });
		});
	}

	function saveMany(drafts: McpServerDraft[], importing: boolean, reconnectId?: string): Promise<void> {
		return serialize(async () => {
			const servers = [...settings().servers];
			const staged = new Set<string>();
			try {
				for (const raw of drafts) {
					const { secrets, secretRefs: selected, ...value } = validateMcpDraft(raw);
					const old = !importing && value.id ? lookup(value.id) : undefined;
					if (!importing && value.id && !old) throw new Error('MCP 服务器已移除。');
					if (servers.some((s) => s.id !== old?.id && s.name.toLowerCase() === value.name.toLowerCase())) {
						if (importing) continue;
						throw new Error('已有同名的 MCP 服务器。');
					}
					const { args, secrets: argumentValues } = extractMcpArgumentSecrets(value.args);
					const inline = { ...secrets, args: argumentValues };
					if (value.url) {
						const url = new URL(inline.url ?? value.url);
						inline.url = url.search ? url.href : undefined;
						url.search = '';
						value.url = url.href;
					}
					const legacy = old?.secretKey;
					const secretKey = legacy && options.storage.getSecret(legacy) === JSON.stringify(inline) ? legacy : undefined;
					const refs = mergeMcpSecrets(selected, secretKey ? undefined : storeMcpSecrets(options.storage, value.name, inline, staged));
					validateMcpArgumentRefs(args, refs.args);
					const secretRefs = Object.values(refs).some((item) => item !== undefined) ? refs : undefined;
					const server = { ...value, id: old?.id ?? randomUUID(), args, secretKey, secretRefs,
						enabled: old?.enabled === true && value.enabled, ...(old && { enabledTools: old.enabledTools, disabledTools: old.disabledTools }) };
					if (server.type === 'stdio' && old && connectionKey(server) !== connectionKey(old)) server.enabled = false;
					if (old) servers[servers.findIndex((s) => s.id === old.id)] = server;
					else servers.push(server);
				}
				await commit({ ...settings(), servers }, reconnectId);
			} catch (error) {
				for (const key of staged) {
					if (!secretInUse(key)) erase(key);
				}
				throw error;
			}
		});
	}

	const ready = (server: McpServer, entry: ConnectionEntry): McpLiveServer | undefined => {
		const { catalog, connection } = entry;
		if (!catalog || !connection || entry.refreshing || entry.state !== 'ready' || !server.enabled || connectionKey(server) !== entry.key) return;
		return {
			server, connectionKey: entry.key, generation: entry.generation, connection, signal: entry.controller.signal,
			resources: catalog.resources, instructions: catalog.instructions,
			tools: catalog.tools.filter(({ name }) => toolEnabled(server, name))
				.map((tool) => ({ tool, signature: toolSignature(entry, tool) })),
			verify(signature, name) {
				const now = lookup(server.id);
				const live = now && entries.get(server.id) === entry ? ready(now, entry) : undefined;
				if (!live || (name && !live.tools.some((item) => item.tool.name === name && item.signature === signature))) {
					throw new Error('MCP 连接或工具已变化，请重新发起调用。');
				}
			},
		};
	};
	return {
		settings, draft, reconcile,
		isConnected(this: void, name: string): boolean {
			const server = settings().servers.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
			return Boolean(server?.enabled && entries.get(server.id)?.state === 'ready');
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		snapshot(): McpServerView[] {
			return settings().servers.map((server) => {
				const entry = entries.get(server.id);
				const catalog = entry?.catalog;
				const raw = options.storage.getSecret(oauthKey(server));
				const enabled = server.enabled && localApproved(server);
				return { server: enabled === server.enabled ? server : { ...server, enabled }, state: enabled ? entry?.state ?? 'connecting' : 'disabled',
					error: entry?.error, version: catalog?.version, prompts: catalog?.prompts, signedIn: Boolean(raw && /"access_token"\s*:/.test(raw)),
					tools: catalog ? catalog.tools.map((tool) => ({ ...tool, enabled: toolEnabled(server, tool.name) })) : [] };
			});
		},
		save: (value: McpServerDraft, reconnect = false) => saveMany([value], false, reconnect ? value.id : undefined),
		import: (values: McpServerDraft[]) => saveMany(values, true),
		async migrateLegacyArguments() {
			const legacy = settings().servers.filter((server) => server.type === 'stdio' && extractMcpArgumentSecrets(server.args).secrets);
			if (legacy.length) await saveMany(legacy.map((server) => draft(server.id)!), false);
		},
		setEnabled: (id: string, enabled: boolean, expected?: McpServer) => serialize(async () => {
			const server = lookup(id);
			if (!server || (expected && connectionKey(server) !== connectionKey(expected))) throw new Error('服务器配置已变化，请重新核对。');
			if (enabled && server.url && !isSecureServiceUrl(new URL(server.url))) throw new Error('远程 MCP 服务需要 HTTPS。请先修改服务器地址。');
			const key = localGrantKey(id);
			const granting = enabled && server.type === 'stdio';
			const previous = granting && options.storage.getSecret(key);
			if (granting) options.storage.setSecret(key, localGrant(connectionDraft(id)));
			try {
				await commit({ ...settings(), servers: settings().servers.map((item) => item.id === id ? { ...item, enabled } : item) }, id);
			} catch (error) {
				if (granting) options.storage.setSecret(key, previous || '');
				throw error;
			}
		}),
		remove: (id: string) => serialize(() => commit({ ...settings(), servers: settings().servers.filter((s) => s.id !== id) })),
		reorder: (fromId: string, toId: string) => serialize(async () => {
			const servers = [...settings().servers];
			const from = servers.findIndex(({ id }) => id === fromId);
			const to = servers.findIndex(({ id }) => id === toId);
			if (from < 0 || to < 0 || from === to) return;
			const [server] = servers.splice(from, 1);
			servers.splice(to, 0, server!);
			await commit({ ...settings(), servers });
		}),
		setLoading: (loading: McpSettings['loading'], threshold: number) => serialize(() => {
			if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('加载阈值必须是正整数。');
			return commit({ ...settings(), loading, threshold });
		}),
		setToolEnabled: (id: string, tool: string, enabled: boolean) => update(id, (server) => ({
			...server,
			enabledTools: enabled && server.enabledTools ? [...new Set([...server.enabledTools, tool])] : server.enabledTools,
			disabledTools: enabled ? server.disabledTools?.filter((name) => name !== tool) : [...new Set([...server.disabledTools ?? [], tool])],
		})),
		async retry(id: string) {
			const server = lookup(id);
			if (disposed || !server?.enabled) return;
			await start(server).pending;
		},
		async login(id: string) {
			let entry: ConnectionEntry | undefined;
			await serialize(() => {
				const server = lookup(id);
				if (!server?.enabled || server.type === 'stdio') throw new Error('请先启用远程 MCP 服务器。');
				if (!disposed) entry = start(server, true);
			});
			if (!entry) return;
			await entry.pending;
			if (entries.get(id) === entry && entry.state !== 'ready') throw new Error(entry.error ?? 'MCP 登录未完成。');
		},
		logout: (id: string) => serialize(() => {
			const server = lookup(id);
			if (!server) return;
			release(id);
			erase(oauthKey(server));
			reconcile();
		}),
		live(): McpLiveServer[] {
			return settings().servers.flatMap((server) => {
				const entry = entries.get(server.id);
				const live = entry && ready(server, entry);
				return live ? [live] : [];
			});
		},
		allowsDefinition(serverId: string, key: string, name?: string): boolean {
			const server = lookup(serverId);
			return Boolean(server?.enabled && connectionKey(server) === key && (name === undefined || toolEnabled(server, name)));
		},
		promptSession(serverId: string) {
			const server = lookup(serverId);
			const entry = entries.get(serverId);
			const live = server && entry && ready(server, entry);
			const { listPrompts, getPrompt } = live?.connection ?? {};
			if (!live || !entry?.catalog?.prompts || !listPrompts || !getPrompt) {
				throw new Error('此 MCP 服务尚未连接或不提供提示模板。');
			}
			return {
				server: live.server.name,
				async list(signal: AbortSignal) {
					live.verify();
					const prompts = await listPrompts(AbortSignal.any([signal, live.signal]));
					live.verify();
					return prompts;
				},
				async expand(name: string, args: Record<string, string>, signal: AbortSignal) {
					live.verify();
					const text = await getPrompt(name, args, AbortSignal.any([signal, live.signal]));
					live.verify();
					return text;
				},
			};
		},
		async waitForServer(id: string, signal: AbortSignal) {
			const server = lookup(id);
			if (disposed || !server?.enabled) return;
			const entry = entries.get(id) ?? start(server);
			await waitForConnections([entry], signal);
		},
		async waitForRequired(signal: AbortSignal) {
			const missing = settings().servers.filter((server) => server.enabled && server.required
				&& entries.get(server.id)?.state !== 'ready');
			if (!missing.length) return;
			reconcile();
			await waitForConnections(missing.flatMap(({ id }) => {
				const entry = entries.get(id);
				return entry ? [entry] : [];
			}), signal);
			const failed = settings().servers.filter((server) => server.enabled && server.required
				&& entries.get(server.id)?.state !== 'ready');
			if (failed.length) throw new Error('必需的 MCP 服务器尚未连接：' + failed.map(({ name }) => name).join('、') + '。请在 MCP 设置中重试。');
		},
		dispose() {
			disposed = true;
			for (const id of entries.keys()) release(id);
			listeners.clear();
		},
	};
}

export type McpManager = ReturnType<typeof createMcpManager>;
