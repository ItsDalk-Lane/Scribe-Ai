import { notImplemented } from '../types';
import type { AgentLoop } from '../types';

/** 核心循环推进：根据模型输出与工具反馈决定继续、等待用户或结束 */
export function createAgentLoop(): AgentLoop {
	return {
		run: () => notImplemented('核心循环'),
	};
}
