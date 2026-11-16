import { notImplemented } from '../types';
import type { TaskManager } from '../types';

/** 任务及子任务的关系与生命周期 */
export function createTaskManager(): TaskManager {
	return {
		create: () => notImplemented('任务创建'),
		update: () => notImplemented('任务状态更新'),
		children: () => notImplemented('子任务查询'),
	};
}
