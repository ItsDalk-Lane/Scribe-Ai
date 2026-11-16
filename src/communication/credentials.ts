import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import type { CommunicationSettings } from '../types';

const SECRET_PREFIX = 'scribe-ai-';

export function credentialIdForProvider(providerId: string): string {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) {
		throw new Error(`Invalid provider ID for SecretStorage: ${providerId}`);
	}
	return `${SECRET_PREFIX}${providerId}`;
}

function parseCredential(secret: string | null): Credential | undefined {
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
	const chains = new Map<string, Promise<void>>();
	const secretId = (providerId: string) => settings.credentialIds[providerId]
		?? credentialIdForProvider(providerId);
	const read = (providerId: string) => parseCredential(
		app.secretStorage.getSecret(secretId(providerId)),
	);
	const checkSignal = (options?: AuthOperationOptions) => options?.signal?.throwIfAborted();
	const enqueue = <T>(providerId: string, task: () => Promise<T>): Promise<T> => {
		const previous = chains.get(providerId) ?? Promise.resolve();
		const result = previous.catch(() => {}).then(task);
		chains.set(providerId, result.then(() => undefined, () => undefined));
		return result;
	};

	return {
		async read(providerId, options) {
			checkSignal(options);
			return read(providerId);
		},
		async list(options) {
			checkSignal(options);
			const refs = new Map<string, string>();
			for (const [providerId, id] of Object.entries(settings.credentialIds)) refs.set(providerId, id);
			for (const id of app.secretStorage.listSecrets()) {
				if (id.startsWith(SECRET_PREFIX)) refs.set(id.slice(SECRET_PREFIX.length), id);
			}
			const result: CredentialInfo[] = [];
			for (const [providerId, id] of refs) {
				const credential = parseCredential(app.secretStorage.getSecret(id));
				if (credential) result.push({ providerId, type: credential.type });
			}
			return result;
		},
		modify(providerId, fn, options) {
			return enqueue(providerId, async () => {
				checkSignal(options);
				const current = read(providerId);
				const next = await fn(current);
				checkSignal(options);
				if (next && next !== current) {
					app.secretStorage.setSecret(secretId(providerId), serializeCredential(next));
				}
				return next;
			});
		},
		delete(providerId, options) {
			return enqueue(providerId, async () => {
				checkSignal(options);
				app.secretStorage.setSecret(secretId(providerId), '');
			});
		},
	};
}
