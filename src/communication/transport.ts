import type { App } from 'obsidian';
import type { CommunicationSettings, Transport } from '../types';
import { diagnostics } from './diagnostics';
import { nodeFetch } from './nodeFetch';
import { configureProxy, readConfiguredProxy } from './proxy';

/** 模型请求的唯一网络出口；SDK 与 Google 适配器均使用标准 fetch 契约。 */
export function createTransport(settings: CommunicationSettings, secrets: App['secretStorage']): Transport {
	const configure = (next: CommunicationSettings) => configureProxy({
		proxyUrl: next.proxyUrl, credentialedUrl: () => readConfiguredProxy(next, secrets),
	});
	configure(settings);
	return {
		fetch: nodeFetch,
		configure,
		onStatus: (listener) => diagnostics.subscribe(listener),
		logs: () => diagnostics.list(),
	};
}
