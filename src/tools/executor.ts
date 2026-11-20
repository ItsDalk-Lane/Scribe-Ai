import { truncate } from './support/truncate';
import { toolExecutionInput } from './support/toolInput';
import type { ToolExecutor, ToolRegistry } from '../types';

/** 执行前校验、取得授权，再返回可直接配对的工具结果。 */
export function createToolExecutor(registry: ToolRegistry): ToolExecutor {
	return {
		execute: async (call, ctx) => {
			const { signal, approve, permissions } = ctx;
			const failure = (content: string) => ({ callId: call.id, content, isError: true });
			try {
				signal.throwIfAborted();
				const tool = registry.find(call.name);
				if (!tool) return failure(`工具不可用：${call.name}`);
				if (!permissions.canCallTool(tool)) return failure(`未授权使用工具：${call.name}`);
				const prepared = await tool.prepare(toolExecutionInput(call.input), ctx);
				signal.throwIfAborted();
				if (!tool.isReadOnly && !prepared.approval) return failure('工具未提供操作预览，无法批准。');
				if (prepared.approval && !await approve?.(prepared.approval)) {
					return failure(signal.aborted ? '任务已停止。' : '用户未批准本次操作。');
				}
				signal.throwIfAborted();
				if (!permissions.canCallTool(tool)) return failure(`未授权使用工具：${call.name}`);
				const output = await prepared.run();
				const text = typeof output === 'string' ? output : output.content;
				const content = truncate(text, tool.maxResultSizeChars ?? 12_000);
				return {
					callId: call.id, content, isError: false,
					fileRead: typeof output !== 'string' && content === text ? output.fileRead : undefined,
				};
			} catch (error) {
				return failure(signal.aborted ? '任务已停止。' : truncate(error instanceof Error ? error.message : String(error), 2_000));
			}
		},
	};
}
