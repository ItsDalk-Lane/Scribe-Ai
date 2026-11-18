import { createPermissionPolicy } from './policies/permissions';
import { createReadDelivery } from '../runtime/readDelivery';
import type { RunContext, Task } from '../types';

export async function createRunContext(
	task: Task,
	options: Pick<RunContext, 'cwd' | 'model' | 'signal' | 'observer' | 'checkModel' | 'resumeReview' | 'history' | 'agreements' | 'record'>,
	configDir: string,
	toolsEnabled: () => boolean = () => true,
): Promise<RunContext> {
	const { cwd, signal } = options;
	signal.throwIfAborted();
	const readDelivery = createReadDelivery();
	// 选区快照已经包含授权的全部资料，封住读取文件与命令的入口。
	if (task.request.selection) {
		return {
			...options,
			task,
			readFiles: new Map(),
			readDelivery,
			permissions: {
				canRead: () => false,
				canWrite: () => false,
				canCallTool: () => false,
				canSendOutbound: () => true,
			},
		};
	}
	const permissions = await createPermissionPolicy(cwd, configDir, task.request.refs, toolsEnabled);
	signal.throwIfAborted();
	return { ...options, task, permissions, readFiles: new Map(), readDelivery };
}
