import type { McpSecrets } from './mcpConfig';

export interface McpSecretStorage {
	getSecret(key: string): string | null;
	setSecret(key: string, value: string): void;
	listSecrets?(): string[];
}

export class MissingMcpSecretError extends Error {
	constructor() { super('MCP 需要的钥匙串条目已缺失或为空。请在服务器设置中重新选择。'); }
}

function mapSecrets(secrets: McpSecrets, map: (value: string) => string): McpSecrets {
	const fields = (values: Record<string, string> | undefined) => values
		&& Object.fromEntries(Object.entries(values).map(([name, value]) => [name, map(value)]));
	return {
		env: fields(secrets.env), headers: fields(secrets.headers), args: fields(secrets.args),
		bearerToken: secrets.bearerToken === undefined ? undefined : map(secrets.bearerToken),
		oauthClientSecret: secrets.oauthClientSecret === undefined ? undefined : map(secrets.oauthClientSecret),
		url: secrets.url === undefined ? undefined : map(secrets.url),
	};
}

export function mergeMcpSecrets(base: McpSecrets = {}, extra: McpSecrets = {}): McpSecrets {
	return {
		env: base.env || extra.env ? { ...base.env, ...extra.env } : undefined,
		headers: base.headers || extra.headers ? { ...base.headers, ...extra.headers } : undefined,
		args: base.args || extra.args ? { ...base.args, ...extra.args } : undefined,
		bearerToken: extra.bearerToken ?? base.bearerToken,
		oauthClientSecret: extra.oauthClientSecret ?? base.oauthClientSecret,
		url: extra.url ?? base.url,
	};
}

export function readMcpSecrets(storage: McpSecretStorage, refs: McpSecrets): McpSecrets {
	return mapSecrets(refs, (key) => {
		// 显式空值不是凭据，保留它与未配置的区别。
		if (key === '') return '';
		const value = storage.getSecret(key);
		if (!value) throw new MissingMcpSecretError();
		return value;
	});
}

export function storeMcpSecrets(storage: McpSecretStorage, serverName: string, values: McpSecrets, staged: Set<string>): McpSecrets {
	const base = serverName.normalize('NFKD').replace(/\p{Mark}/gu, '').toLowerCase()
		.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp';
	const existing = new Set(storage.listSecrets?.());
	let next = 1;
	return mapSecrets(values, (value) => {
		if (value === '') return '';
		let key: string;
		do {
			key = next === 1 ? base : `${base}-${next}`;
			next++;
		} while (existing.has(key) || staged.has(key) || storage.getSecret(key) !== null);
		staged.add(key);
		storage.setSecret(key, value);
		return key;
	});
}

export function usesMcpSecret(refs: McpSecrets | undefined, key: string): boolean {
	return Boolean(refs && (refs.bearerToken === key || refs.oauthClientSecret === key || refs.url === key
		|| [refs.env, refs.headers, refs.args].some((group) => Object.values(group ?? {}).includes(key))));
}
