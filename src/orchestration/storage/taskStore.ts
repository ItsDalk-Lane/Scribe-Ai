import { notImplemented } from '../../types';
import type { TaskStore } from '../../types';

/** 任务状态与运行记录的保存与恢复 */
export function createTaskStore(): TaskStore {
	return {
		load: async () => null,
		save: () => notImplemented('任务状态保存'),
		list: async () => [],
	};
}
