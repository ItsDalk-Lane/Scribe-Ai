import { createHash } from 'node:crypto';
import { parseCredential } from '../../communication/credentials';
import type { ArkFetch } from '../../communication/arkVisual';
import type { MediaAdapter, MediaOperation } from '../../communication/mediaApi';
import { mediaAdapter } from '../../communication/mediaRegistry';
import type { ScribeSettings, ToolContext } from '../../types';

export interface MediaJobRoute { providerId: string; model: string; operation: MediaOperation }

export function mediaConnection(settings: ScribeSettings, secrets: ToolContext['app']['secretStorage'], route: MediaJobRoute,
	adapter: MediaAdapter | undefined = mediaAdapter(route.providerId, route.model, route.operation), allowExpiredRadiusLogin = false) {
	const { providerId, model, operation } = route;
	const secret = settings.communication.credentialIds[providerId];
	if (!adapter || !secret || settings.disabledProviderIds.includes(providerId) || !settings.providerModels[providerId]?.includes(model)) return;
	const credential = parseCredential(secrets.getSecret(secret));
	if (!credential) return;
	const baseUrl = settings.modelOverrides[providerId]?.[model]?.baseUrl || settings.communication.baseUrls[providerId] || undefined;
	const target = URL.parse(adapter.endpoint({ model, baseUrl }));
	if (target?.protocol !== 'https:' || target.username || target.password || target.hash) {
		throw new Error('媒体服务的 HTTPS 地址无效。');
	}
	const key = (credential.type === 'api_key' ? credential.key
		: providerId === 'radius' && target.origin === 'https://radius.pi.dev'
			&& (credential.expires > Date.now() || allowExpiredRadiusLogin) ? credential.access : undefined)?.trim();
	if (!key) return;
	if (providerId.startsWith('minimax-m-plan') && !key.startsWith('sk-cp-')) throw new Error('MiniMax M Plan 媒体使用订阅密钥。');
	const endpoint = target.href;
	const identity = createHash('sha256').update(JSON.stringify([providerId, model, operation, secret, key, endpoint])).digest('hex');
	return { adapter, key, endpoint, baseUrl, identity };
}

export function guardedMediaFetch(fetcher: ArkFetch, endpoint: string, confirm: () => void, onSend?: () => void): typeof fetch {
	const origin = new URL(endpoint).origin;
	return (input, init) => {
		confirm();
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.origin !== origin || url.username || url.password) throw new Error('媒体请求的接收方已变化。');
		return fetcher(input, { ...init, redirect: 'error' }, (actual) => {
			confirm();
			if (actual.href !== url.href) throw new Error('媒体请求的接收地址已变化。');
			onSend?.();
			return Promise.resolve();
		});
	};
}
