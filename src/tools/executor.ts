import { truncate } from './support/truncate';
import { boundToolResult } from './support/resultSpill';
import { toolExecutionInput } from './support/toolInput';
import { TOOL_NOT_APPROVED } from '../types';
import type { ToolExecutor, ToolRegistry } from '../types';

/** 执行前校验、取得授权，再返回可直接配对的工具结果。 */
export function createToolExecutor(registry: ToolRegistry): ToolExecutor {
	return {
		execute: async (call, ctx) => {
			const { signal, approve, permissions, retryApproval } = ctx;
			const failure = (content: string) => ({ callId: call.id, content, isError: true });
			try {
				signal.throwIfAborted();
				const tool = registry.find(call.name);
				if (!tool) return failure(`工具不可用：${call.name}`);
				if (!permissions.canCallTool(tool)) return failure(`未授权使用工具：${call.name}`);
				const prepared = await tool.prepare(toolExecutionInput(call.input), ctx);
				signal.throwIfAborted();
				if (retryApproval && (!prepared.approval || prepared.approvalIdentity !== retryApproval.identity
					|| JSON.stringify(prepared.approval) !== JSON.stringify(retryApproval.approval))) {
					return failure('操作预览或工作目录已变化，请重新提交任务。');
				}
				if (!tool.isReadOnly && !prepared.approval && !(permissions.executionMode && prepared.independent)) {
					return failure('工具未提供操作预览，无法批准。');
				}
				if (prepared.approval && !await approve?.(prepared.approval, prepared.approvalIdentity)) {
					return failure(signal.aborted ? '任务已停止。' : TOOL_NOT_APPROVED);
				}
				signal.throwIfAborted();
				if (!permissions.canCallTool(tool)) return failure(`未授权使用工具：${call.name}`);
				const output = await prepared.run();
				const text = typeof output === 'string' ? output : output.content;
				// The tool's own cap runs first; the DSH inline budget then handles the surviving text.
				const limited = truncate(text, tool.maxResultSizeChars ?? 300_000);
				const content = boundToolResult(limited, tool.name);
				if (typeof output !== 'string' && 'shellStatus' in output) {
					return { callId: call.id, content, isError: output.shellStatus !== 'success', shellStatus: output.shellStatus };
				}
				return {
					callId: call.id, content, isError: false,
					fileRead: typeof output !== 'string' && 'fileRead' in output && content === text ? output.fileRead : undefined,
					...(typeof output !== 'string' && 'noteChange' in output && { noteChange: output.noteChange }),
				};
			} catch (error) {
				return failure(signal.aborted ? '任务已停止。' : truncate(error instanceof Error ? error.message : String(error), 2_000));
			}
		},
	};
}
