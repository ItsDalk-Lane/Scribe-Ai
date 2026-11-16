import { notImplemented } from '../types';
import type { CredentialStore } from '../types';

/** 模型服务的连接信息与认证凭据 */
export function createCredentialStore(): CredentialStore {
	const secrets = new Map<string, string>();
	return {
		get: (providerId) => secrets.get(providerId),
		set: () => notImplemented('凭据保存'),
		clear: () => notImplemented('凭据清除'),
	};
}
