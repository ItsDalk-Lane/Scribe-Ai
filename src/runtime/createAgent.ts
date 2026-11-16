import { createAgentLoop } from './agentLoop';
import { createRunState } from './runState';
import type { Agent, RunContext, RunState } from '../types';

/** Agent 运行实例的创建：一个任务一个实例，状态随实例走 */
export function createAgent(ctx: RunContext, state?: RunState): Agent {
	return { loop: createAgentLoop(), state: state ?? createRunState(ctx) };
}
