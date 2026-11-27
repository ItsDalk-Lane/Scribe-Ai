import { createHash } from 'node:crypto';
import { isSecureServiceUrl } from './serviceAddress';

type BeforeSend = (address: string, destinationFingerprint?: string) => Promise<void>;

export interface ModelRequestConfirmation {
	beforeSend?: BeforeSend;
	onSend?: (address: string) => Promise<void>;
	expectedBase?: URL;
	controller: AbortController;
	failure?: Error;
}

const bedrockConfirmations = new WeakMap<AbortSignal, ModelRequestConfirmation>();
const approvedAddresses = new WeakMap<BeforeSend, Map<string, string>>();

export async function confirmModelRequest(url: URL, confirmation: ModelRequestConfirmation): Promise<void> {
	if (!isSecureServiceUrl(url)) throw new Error('远程模型请求必须使用 HTTPS。');
	if (confirmation.failure) throw confirmation.failure;
	const { beforeSend, controller, expectedBase } = confirmation;
	controller.signal.throwIfAborted();
	const address = url.origin + url.pathname;
	try {
		if (expectedBase && (url.origin !== expectedBase.origin || (url.pathname !== expectedBase.pathname
			&& !url.pathname.startsWith(expectedBase.pathname.replace(/\/+$/u, '') + '/')))) {
			throw new Error('模型请求偏离了配置的接收地址，请核对连接。');
		}
		if (!beforeSend) return await confirmation.onSend?.(address);
		let approved = approvedAddresses.get(beforeSend);
		if (!approved) {
			approved = new Map();
			approvedAddresses.set(beforeSend, approved);
		}
		const fingerprint = createHash('sha256').update(address + url.search).digest('hex');
		if (approved.has(address) && approved.get(address) !== fingerprint) {
			throw new Error('续做请求的地址参数已变更，请重新确认后再试。');
		}
		approved.set(address, fingerprint);
		await beforeSend(address, fingerprint);
		controller.signal.throwIfAborted();
		await confirmation.onSend?.(address);
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

/** Bedrock 的 SDK 通过 AbortSignal 把请求身份传到 AWS 中间件。 */
export function bindBedrockConfirmation(confirmation: ModelRequestConfirmation): void {
	bedrockConfirmations.set(confirmation.controller.signal, confirmation);
}

/** AWS 客户端已经完成地址解析，读取即将提交给它的请求。 */
export async function confirmBedrockRequest(request: BedrockRequest, signal: AbortSignal | undefined): Promise<void> {
	const confirmation = signal && bedrockConfirmations.get(signal);
	if (!confirmation) throw new Error('无法核对 Bedrock 请求的接收地址，请重试。');
	const { protocol, hostname, port, path, query } = request;
	const url = new URL(`${protocol}//${hostname}${port === undefined ? '' : `:${port}`}${path}`);
	for (const key of Object.keys(query ?? {}).sort()) {
		const values = query?.[key];
		for (const value of Array.isArray(values) ? values : [values ?? '']) url.searchParams.append(key, value);
	}
	await confirmModelRequest(url, confirmation);
}
