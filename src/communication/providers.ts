import { notImplemented } from '../types';
import type { ModelProviderInfo, ModelService } from '../types';

/** 模型服务注册与协议适配：不同服务商的请求与响应差异在此收敛 */
export function createModelService(): ModelService {
	const providers: ModelProviderInfo[] = [];
	return {
		providers: () => providers,
		send: () => notImplemented('模型调用'),
	};
}
