import { parse as parseToml } from 'smol-toml';
import { extractMcpArgumentSecrets } from './mcpArgumentSecrets';
import { isSecureServiceUrl } from '../../communication/serviceAddress';

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServer {
	id: string;
	name: string;
	description?: string;
	tags?: string[];
	type: McpTransport;
	enabled: boolean;
	required?: boolean;
	command?: string;
	args?: string[];
	cwd?: string;
	url?: string;
	envVars?: string[];
	envHeaders?: Record<string, string>;
	bearerTokenEnv?: string;
	oauthClientId?: string;
	oauthScopes?: string[];
	oauthCallbackPort?: number;
	startupTimeout?: number;
	toolTimeout?: number;
	enabledTools?: string[];
	disabledTools?: string[];
	secretKey?: string;
	/** 值为钥匙串 ID，连接时按原字段读取。 */
	secretRefs?: McpSecrets;
}

export interface McpSecrets {
	args?: Record<string, string>;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	bearerToken?: string;
	oauthClientSecret?: string;
	url?: string;
}

export type McpServerDraft = McpServer & { secrets?: McpSecrets };

export interface McpSettings {
	servers: McpServer[];
	loading: 'auto' | 'deferred' | 'direct';
	threshold: number;
}

const DEFAULT_THRESHOLD = 4_000;
const MAX_TIMEOUT_SECONDS = 2_147_483.647;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hasControl(value: string): boolean {
	return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char === '\u007f');
}

function owns(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function settingText(value: unknown, label: string): string | undefined {
	if (value === undefined || value === '') return;
	if (typeof value !== 'string' || hasControl(value)) throw new Error(`请检查${label}。`);
	return value.trim() || undefined;
}

function readList(value: unknown, label: string, check: (item: string) => boolean): string[] | undefined {
	if (value === undefined) return;
	if (!Array.isArray(value) || !(value as unknown[]).every((item): item is string => typeof item === 'string' && check(item))) {
		throw new Error(`请检查${label}。`);
	}
	return [...value as string[]];
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
	if (value === undefined || typeof value === 'boolean') return value;
	throw new Error(`请检查${label}。`);
}

function numberIn(value: unknown, label: string, max: number, integer = false): number | undefined {
	if (value === undefined) return;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value))) {
		throw new Error(`请检查${label}。`);
	}
	return value;
}

function strings(value: unknown, label: string): [string, string][] | undefined {
	if (value === undefined) return;
	const entries = Object.entries(object(value) ?? {});
	if (!object(value) || entries.some(([, entry]) => typeof entry !== 'string')) throw new Error(`请检查${label}。`);
	return entries as [string, string][];
}

function checkHeader(name: string, value: string): string {
	try {
		if (hasControl(value.replace(/\t/g, ''))) throw new Error();
		new Headers([[name, value]]);
		return name.toLowerCase();
	} catch {
		throw new Error('请求头名称或内容无效。');
	}
}

function headerMap(value: unknown, isReference: boolean): Record<string, string> | undefined {
	const entries = strings(value, '请求头')?.map(([key, text]) => {
		if (isReference && !envName.test(text)) throw new Error('请求头引用的环境变量名称无效。');
		return [checkHeader(key, text), text] as const;
	});
	if (entries && new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('请求头名称重复。');
	return entries && Object.fromEntries(entries);
}

function validUrl(value: unknown, allowLegacyHttp = false): string {
	try {
		const raw = settingText(value, '服务器地址');
		if (!raw) throw new Error();
		const url = new URL(raw);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
		if (!allowLegacyHttp && !isSecureServiceUrl(url)) throw new Error();
		return url.href;
	} catch {
		throw new Error('请输入有效的 HTTPS 地址。本机回环地址允许 HTTP。');
	}
}

function secretText(value: unknown): string | undefined {
	if (value === undefined || value === '') return;
	if (typeof value !== 'string' || hasControl(value)) throw new Error('登录凭据格式无效。');
	return value;
}

function secretId(value: unknown): string | undefined {
	if (value === undefined) return;
	if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error('钥匙串名称无效。');
	return value;
}

function secretIds(entries: Record<string, string> | undefined, allowEmpty = false): Record<string, string> | undefined {
	return entries && Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, allowEmpty && value === '' ? '' : secretId(value)!]));
}

/** 按当前连接类型取设置，保留准确的参数和密钥值。 */
export function validateMcpDraft(draft: McpServerDraft, allowLegacyHttp = false): McpServerDraft {
	const name = settingText(draft.name, '服务器名称');
	if (!name) throw new Error('请输入服务器名称。');
	const { type } = draft;
	if (type !== 'stdio' && type !== 'http' && type !== 'sse') throw new Error('连接类型无效。');
	const server: McpServerDraft = {
		id: typeof draft.id === 'string' ? draft.id : '', name, type, enabled: draft.enabled === true,
		required: optionalBoolean(draft.required, '必需服务设置'),
		description: settingText(draft.description, '服务器说明'),
		tags: readList(draft.tags, '标签', (v) => !!v.trim() && !hasControl(v)),
		startupTimeout: numberIn(draft.startupTimeout, '连接等待时间', MAX_TIMEOUT_SECONDS),
		toolTimeout: numberIn(draft.toolTimeout, '工具等待时间', MAX_TIMEOUT_SECONDS),
		enabledTools: readList(draft.enabledTools, '允许的工具', (v) => !!v.trim()),
		disabledTools: readList(draft.disabledTools, '停用的工具', (v) => !!v.trim()),
		secretKey: settingText(draft.secretKey, '凭据存储标识'),
	};
	if (type === 'stdio') {
		const command = settingText(draft.command, '启动命令');
		if (!command) throw new Error('请输入启动命令。');
		const env = strings(draft.secrets?.env, '环境变量');
		if (env?.some(([key, value]) => !envName.test(key) || value.includes('\0'))) throw new Error('环境变量名称或内容无效。');
		const envRefs = strings(draft.secretRefs?.env, '环境变量钥匙串');
		if (envRefs?.some(([key]) => !envName.test(key))) throw new Error('环境变量名称无效。');
		const args = readList(draft.args, '命令参数', (v) => !v.includes('\0'));
		const argumentRefs = strings(draft.secretRefs?.args, '命令参数钥匙串');
		if (argumentRefs?.some(([index]) => !/^(0|[1-9]\d*)$/.test(index) || Number(index) >= (args?.length ?? 0))) {
			throw new Error('命令参数钥匙串位置无效。');
		}
		return { ...server, command, cwd: settingText(draft.cwd, '工作目录'),
			args,
			envVars: readList(draft.envVars, '环境变量名称', (v) => envName.test(v)),
			...(env?.length ? { secrets: { env: Object.fromEntries(env) } } : {}),
			...(envRefs?.length || argumentRefs?.length ? { secretRefs: {
				env: envRefs?.length ? secretIds(Object.fromEntries(envRefs), true) : undefined,
				args: argumentRefs?.length ? secretIds(Object.fromEntries(argumentRefs)) : undefined,
			} } : {}),
		};
	}
	const url = validUrl(draft.url, allowLegacyHttp);
	const privateUrl = draft.secrets?.url === undefined ? undefined : validUrl(draft.secrets.url, allowLegacyHttp);
	if (privateUrl && privateUrl.split('?')[0] !== url.split('?')[0]) throw new Error('私密地址与服务器地址不一致。');
	const headers = headerMap(draft.secrets?.headers, false);
	const envHeaders = headerMap(draft.envHeaders, true);
	const headerRefs = secretIds(headerMap(draft.secretRefs?.headers, false), true);
	const bearerTokenRef = secretId(draft.secretRefs?.bearerToken);
	const oauthClientSecretRef = secretId(draft.secretRefs?.oauthClientSecret);
	const urlRef = secretId(draft.secretRefs?.url);
	const bearerToken = secretText(draft.secrets?.bearerToken);
	const bearerTokenEnv = settingText(draft.bearerTokenEnv, '令牌引用的环境变量');
	if (bearerTokenEnv && !envName.test(bearerTokenEnv)) throw new Error('令牌引用的环境变量名称无效。');
	const oauthClientId = settingText(draft.oauthClientId, '登录客户端 ID');
	const oauthClientSecret = secretText(draft.secrets?.oauthClientSecret);
	if ((oauthClientSecret || oauthClientSecretRef) && !oauthClientId) throw new Error('使用客户端密钥时也需要填写客户端 ID。');
	if ([bearerToken || bearerTokenRef, bearerTokenEnv, headers?.authorization ?? headerRefs?.authorization, envHeaders?.authorization, oauthClientId].filter(Boolean).length > 1) {
		throw new Error('服务器只能选择一种身份验证方式。');
	}
	return { ...server, url, envHeaders, bearerTokenEnv, oauthClientId,
		oauthScopes: readList(draft.oauthScopes, '登录权限范围', (v) => !!v.trim() && !hasControl(v)),
		oauthCallbackPort: numberIn(draft.oauthCallbackPort, '登录回调端口', 65_535, true),
		...(headers || bearerToken || oauthClientSecret || privateUrl ? { secrets: { headers, bearerToken, oauthClientSecret, url: privateUrl } } : {}),
		...(headerRefs || bearerTokenRef || oauthClientSecretRef || urlRef ? { secretRefs: {
			headers: headerRefs, bearerToken: bearerTokenRef, oauthClientSecret: oauthClientSecretRef, url: urlRef,
		} } : {}),
	};
}

export function normalizeMcpSettings(raw: unknown): McpSettings {
	const stored = object(raw);
	const seen = new Set<string>();
	const servers = (Array.isArray(stored?.servers) ? stored.servers : []).flatMap((entry: unknown) => {
		const record = object(entry);
		if (typeof record?.id !== 'string' || !record.id || seen.has(record.id)) return [];
		try {
			const { secrets: _secrets, ...server } = validateMcpDraft({ ...record, secrets: undefined } as McpServerDraft, true);
			if (server.url) {
				const address = new URL(server.url);
				address.search = '';
				server.url = address.href;
				if (!isSecureServiceUrl(address)) server.enabled = false;
			}
			seen.add(server.id);
			return [server];
		} catch { return []; }
	});
	const { loading, threshold } = stored ?? {};
	return { servers, loading: loading === 'deferred' || loading === 'direct' ? loading : 'auto',
		threshold: typeof threshold === 'number' && Number.isSafeInteger(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD,
	};
}

const commonImportFields = new Set(['name', 'type', 'description', 'tags', 'enabled', 'isActive', 'required',
	'command', 'args', 'cwd', 'env', 'env_vars', 'envVars', 'url', 'baseUrl', 'headers', 'http_headers',
	'env_http_headers', 'envHeaders', 'bearer_token_env_var', 'bearerTokenEnv', 'bearerToken', 'oauth', 'oauthClientId',
	'oauthScopes', 'scopes', 'oauthCallbackPort', 'oauthClientSecret', 'startup_timeout_sec', 'startup_timeout_ms',
	'startupTimeout', 'tool_timeout_sec', 'toolTimeout', 'timeout', 'timeoutSeconds', 'enabled_tools', 'enabledTools',
	'disabled_tools', 'disabledTools']);

function importedType(raw: Record<string, unknown>, url: unknown, codex: boolean): McpTransport {
	if (raw.type !== undefined) {
		const type = typeof raw.type === 'string' ? raw.type.replace(/[-_]/g, '').toLowerCase() : '';
		if (type === 'stdio' || type === 'sse') return type;
		if (type === 'http' || type === 'streamablehttp') return 'http';
		throw new Error('连接类型不受支持。');
	}
	if (raw.command !== undefined && url !== undefined) throw new Error('请只提供命令或服务器地址中的一项。');
	if (raw.command !== undefined || url === undefined) return 'stdio';
	return codex || /\/mcp\/?$/i.test(new URL(validUrl(url)).pathname) ? 'http' : 'sse';
}

function importEnvVars(value: unknown): string[] | undefined {
	if (value === undefined) return;
	if (!Array.isArray(value)) throw new Error('请检查环境变量名称。');
	return (value as unknown[]).map((item) => {
		if (typeof item === 'string') return item;
		const row = object(item);
		if (row?.source === 'remote') throw new Error('此服务器需要远程执行环境。');
		if (typeof row?.name !== 'string' || (row.source !== undefined && row.source !== 'local')) throw new Error('请检查环境变量来源。');
		return row.name;
	});
}

function importDraft(label: string, raw: Record<string, unknown>, codex: boolean): McpServerDraft {
	if (raw.environment_id !== undefined && raw.environment_id !== 'local') throw new Error('此服务器需要远程执行环境。');
	const url = raw.url ?? raw.baseUrl;
	const type = importedType(raw, url, codex);
	const oauth = object(raw.oauth);
	const startMs = numberIn(raw.startup_timeout_ms, '连接等待时间', MAX_TIMEOUT_SECONDS * 1000);
	const draft = validateMcpDraft({
		id: '', name: raw.name ?? label, type, enabled: false, required: raw.required,
		description: raw.description, tags: raw.tags, command: raw.command, args: raw.args, cwd: raw.cwd, url,
		envVars: importEnvVars(raw.env_vars ?? raw.envVars), envHeaders: raw.env_http_headers ?? raw.envHeaders,
		bearerTokenEnv: raw.bearer_token_env_var ?? raw.bearerTokenEnv,
		oauthClientId: oauth?.client_id ?? raw.oauthClientId, oauthScopes: raw.scopes ?? raw.oauthScopes,
		oauthCallbackPort: oauth?.callback_port ?? raw.oauthCallbackPort,
		startupTimeout: raw.startup_timeout_sec ?? raw.startupTimeout ?? (startMs === undefined ? undefined : startMs / 1000),
		toolTimeout: raw.tool_timeout_sec ?? raw.toolTimeout ?? raw.timeout ?? raw.timeoutSeconds,
		enabledTools: raw.enabled_tools ?? raw.enabledTools, disabledTools: raw.disabled_tools ?? raw.disabledTools,
		secrets: { env: raw.env, headers: raw.http_headers ?? raw.headers, bearerToken: raw.bearerToken,
			oauthClientSecret: oauth?.client_secret ?? raw.oauthClientSecret },
	} as McpServerDraft);
	const headers = draft.secrets?.headers;
	const bearer = /^Bearer[\t ]+(\S+)$/i.exec(headers?.authorization ?? '')?.[1];
	if (headers && bearer) {
		delete headers.authorization;
		draft.secrets = { ...draft.secrets, headers: Object.keys(headers).length ? headers : undefined, bearerToken: bearer };
	}
	return draft;
}

export function previewMcpImport(raw: string, existingNames: string[]): { drafts: McpServerDraft[]; issues: string[] } {
	const source = raw.trim().replace(/^\uFEFF/, '');
	if (!source) return { drafts: [], issues: [] };
	const codex = !source.startsWith('{');
	let parsed: unknown;
	try { parsed = codex ? parseToml(source) : JSON.parse(source) as unknown; }
	catch { return { drafts: [], issues: [codex ? '无法读取 Codex 的 TOML 配置。' : '无法读取 JSON 配置。'] }; }
	const root = object(parsed);
	const values = codex ? object(root?.mcp_servers) : root && (owns(root, 'mcpServers') ? object(root.mcpServers) : root);
	if (!values) return { drafts: [], issues: ['找不到服务器配置。'] };
	const names = new Set(existingNames.map((name) => name.trim().toLowerCase()));
	const drafts: McpServerDraft[] = [];
	const issues: string[] = [];
	for (const [label, value] of Object.entries(values)) {
		const entry = object(value);
		try {
			if (!entry) throw new Error('服务器配置应为一组设置。');
			const draft = importDraft(label, entry, codex);
			const key = draft.name.toLowerCase();
			if (names.has(key)) throw new Error('已存在同名服务器，已跳过。');
			names.add(key);
			drafts.push(draft);
			const unsupported = Object.keys(entry).filter((key) => !commonImportFields.has(key));
			if (owns(entry, 'oauth') && !object(entry.oauth)) unsupported.push('oauth');
			for (const field of Object.keys(object(entry.oauth) ?? {})) {
				if (!['client_id', 'client_secret', 'callback_port'].includes(field)) unsupported.push(`oauth.${field}`);
			}
			if (unsupported.length) issues.push(`${draft.name}：这些设置未导入（${unsupported.join('、')}）。`);
		} catch (error) {
			issues.push(`${label}：${error instanceof Error ? error.message : '服务器配置无效。'}`);
		}
	}
	return { drafts, issues };
}

function exportUrl(value: string | undefined): string | undefined {
	if (!value) return;
	try {
		const url = new URL(value);
		if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}${url.pathname}`;
	} catch { return; }
	return undefined;
}

export function exportMcpJson(servers: readonly McpServer[]): string {
	const entries = servers.map((s) => [s.name, {
		type: s.type === 'http' ? 'streamableHttp' : s.type, description: s.description, tags: s.tags,
		...(s.type === 'stdio' ? { command: s.command, args: extractMcpArgumentSecrets(s.args).args, cwd: s.cwd, envVars: s.envVars } : {
			url: exportUrl(s.url), envHeaders: s.envHeaders, bearerTokenEnv: s.bearerTokenEnv,
			oauthClientId: s.oauthClientId, oauthScopes: s.oauthScopes, oauthCallbackPort: s.oauthCallbackPort,
		}),
		required: s.required, startupTimeout: s.startupTimeout, timeout: s.toolTimeout,
		enabledTools: s.enabledTools, disabledTools: s.disabledTools,
	}] as const);
	return JSON.stringify({ mcpServers: Object.fromEntries(entries) }, null, 2);
}
