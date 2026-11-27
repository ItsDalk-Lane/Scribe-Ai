import { Buffer } from 'node:buffer';
import { obsidianSearchToolName } from '../tools/workspaceTools';
import { isAbsolute, resolve } from 'node:path';
import { MAX_REVIEW_MATERIAL_BYTES } from '../constants';
import { readOnlySkillTools } from '../tools/skillTools';
import { chatTaskToolNames } from '../tools/chatTaskTools';
import { planDraftToolNames } from '../tools/planTools';
import { subagentToolNames } from '../tools/subagentTools';
import { isWithinPath } from '../tools/support/pathUtils';
import { createPermissionPolicy } from './policies/permissions';
import { createReadDelivery } from '../runtime/readDelivery';
import type { ExecutionMode, RunContext, Task } from '../types';

const sideChatTools = new Set([...readOnlySkillTools, 'Read', 'Glob', 'Grep', obsidianSearchToolName]);

export async function createRunContext(
	task: Task,
	options: Pick<RunContext, 'cwd' | 'model' | 'signal' | 'observer' | 'checkModel' | 'reviewTool' | 'resumeReview' | 'history' | 'agreements' | 'record'
		| 'takeSteering' | 'rejectSteering' | 'writingRules' | 'manualSummary'>,
	configDir: string,
	toolsEnabled: () => boolean = () => true,
	sideChat = false,
	executionMode?: ExecutionMode,
): Promise<RunContext> {
	const { cwd, signal } = options;
	signal.throwIfAborted();
	if (task.request.selection) throw new Error('选区问答已停用，请新建普通提问。');
	const { intent, reviewMaterial } = task.request;
	if (reviewMaterial !== undefined && (intent !== 'review' || Buffer.byteLength(reviewMaterial) > MAX_REVIEW_MATERIAL_BYTES)) {
		throw new Error('检查资料过长，请缩小范围后重试。');
	}
	const readDelivery = createReadDelivery();
	// 侧聊只把本次明确转交的库外单个文件加入读取范围。
	const refs = sideChat ? task.request.refs.filter((ref) => isAbsolute(ref.path) && ref.kind === 'file' && ref.addedExternal)
		: intent === 'review' ? [] : intent === 'plan'
			? task.request.refs.filter(({ path }) => !isAbsolute(path) && isWithinPath(cwd, resolve(cwd, path))) : task.request.refs;
	const permissions = await createPermissionPolicy(cwd, configDir, refs, toolsEnabled,
		sideChat || intent ? undefined : executionMode, intent !== 'plan');
	signal.throwIfAborted();
	if (sideChat) {
		return { ...options, task, sideChat, readFiles: new Map(), readDelivery, permissions: {
			...permissions,
			canWrite: () => false,
			canCallTool: (tool) => tool.isReadOnly && sideChatTools.has(tool.name) && permissions.canCallTool(tool),
		} };
	}
	if (intent) {
		return { ...options, task, readFiles: new Map(), readDelivery, permissions: {
			...permissions,
			canRead: (path) => intent === 'plan' && permissions.canRead(path),
			canWrite: () => false,
			canCallTool: (tool) => intent === 'plan' && (planDraftToolNames.has(tool.name) || chatTaskToolNames.has(tool.name)
				|| (tool.isReadOnly && (sideChatTools.has(tool.name) || subagentToolNames.has(tool.name))))
				&& permissions.canCallTool(tool),
		} };
	}
	return { ...options, task, permissions, readFiles: new Map(), readDelivery };
}
