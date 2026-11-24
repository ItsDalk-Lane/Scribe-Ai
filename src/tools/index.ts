import { createToolExecutor } from './executor';
import { readTools } from './readTools';
import { skillTools } from './skillTools';
import { searchTools } from './searchTools';
import { subagentTools } from './subagentTools';
import { taskTools } from './taskTools';
import { structuredOutputTool } from './structuredOutputTool';
import type { McpManager } from './external/mcp';
import { createMcpTools } from './external/mcpTools';
import { ShellJobs } from './external/shellJobs';
import type { ShellJobHistory } from './external/shellJobs';
import { shellTools } from './external/shellTool';
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
export function createToolLayer(history?: ShellJobHistory, mcp?: McpManager, cacheDirectory?: string, web: ToolModule = () => []): ToolLayer {
	const shellJobs = new ShellJobs(history, cacheDirectory);
	const external = { web, shell: () => shellTools(shellJobs), mcp: () => mcp ? createMcpTools(mcp) : [] };
	const registry = createToolRegistry([
		readTools,
		writeTools,
		searchTools,
		workspaceTools,
		() => taskTools(shellJobs),
		subagentTools,
		structuredOutputTool,
		skillTools,
		external.web,
		external.shell,
		external.mcp,
	]);
	return { registry, executor: createToolExecutor(registry, cacheDirectory), external, shellJobs, mcp };
}
