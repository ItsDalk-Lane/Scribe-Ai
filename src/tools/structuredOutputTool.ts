import { Buffer } from 'node:buffer';
import type { Message, ToolModule } from '../types';

export const structuredOutputToolName = 'set_response_schema';

function responseSchema(input: unknown): Record<string, unknown> {
	const schema = (input as { schema?: unknown } | undefined)?.schema;
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)
		|| !('type' in schema) || schema.type !== 'object') throw new Error('请提供根类型为 object 的 JSON Schema。');
	if (Buffer.byteLength(JSON.stringify(schema)) > 16_384) throw new Error('JSON Schema 不能超过 16 KiB。');
	return schema;
}

export const structuredOutputTool: ToolModule = () => [{
	name: structuredOutputToolName,
	description: '需要最终答复为固定结构的 JSON 时，在其余资料和工具工作完成后调用一次。下一次回复按指定 JSON Schema 生成。',
	inputSchema: {
		type: 'object',
		properties: { schema: { type: 'object', description: 'JSON Schema。根类型为 object。每层对象列出 properties，将所有字段列入 required，并设置 additionalProperties 为 false。可空字段用 null 表示。' } },
		required: ['schema'],
		additionalProperties: false,
	},
	isReadOnly: true,
	prepare(input) {
		responseSchema(input);
		return { run: () => '已设置下一次答复的 JSON 结构。请按这个结构直接回答。' };
	},
}];

export function nextResponseSchema(messages: readonly Message[]): Record<string, unknown> | undefined {
	const succeeded = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const { role, local, incomplete, toolName, toolCallId, isError, skipped, toolCalls } = messages[index]!;
		if (role === 'tool' && toolName === structuredOutputToolName && toolCallId && !isError && !skipped) succeeded.add(toolCallId);
		if (role !== 'assistant' || local || incomplete) continue;
		const call = toolCalls?.filter(({ name, id }) => name === structuredOutputToolName && succeeded.has(id)).at(-1);
		return call && responseSchema(call.input);
	}
	return undefined;
}
