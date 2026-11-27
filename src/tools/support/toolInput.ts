import type { ToolSpec } from '../../types';

export function isDirectMcpToolName(name: string): boolean {
	return name.startsWith('mcp__');
}

export function withToolIntent({ name, description, inputSchema }: ToolSpec): ToolSpec {
	if (inputSchema.type !== 'object') return { name, description, inputSchema };
	return { name, description, inputSchema: {
		...inputSchema,
		properties: {
			...(inputSchema.properties as Record<string, unknown> | undefined),
			intent: { type: 'string', minLength: 1, maxLength: 48, description: '显示给用户的简体中文短句，说明这次调用具体要核对或完成什么。' },
		},
		required: [...(Array.isArray(inputSchema.required) ? inputSchema.required as string[] : []), 'intent'],
	} };
}

export function toolExecutionInput(input: unknown): unknown {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
	if (!Object.prototype.hasOwnProperty.call(input, 'intent') && !Object.prototype.hasOwnProperty.call(input, 'i')) return input;
	const args = { ...input } as Record<string, unknown>;
	delete args.intent;
	delete args.i;
	return args;
}
