import { notImplemented } from '../types';
import type { ToolCoordinator } from '../types';

/** 工具调用协调：按模型提出的行动请求调度工具并回收执行结果 */
export function createToolCoordinator(): ToolCoordinator {
	return {
		runCalls: () => notImplemented('工具调用协调'),
	};
}
