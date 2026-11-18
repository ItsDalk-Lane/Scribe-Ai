import { createToolExecutor } from './executor';
import { readTools } from './readTools';
import { skillTools } from './skillTools';
import { searchTools } from './searchTools';
import { taskTools } from './taskTools';
import { mcpTools } from './external/mcp';
import { shellTools } from './external/shellTool';
import { webTools } from './external/webTools';
import { workspaceTools } from './workspaceTools';
import { writeTools } from './writeTools';
import type { ToolLayer, ToolModule, ToolRegistry } from '../types';

export function createToolRegistry(modules: ToolModule[]): ToolRegistry {
	const all = () => modules.flatMap((module) => module()).filter((tool) => tool.isAvailable?.() ?? true);
	return {
		all,
		find: (name) => all().find((spec) => spec.name === name),
	};
}

/** 工具层的统一出口：能力清单 + 统一执行入口 */
export function createToolLayer(): ToolLayer {
	const external = { web: webTools, shell: shellTools, mcp: mcpTools };
	// 原生命令无法限制在用户选定的资料范围内，因此不注册到聊天。
	const registry = createToolRegistry([
		readTools,
		writeTools,
		searchTools,
		workspaceTools,
		taskTools,
		skillTools,
		external.web,
		external.mcp,
	]);
	return { registry, executor: createToolExecutor(registry), external };
}
