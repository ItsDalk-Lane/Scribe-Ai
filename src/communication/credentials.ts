import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import type { CommunicationSettings } from '../types';

const SECRET_PREFIX = 'scribe-ai-';
const pendingByStorage = new WeakMap<App['secretStorage'], Map<string, Promise<void>>>();

export function credentialIdForProvider(providerId: string): string {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) {
		throw new Error(`Invalid provider ID for SecretStorage: ${providerId}`);
	}
	return `${SECRET_PREFIX}${providerId}`;
}

export function parseCredential(secret: string | null): Credential | undefined {
	if (!secret) return undefined;
	if (!secret.trimStart().startsWith('{')) return { type: 'api_key', key: secret };
	const value = JSON.parse(secret) as Partial<Credential>;
	if (value.type === 'api_key') {
		return { ...value, type: 'api_key' };
	}
	if (value.type === 'oauth'
		&& typeof value.refresh === 'string'
		&& typeof value.access === 'string'
		&& typeof value.expires === 'number') {
		return {
			...value,
			type: 'oauth',
			refresh: value.refresh,
			access: value.access,
			expires: value.expires,
		};
	}
	throw new Error('Invalid credential in Obsidian SecretStorage');
}

function serializeCredential(credential: Credential): string {
	if (credential.type === 'api_key' && !credential.env) return credential.key ?? '';
	return JSON.stringify(credential);
}

export function createCredentialStore(
	app: App,
	settings: CommunicationSettings,
): CredentialStore {
	const chains = pendingByStorage.get(app.secretStorage) ?? new Map<string, Promise<void>>();
	pendingByStorage.set(app.secretStorage, chains);
	// 槽位名称只用于创建，不能用来推断当前服务商有权读取旧密钥。
	const secretId = (providerId: string) => Object.prototype.hasOwnProperty.call(settings.credentialIds, providerId)
		? settings.credentialIds[providerId]
		: undefined;
	const read = (id: string | undefined) => id ? parseCredential(app.secretStorage.getSecret(id)) : undefined;
	const checkSignal = (options?: AuthOperationOptions) => options?.signal?.throwIfAborted();
	const enqueue = <T>(id: string, task: () => Promise<T>): Promise<T> => {
		const previous = chains.get(id) ?? Promise.resolve();
		const result = previous.catch(() => {}).then(task);
		const settled = result.then(() => undefined, () => undefined);
		chains.set(id, settled);
		void settled.then(() => { if (chains.get(id) === settled) chains.delete(id); });
		return result;
	};

	return {
		async read(providerId, options) {
			checkSignal(options);
			return read(secretId(providerId));
		},
		async list(options) {
			checkSignal(options);
			const result: CredentialInfo[] = [];
			for (const [providerId, id] of Object.entries(settings.credentialIds)) {
				const credential = read(id);
				if (credential) result.push({ providerId, type: credential.type });
			}
			return result;
		},
		modify(providerId, fn, options) {
			const id = secretId(providerId);
			if (!id) return Promise.reject(new Error('Credential link is missing or changed'));
			return enqueue(id, async () => {
				checkSignal(options);
				if (id !== secretId(providerId)) throw new Error('Credential link is missing or changed');
				const current = read(id);
				const next = await fn(current);
				checkSignal(options);
				if (next && next !== current) {
					if (id !== secretId(providerId)) throw new Error('Credential link is missing or changed');
					app.secretStorage.setSecret(id, serializeCredential(next));
				}
				return next;
			});
		},
		delete(providerId, options) {
			const id = secretId(providerId);
			if (!id) return Promise.resolve();
			return enqueue(id, async () => {
				checkSignal(options);
				if (id !== secretId(providerId)) throw new Error('Credential link is missing or changed');
				app.secretStorage.setSecret(id, '');
			});
		},
	};
}
