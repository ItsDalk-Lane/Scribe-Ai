import { notImplemented } from '../types';
import type { ToolExecutor, ToolRegistry } from '../types';

/** 工具执行入口：先校验工具是否存在与是否被授权，再执行真实动作 */
export function createToolExecutor(registry: ToolRegistry): ToolExecutor {
	return {
		execute: async (call) => {
			if (!registry.find(call.name)) {
				return { callId: call.id, content: `未知工具：${call.name}`, isError: true };
			}
			return notImplemented(`工具执行：${call.name}`);
		},
	};
}
