import { isAbsolute } from 'node:path';
import { createPermissionPolicy } from './policies/permissions';
import { createReadDelivery } from '../runtime/readDelivery';
import type { ExecutionMode, RunContext, Task } from '../types';

const sideChatTools = new Set(['Read', 'Glob', 'Grep']);

export async function createRunContext(
	task: Task,
	options: Pick<RunContext, 'cwd' | 'model' | 'signal' | 'observer' | 'checkModel' | 'reviewTool' | 'resumeReview' | 'history' | 'agreements' | 'record'
		| 'takeSteering' | 'rejectSteering'>,
	configDir: string,
	toolsEnabled: () => boolean = () => true,
	sideChat = false,
	executionMode?: ExecutionMode,
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
	// 侧聊只把本次明确转交的库外单个文件加入读取范围。
	const refs = sideChat ? task.request.refs.filter((ref) => isAbsolute(ref.path) && ref.kind === 'file' && ref.addedExternal) : task.request.refs;
	const permissions = await createPermissionPolicy(cwd, configDir, refs, toolsEnabled, sideChat ? undefined : executionMode);
	signal.throwIfAborted();
	if (sideChat) {
		return { ...options, task, sideChat, readFiles: new Map(), readDelivery, permissions: {
			...permissions,
			canWrite: () => false,
			canCallTool: (tool) => tool.isReadOnly && sideChatTools.has(tool.name) && permissions.canCallTool(tool),
		} };
	}
	return { ...options, task, permissions, readFiles: new Map(), readDelivery };
}
