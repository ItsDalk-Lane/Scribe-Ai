import { AsyncLocalStorage } from 'node:async_hooks';
import { isSecureServiceUrl } from './serviceAddress';

type BeforeSend = (address: string) => Promise<void>;

export interface ModelRequestConfirmation {
	beforeSend?: BeforeSend;
	expectedBase?: URL;
	controller: AbortController;
	failure?: Error;
}

export const modelRequestConfirmation = new AsyncLocalStorage<ModelRequestConfirmation>();
const approvedAddresses = new WeakMap<BeforeSend, Map<string, string>>();

export async function confirmModelRequest(url: URL): Promise<void> {
	if (!isSecureServiceUrl(url)) throw new Error('远程模型请求必须使用 HTTPS。');
	const confirmation = modelRequestConfirmation.getStore();
	if (!confirmation) return;
	if (confirmation.failure) throw confirmation.failure;
	const { beforeSend, controller, expectedBase } = confirmation;
	controller.signal.throwIfAborted();
	const address = url.origin + url.pathname;
	const actual = address + url.search;
	try {
		if (expectedBase && (url.origin !== expectedBase.origin || (url.pathname !== expectedBase.pathname
			&& !url.pathname.startsWith(expectedBase.pathname.replace(/\/+$/u, '') + '/')))) {
			throw new Error('模型请求偏离了配置的接收地址，请核对连接。');
		}
		if (!beforeSend) return;
		let approved = approvedAddresses.get(beforeSend);
		if (!approved) {
			approved = new Map();
			approvedAddresses.set(beforeSend, approved);
		}
		if (approved.has(address) && approved.get(address) !== actual) {
			throw new Error('续做请求的地址参数已变更，请重新确认后再试。');
		}
		approved.set(address, actual);
		await beforeSend(address);
		controller.signal.throwIfAborted();
	} catch (error) {
		confirmation.failure = error instanceof Error ? error : new Error(String(error));
		controller.abort(confirmation.failure);
		throw confirmation.failure;
	}
}

interface BedrockRequest {
	protocol: string;
	hostname: string;
	port?: number;
	path: string;
	query?: Record<string, string | string[] | null>;
}

/** AWS 客户端已经完成地址解析，读取即将提交给它的请求。 */
export async function confirmBedrockRequest(request: BedrockRequest): Promise<void> {
	const { protocol, hostname, port, path, query } = request;
	const url = new URL(`${protocol}//${hostname}${port === undefined ? '' : `:${port}`}${path}`);
	for (const key of Object.keys(query ?? {}).sort()) {
		const values = query?.[key];
		for (const value of Array.isArray(values) ? values : [values ?? '']) url.searchParams.append(key, value);
	}
	await confirmModelRequest(url);
}
