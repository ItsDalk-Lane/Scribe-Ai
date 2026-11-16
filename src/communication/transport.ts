import { notImplemented } from '../types';
import type { Transport } from '../types';

/** 模型请求的网络传输：连接状态与通信异常在此处理 */
export function createTransport(): Transport {
	return {
		postJson: () => notImplemented('模型请求传输'),
	};
}
