import type { PermissionPolicy, RunContext, Task } from '../types';

export function createRunContext(task: Task, permissions: PermissionPolicy): RunContext {
	return { task, permissions };
}
