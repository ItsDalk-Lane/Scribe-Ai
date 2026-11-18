import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { ToolModule } from '../types';
import { fileToolInput, prepareFileChange, requiredText } from './support/fileAccess';

const stringProperty = { type: 'string' };
export const editTextNotFound = '文件中没有找到要替换的文本。';

export const writeTools: ToolModule = () => [{
	name: 'Write',
	description: 'Create or overwrite a UTF-8 text file in an existing folder. Before overwriting, read all lines of the current file with Read. Use smaller pages if output was truncated. For local changes use Edit. Each write requires approval.',
	inputSchema: {
		type: 'object',
		properties: { file_path: stringProperty, content: stringProperty },
		required: ['file_path', 'content'],
		additionalProperties: false,
	},
	isReadOnly: false,
	prepare(input, ctx) {
		const args = fileToolInput(input, ['file_path', 'content']);
		const path = requiredText(args, 'file_path');
		const content = requiredText(args, 'content', true);
		return prepareFileChange(ctx, path, (_before, requireFullRead) => {
			requireFullRead();
			return content;
		}, { allowMissing: true });
	},
}, {
	name: 'Edit',
	description: 'Replace an exact text fragment. Read the file first. The fragment must occur exactly once unless replace_all is true. Each edit requires approval.',
	inputSchema: {
		type: 'object',
		properties: {
			file_path: stringProperty,
			old_string: stringProperty,
			new_string: stringProperty,
			replace_all: { type: 'boolean', default: false },
		},
		required: ['file_path', 'old_string', 'new_string'],
		additionalProperties: false,
	},
	isReadOnly: false,
	prepare(input, ctx) {
		const args = fileToolInput(input, ['file_path', 'old_string', 'new_string', 'replace_all']);
		const path = requiredText(args, 'file_path');
		const oldText = requiredText(args, 'old_string', true);
		const newText = requiredText(args, 'new_string', true);
		if (args.replace_all !== undefined && typeof args.replace_all !== 'boolean') throw new Error('参数 replace_all 必须是布尔值。');
		return prepareFileChange(ctx, path, (before, requireFullRead) =>
			editText(before ?? '', oldText, newText, args.replace_all === true, requireFullRead), { allowMissing: oldText === '' });
	},
}, {
	name: 'NotebookEdit',
	description: 'Replace, insert, or delete a Jupyter notebook cell. Read the notebook first. Use its cell ID or cell-N for legacy cells without IDs, where N is a zero-based position. Insertion without an ID goes at the beginning. Each change requires approval.',
	inputSchema: {
		type: 'object',
		properties: {
			notebook_path: stringProperty,
			cell_id: stringProperty,
			new_source: stringProperty,
			cell_type: { type: 'string', enum: ['code', 'markdown'] },
			edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], default: 'replace' },
		},
		required: ['notebook_path'],
		additionalProperties: false,
	},
	isReadOnly: false,
	prepare(input, ctx) {
		const args = fileToolInput(input, ['notebook_path', 'cell_id', 'new_source', 'cell_type', 'edit_mode']);
		const path = requiredText(args, 'notebook_path');
		if (extname(path).toLowerCase() !== '.ipynb') throw new Error('请选择 .ipynb 格式的 Jupyter 笔记本。');
		const mode = args.edit_mode === undefined ? 'replace' : args.edit_mode;
		if (mode !== 'replace' && mode !== 'insert' && mode !== 'delete') throw new Error('参数 edit_mode 无效。');
		const id = mode === 'insert' && args.cell_id === undefined ? undefined : requiredText(args, 'cell_id');
		const source = mode === 'delete' && args.new_source === undefined ? '' : requiredText(args, 'new_source', true);
		const type = args.cell_type;
		if ((type !== undefined || mode === 'insert') && type !== 'code' && type !== 'markdown') throw new Error('参数 cell_type 必须是 code 或 markdown。');
		return prepareFileChange(ctx, path, (before) => editNotebook(before ?? '', mode, id, source, type));
	},
}];

function editText(text: string, oldText: string, newText: string, replaceAll: boolean, requireFullRead: () => void): string {
	if (oldText === newText) throw new Error('替换前后的文本相同。');
	if (!oldText) {
		if (text) throw new Error('只有空文件才可使用空的 old_string。');
		requireFullRead();
		return newText;
	}
	if (text.includes('\r\n') && !text.replaceAll('\r\n', '').includes('\n')) {
		oldText = oldText.replace(/\r?\n/g, '\r\n');
		newText = newText.replace(/\r?\n/g, '\r\n');
	}
	const start = text.indexOf(oldText);
	if (start === -1) throw new Error(editTextNotFound);
	if (start === 0 && (oldText.length === text.length || (replaceAll && !text.replaceAll(oldText, '')))) requireFullRead();
	if (replaceAll) return text.replaceAll(oldText, () => newText);
	if (text.indexOf(oldText, start + 1) !== -1) throw new Error('要替换的文本出现多次，请提供更具体的内容或使用 replace_all。');
	return text.slice(0, start) + newText + text.slice(start + oldText.length);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function editNotebook(
	text: string,
	mode: 'replace' | 'insert' | 'delete',
	id: string | undefined,
	source: string,
	type: 'code' | 'markdown' | undefined,
): string {
	const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
	let notebook: unknown;
	try {
		notebook = JSON.parse(text.slice(bom.length));
	} catch {
		throw new Error('无法解析 Jupyter 笔记本。');
	}
	if (!isObject(notebook) || notebook.nbformat !== 4 || typeof notebook.nbformat_minor !== 'number'
		|| !Array.isArray(notebook.cells) || !notebook.cells.every(isObject)) {
		throw new Error('这不是有效的第 4 版 Jupyter 笔记本。');
	}
	const cells: Record<string, unknown>[] = notebook.cells;
	const exact = id === undefined ? -1 : cells.findIndex((cell) => cell.id === id);
	const index = exact >= 0 || id === undefined ? exact
		: cells.findIndex((cell, position) => cell.id === undefined && id === `cell-${position}`);
	if (id !== undefined && index < 0) throw new Error('找不到指定的 Jupyter 单元格。');
	if (mode === 'insert') {
		const cell: Record<string, unknown> = { cell_type: type, metadata: {}, source: splitSource(source) };
		if (notebook.nbformat_minor >= 5) cell.id = randomUUID();
		if (type === 'code') Object.assign(cell, { execution_count: null, outputs: [] });
		cells.splice(index + 1, 0, cell);
	} else if (mode === 'delete') {
		cells.splice(index, 1);
	} else {
		const cell = cells[index];
		if (!cell) throw new Error('找不到指定的 Jupyter 单元格。');
		cell.cell_type = type ?? cell.cell_type;
		cell.source = typeof cell.source === 'string' ? source : splitSource(source);
		if (cell.cell_type === 'code') Object.assign(cell, { execution_count: null, outputs: [] });
		else {
			delete cell.execution_count;
			delete cell.outputs;
		}
	}
	const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? ' ';
	const ending = text.includes('\r\n') ? '\r\n' : '\n';
	const serialized = JSON.stringify(notebook, null, indent).replaceAll('\n', ending);
	return bom + serialized + (text.endsWith('\n') ? ending : '');
}

function splitSource(source: string): string[] {
	return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
