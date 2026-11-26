import { obsidianSearchToolName } from '../tools/workspaceTools';
import { isAbsolute, resolve } from 'node:path';
import type { ToolCall } from '../types';

export type ToolKind = 'read' | 'search' | 'write' | 'edit' | 'notebook' | 'terminal' | 'generic';

export function toolKind(name: string): ToolKind {
	switch (name) {
		case 'Read': return 'read';
		case 'Write': return 'write';
		case 'Edit': return 'edit';
		case 'NotebookEdit': return 'notebook';
		case obsidianSearchToolName:
		case 'Glob':
		case 'web_search':
		case 'Grep': return 'search';
		case 'Bash':
		case 'PowerShell': return 'terminal';
		default: return 'generic';
	}
}

const targetFields: Record<ToolKind, readonly string[]> = {
	read: ['file_path'],
	write: ['file_path'],
	edit: ['file_path'],
	notebook: ['notebook_path'],
	search: ['path'],
	terminal: ['cwd'],
	generic: ['file_path', 'notebook_path', 'path', 'cwd'],
};

function field(input: unknown, key: string): unknown {
	if (input && typeof input === 'object' && !Array.isArray(input)
		&& Object.prototype.hasOwnProperty.call(input, key)) {
		return (input as Record<string, unknown>)[key];
	}
	return undefined;
}

export function toolTextField(input: unknown, key: string): string | undefined {
	const value = field(input, key);
	return typeof value === 'string' && value.trim() ? value : undefined;
}

export function toolTarget({ name, input }: ToolCall): { field: string; value: string } | undefined {
	for (const key of targetFields[toolKind(name)]) {
		const value = field(input, key);
		if (typeof value === 'string' && value.trim()) return { field: key, value };
	}
	return undefined;
}

export function actionTarget(call: ToolCall): string | undefined {
	return toolTarget(call)?.value;
}

export function toolHeadingTarget(call: ToolCall, vaultPath: string): string | undefined {
	if (call.name === 'web_search') return toolTextField(call.input, 'query');
	const kind = toolKind(call.name);
	if (kind === 'terminal') {
		const command = field(call.input, 'command');
		if (typeof command === 'string' && command.trim()) return command;
	}
	const path = actionTarget(call);
	const fullPath = path && (isAbsolute(path) ? path : resolve(vaultPath, path));
	if (kind !== 'search') return fullPath;
	const pattern = field(call.input, 'pattern');
	return [typeof pattern === 'string' && pattern.trim() ? pattern : undefined, fullPath].filter(Boolean).join(' · ') || undefined;
}

function serializeInput(input: unknown): string {
	try {
		return JSON.stringify(input, null, 2) ?? '';
	} catch {
		return '';
	}
}

export function formatToolInput({ name, input }: ToolCall): string {
	const command = toolKind(name) === 'terminal' ? field(input, 'command') : undefined;
	if (typeof command !== 'string') return serializeInput(input);
	const { command: _command, ...fields } = input as Record<string, unknown>;
	const details = serializeInput(fields);
	return details && details !== '{}' ? command + '\n\n' + details : command;
}

export function formatToolOutput(value: string): string {
	const start = value.trimStart()[0];
	if (start !== '{' && start !== '[') return value;
	try {
		JSON.parse(value);
	} catch {
		return value;
	}
	// 只调整 JSON 项之间的空白，保留大整数、重复键和原有转义。
	const tokens = /"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:]+/gu;
	let depth = 0;
	let previous = '';
	let formatted = '';
	const nextLine = () => '\n' + '  '.repeat(depth);
	for (const [token] of value.matchAll(tokens)) {
		if (token === '}' || token === ']') {
			depth--;
			if (previous !== '{' && previous !== '[') formatted += nextLine();
		} else if (previous === '{' || previous === '[' || previous === ',') {
			formatted += nextLine();
		} else if (previous === ':') {
			formatted += ' ';
		}
		formatted += token;
		if (token === '{' || token === '[') {
			depth++;
			// shortcut: 超过 32 层保留原文，若需要深层展开再改用逐层查看。
			if (depth > 32) return value;
		}
		previous = token;
	}
	return formatted;
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
