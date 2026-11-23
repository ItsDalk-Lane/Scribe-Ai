import type { ToolCall } from '../../types';
import { isMcpToolName, toolExecutionInput } from './toolInput';

export function toolSignature({ name, input }: ToolCall): string {
	return JSON.stringify([name, isMcpToolName(name) ? input : toolExecutionInput(input)], (_key, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
		const fields = value as Record<string, unknown>;
		return Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]]));
	});
}
