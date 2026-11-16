import { notImplemented } from '../types';
import type { ModelCoordinator } from '../types';

/** 当前轮次的模型调用协调：整理请求、跨通信层取得输出与行动请求 */
export function createModelCoordinator(): ModelCoordinator {
	return {
		nextTurn: () => notImplemented('模型调用协调'),
	};
}
