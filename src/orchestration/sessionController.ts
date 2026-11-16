import { notImplemented } from '../types';
import type { SessionController } from '../types';

/** 会话管理与任务协调：交互层只提任务，会话与任务生命周期在这里统一推进 */
export function createSessionController(): SessionController {
	return {
		createConversation: () => notImplemented('会话创建'),
		submit: () => notImplemented('任务提交'),
		cancel: () => notImplemented('任务取消'),
	};
}
