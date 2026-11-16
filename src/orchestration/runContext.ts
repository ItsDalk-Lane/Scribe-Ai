import type { PermissionPolicy, RunContext, RunPolicy, Task } from '../types';

/** 本次任务的目标、授权与运行约束，核心循环层只读使用 */
export function createRunContext(
	task: Task,
	permissions: PermissionPolicy,
	policy: RunPolicy,
): RunContext {
	return { task, permissions, policy };
}
