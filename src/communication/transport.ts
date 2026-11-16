import type { CommunicationSettings, Transport } from '../types';
import { diagnostics } from './diagnostics';
import { nodeFetch } from './nodeFetch';
import { configureProxy } from './proxy';

/** 模型请求的唯一网络出口；SDK 与 Google 适配器均使用标准 fetch 契约。 */
export function createTransport(settings: CommunicationSettings): Transport {
	configureProxy({ proxyUrl: settings.proxyUrl });
	return {
		fetch: nodeFetch,
		configure: (next) => configureProxy({ proxyUrl: next.proxyUrl }),
		onStatus: (listener) => diagnostics.subscribe(listener),
		logs: () => diagnostics.list(),
	};
}
