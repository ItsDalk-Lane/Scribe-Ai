import { notImplemented } from '../../types';
import type { ContextBuilder } from '../../types';

/** 任务上下文的组织：用户指令、会话历史、任务信息与笔记资料合成一轮模型请求 */
export function createContextBuilder(): ContextBuilder {
	return {
		build: () => notImplemented('上下文组织'),
	};
}
