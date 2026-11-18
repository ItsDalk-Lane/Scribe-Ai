import type { ToolCall } from '../types';

type NotebookMode = 'replace' | 'insert' | 'delete';

export type ToolCardDetails = { target?: string } & (
	| { kind: 'read'; offset?: number; limit?: number }
	| { kind: 'terminal'; command?: string; description?: string }
	| { kind: 'search'; pattern?: string; glob?: string }
	| { kind: 'write'; content?: string }
	| { kind: 'edit'; before?: string; after?: string }
	| { kind: 'notebook'; cellId?: string; mode?: NotebookMode; source?: string }
	| { kind: 'generic'; input?: string }
);

function field(input: unknown, key: string): unknown {
	if (input && typeof input === 'object' && !Array.isArray(input)
		&& Object.prototype.hasOwnProperty.call(input, key)) {
		return (input as Record<string, unknown>)[key];
	}
	return undefined;
}

function textField(input: unknown, key: string, allowEmpty = false): string | undefined {
	const value = field(input, key);
	return typeof value === 'string' && (allowEmpty || value.trim()) ? value : undefined;
}

function integerField(input: unknown, key: string, minimum: number): number | undefined {
	const value = field(input, key);
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

export function actionTarget({ name, input }: ToolCall): string | undefined {
	switch (name) {
		case 'Read':
		case 'Write':
		case 'Edit':
			return textField(input, 'file_path');
		case 'NotebookEdit':
			return textField(input, 'notebook_path');
		case 'Glob':
		case 'Grep':
			return textField(input, 'path');
		case 'Bash':
		case 'PowerShell':
			return textField(input, 'cwd');
		default:
			return textField(input, 'file_path') ?? textField(input, 'notebook_path')
				?? textField(input, 'path') ?? textField(input, 'cwd');
	}
}

function serializeInput(input: unknown): string | undefined {
	try {
		return JSON.stringify(input, null, 2);
	} catch {
		return undefined;
	}
}

export function toolCardDetails(call: ToolCall): ToolCardDetails {
	const { name, input } = call;
	const target = actionTarget(call);
	switch (name) {
		case 'Read':
			return { kind: 'read', target, offset: integerField(input, 'offset', 0), limit: integerField(input, 'limit', 1) };
		case 'Bash':
		case 'PowerShell':
			return { kind: 'terminal', target, command: textField(input, 'command'), description: textField(input, 'description') };
		case 'Glob':
		case 'Grep':
			return { kind: 'search', target, pattern: textField(input, 'pattern'), glob: name === 'Grep' ? textField(input, 'glob') : undefined };
		case 'Write':
			return { kind: 'write', target, content: textField(input, 'content', true) };
		case 'Edit':
			return { kind: 'edit', target, before: textField(input, 'old_string', true), after: textField(input, 'new_string', true) };
		case 'NotebookEdit': {
			const mode = field(input, 'edit_mode');
			return {
				kind: 'notebook', target, cellId: textField(input, 'cell_id'),
				mode: mode === 'replace' || mode === 'insert' || mode === 'delete' ? mode : undefined,
				source: textField(input, 'new_source', true),
			};
		}
		default:
			return { kind: 'generic', target, input: serializeInput(input) };
	}
}

export function toolTextPreview(value: string): string | null {
	const maxChars = 1600;
	const maxLines = 8;
	let end = Math.min(value.length, maxChars);
	let lines = 1;
	for (const lineBreak of value.slice(0, maxChars + 1).matchAll(/\r\n?|\n/gu)) {
		if (lines++ < maxLines) continue;
		if (lineBreak.index + lineBreak[0].length < value.length) end = Math.min(end, lineBreak.index);
		break;
	}
	if (end === value.length) return null;
	// 截断时保留完整的换行和字符。
	if (value.startsWith('\r\n', end - 1) || (value.codePointAt(end - 1) ?? 0) > 0xffff) end--;
	return value.slice(0, end);
}
