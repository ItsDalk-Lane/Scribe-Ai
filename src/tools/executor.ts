import { truncate } from './support/truncate';
import { Buffer } from 'node:buffer';
import { isGeneratedMediaCachePath, isGeneratedVideoJobId, scribeDataPaths } from '../orchestration/storage/paths';
import { resolveGeneratedMediaPath } from '../orchestration/storage/generatedMedia';
import { MAX_IMAGES, MAX_REQUEST_IMAGE_BYTES, saveCachedImage } from './support/imageData';
import { boundToolResult } from './support/resultSpill';
import { isDirectMcpToolName, toolExecutionInput } from './support/toolInput';
import { isChatTaskMutation } from './chatTaskTools';
import { isPlanMutation } from './planTools';
import { TOOL_NOT_APPROVED } from '../types';
import type { ImageReference, PreparedTool, ToolCall, ToolContext, ToolExecutor, ToolRegistry, ToolResult } from '../types';
import { readTool } from './readTools';
import { isWithinPath, toolAbsolutePath } from './support/pathUtils';

/** 执行前校验、取得授权，再返回可直接配对的工具结果。 */
export function createToolExecutor(registry: ToolRegistry, cacheDirectory?: string): ToolExecutor {
	const executor = {
		async execute(call: ToolCall, ctx: ToolContext, ready?: PreparedTool): Promise<ToolResult> {
			const { signal, approve, permissions, retryApproval } = ctx;
			const failure = (content: string) => ({ callId: call.id, content, isError: true });
			try {
				signal.throwIfAborted();
				const tool = registry.find(call.name);
				if (!tool || (ready && tool !== readTool)) return failure(`工具不可用：${call.name}`);
				if (!permissions.canCallTool(tool)) return failure(`未授权使用工具：${call.name}`);
				if (tool.mcp && !ctx.mcpRun?.canInvoke(tool)) return failure('MCP 工具尚未加载或定义已变化。');
				const prepared = ready ?? await tool.prepare(isDirectMcpToolName(call.name) ? call.input : toolExecutionInput(call.input),
					{ ...ctx, toolCallId: call.id });
				signal.throwIfAborted();
				if (retryApproval && (!prepared.approval || prepared.approvalIdentity !== retryApproval.identity
					|| JSON.stringify(prepared.approval) !== JSON.stringify(retryApproval.approval))) {
					return failure('操作预览或工作目录已变化，请重新提交任务。');
				}
				const needsPreview = !tool.isReadOnly && !(prepared.independent && (permissions.executionMode || isChatTaskMutation(tool) || isPlanMutation(tool)));
				if (needsPreview && !prepared.approval) {
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
				const content = boundToolResult(text, tool.name, cacheDirectory ? {
					cacheDirectory, conversationId: ctx.task.request.conversationId, subagentId: ctx.subagentId,
				} : undefined, tool.maxResultSizeChars ?? 300_000);
				if (typeof output !== 'string' && 'shellStatus' in output) {
					return { callId: call.id, content, isError: output.shellStatus !== 'success', shellStatus: output.shellStatus };
				}
				const isError = typeof output !== 'string' && 'isError' in output && output.isError === true;
				const generatedMedia = !isError && typeof output !== 'string' && 'generatedMedia' in output ? output.generatedMedia : undefined;
				if (generatedMedia?.length) {
					for (const media of generatedMedia) {
						await resolveGeneratedMediaPath(ctx.cwd, ctx.app.vault.configDir, media);
						if (isGeneratedMediaCachePath(media.path)
							&& !isGeneratedMediaCachePath(media.path, ctx.task.request.conversationId, ctx.subagentId)) {
								throw new Error('生成文件不属于当前任务。');
						}
					}
					signal.throwIfAborted();
				}
				const jobId = typeof output !== 'string' && 'generatedVideoJobId' in output ? output.generatedVideoJobId : undefined;
				return {
					callId: call.id, content, isError,
					fileRead: typeof output !== 'string' && 'fileRead' in output && content === text ? output.fileRead : undefined,
					...(typeof output !== 'string' && 'noteChange' in output && { noteChange: output.noteChange }),
					...(imageRefs.length && { imageRefs }),
					...(generatedMedia?.length && { generatedMedia }),
					...(isGeneratedVideoJobId(jobId) && { generatedVideoJobId: jobId }),
				};
			} catch (error) {
				return failure(signal.aborted ? '任务已停止。' : truncate(error instanceof Error ? error.message : String(error), 2_000));
			}
		},
		async prepareParallelReads(calls, ctx) {
			if (calls.length < 2 || registry.find(readTool.name) !== readTool || !ctx.permissions.canCallTool(readTool)) return;
			for (const call of calls) {
				const file = (call.input as { file_path?: unknown } | null)?.file_path;
				if (call.name !== readTool.name || typeof file !== 'string' || !file.toLowerCase().endsWith('.md')
					|| /^https?:\/\//iu.test(file)) return;
				try {
					const path = toolAbsolutePath(ctx.cwd, file);
					if (!isWithinPath(ctx.cwd, path) || !ctx.permissions.canRead(path)) return;
				} catch { return; }
			}
			const files = new Set<string>();
			const reads: Array<() => Promise<ToolResult>> = [];
			for (const call of calls) {
				const prepared = await readTool.prepare(toolExecutionInput(call.input), ctx, true).catch(() => undefined);
				ctx.signal.throwIfAborted();
				const key = prepared?.parallelReadKey;
				if (!key || files.has(key)) return;
				files.add(key);
				reads.push(() => executor.execute(call, ctx, prepared));
			}
			return reads;
		},
	} satisfies ToolExecutor;
	return executor;
}
