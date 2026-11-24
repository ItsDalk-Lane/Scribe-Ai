import { truncate } from './support/truncate';
import { Buffer } from 'node:buffer';
import { scribeDataPaths } from '../orchestration/storage/paths';
import { MAX_IMAGES, MAX_REQUEST_IMAGE_BYTES, saveCachedImage } from './support/imageData';
import { boundToolResult } from './support/resultSpill';
import { toolExecutionInput } from './support/toolInput';
import { TOOL_NOT_APPROVED } from '../types';
import type { ImageReference, ToolExecutor, ToolRegistry } from '../types';

/** 执行前校验、取得授权，再返回可直接配对的工具结果。 */
export function createToolExecutor(registry: ToolRegistry, cacheDirectory?: string): ToolExecutor {
	return {
		execute: async (call, ctx) => {
			const { signal, approve, permissions, retryApproval } = ctx;
			const failure = (content: string) => ({ callId: call.id, content, isError: true });
			try {
				signal.throwIfAborted();
				const tool = registry.find(call.name);
				if (!tool) return failure(`工具不可用：${call.name}`);
				if (!permissions.canCallTool(tool)) return failure(`未授权使用工具：${call.name}`);
				if (tool.mcp && !ctx.mcpRun?.canInvoke(tool)) return failure('MCP 工具尚未加载或定义已变化。');
				const prepared = await tool.prepare(tool.mcp ? call.input : toolExecutionInput(call.input), ctx);
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
				let text = typeof output === 'string' ? output : output.content;
				const imageRefs: ImageReference[] = [];
				if (typeof output !== 'string' && 'images' in output && output.images?.length && !output.isError) {
					signal.throwIfAborted();
					const location = { cacheDirectory: cacheDirectory ?? scribeDataPaths(ctx.cwd).cache,
						conversationId: ctx.task.request.conversationId, subagentId: ctx.subagentId };
					let available = MAX_REQUEST_IMAGE_BYTES;
					for (const image of output.images.slice(0, MAX_IMAGES)) {
						const size = Buffer.byteLength(image.data, 'base64');
						if (size > available) break;
						try {
							const path = await saveCachedImage(ctx.cwd, location, Buffer.from(image.data, 'base64'), 'image');
							imageRefs.push({ kind: 'tool', path });
							available -= size;
						} catch { /* Keep the text result even if an image cannot be cached. */ }
						signal.throwIfAborted();
					}
					if (imageRefs.length !== output.images.length) text += '\n部分图片过大、格式无效或无法保存，未能作为图片交付。';
				}
				// The tool's own cap runs first; the DSH inline budget then handles the surviving text.
				const limited = truncate(text, tool.maxResultSizeChars ?? 300_000);
				const content = boundToolResult(limited, tool.name, cacheDirectory ? {
					cacheDirectory, conversationId: ctx.task.request.conversationId, subagentId: ctx.subagentId,
				} : undefined);
				if (typeof output !== 'string' && 'shellStatus' in output) {
					return { callId: call.id, content, isError: output.shellStatus !== 'success', shellStatus: output.shellStatus };
				}
				return {
					callId: call.id, content, isError: typeof output !== 'string' && 'isError' in output && output.isError === true,
					fileRead: typeof output !== 'string' && 'fileRead' in output && content === text ? output.fileRead : undefined,
					...(typeof output !== 'string' && 'noteChange' in output && { noteChange: output.noteChange }),
					...(imageRefs.length && { imageRefs }),
				};
			} catch (error) {
				return failure(signal.aborted ? '任务已停止。' : truncate(error instanceof Error ? error.message : String(error), 2_000));
			}
		},
	};
}
