import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { actionTarget, formatToolInput, formatToolOutput, toolHeadingTarget, toolKind, toolTarget, toolTextPreview } from '../toolCardDetails';

void test('tool categories keep their original top-level path lookup', () => {
	const input = { file_path: 'note.md', notebook_path: 'lab.ipynb', path: 'notes', cwd: 'root' };
	const tools = [
		['Read', 'read', 'file_path'], ['Write', 'write', 'file_path'], ['Edit', 'edit', 'file_path'],
		['NotebookEdit', 'notebook', 'notebook_path'], ['Glob', 'search', 'path'], ['Grep', 'search', 'path'],
		['Bash', 'terminal', 'cwd'], ['PowerShell', 'terminal', 'cwd'], ['constructor', 'generic', 'file_path'],
	] as const;
	for (const [name, kind, field] of tools) {
		const call = { id: '1', name, input };
		assert.equal(toolKind(name), kind);
		assert.deepEqual(toolTarget(call), { field, value: input[field] });
		assert.equal(actionTarget(call), input[field]);
	}
	const call = { id: '1', name: 'custom' };
	assert.deepEqual(toolTarget({ ...call, input: { file_path: ' ', path: ' notes ' } }), { field: 'path', value: ' notes ' });
	assert.equal(toolTarget({ ...call, input: { nested: input } }), undefined);
	assert.equal(toolTarget({ ...call, input: Object.create({ path: 'inherited' }) }), undefined);
	assert.equal(toolTarget({ ...call, name: 'Read', input: { path: 'unrelated' } }), undefined);
});

void test('tool arguments show raw fields and values with two-space indentation', () => {
	const input = { path: 'notes', pattern: '^Title', options: { glob: '*.md', limit: 0, enabled: false, empty: '' } };
	const call = { id: '1', name: 'Grep', input };
	const formatted = formatToolInput(call);
	assert.deepEqual(JSON.parse(formatted), input);
	assert.match(formatted, /\n {4}"limit": 0,\n/u);
	const cyclic = { path: 'notes', self: { } };
	cyclic.self = cyclic;
	assert.equal(formatToolInput({ ...call, input: cyclic }), '');
});

void test('headings use complete file paths and show the actual search or command', () => {
	const vault = resolve('vault');
	const absolute = join(vault, 'notes', '完整名称.md');
	const target = (name: string, input: unknown) => toolHeadingTarget({ id: '1', name, input }, vault);
	for (const name of ['Read', 'Write', 'Edit']) {
		assert.equal(target(name, { file_path: 'notes/完整名称.md' }), absolute);
		assert.equal(target(name, { file_path: absolute }), absolute);
	}
	assert.equal(target('NotebookEdit', { notebook_path: 'notes/lab.ipynb' }), join(vault, 'notes', 'lab.ipynb'));
	assert.equal(target('Grep', { pattern: '^Title', path: 'notes' }), '^Title · ' + join(vault, 'notes'));
	assert.equal(target('Glob', { pattern: '*.md' }), '*.md');
	assert.equal(target('Bash', { command: 'printf hello', cwd: 'notes', description: 'Sample' }), 'printf hello');
	assert.equal(target('PowerShell', { cwd: 'notes' }), join(vault, 'notes'));
	assert.equal(target('Unknown', {}), undefined);
});

void test('shell arguments keep the complete script and other original parameters together', () => {
	const command = '  printf "hello"\r\nprintf "world"';
	const fields = { cwd: 'notes', timeoutMs: 0, description: '' };
	for (const name of ['Bash', 'PowerShell']) {
		const call = { id: '1', name, input: { command } };
		assert.equal(formatToolInput(call), command);
		assert.equal(formatToolInput({ ...call, input: { ...fields, command } }), command + '\n\n' + JSON.stringify(fields, null, 2));
		assert.equal(formatToolInput({ ...call, input: { command: 42 } }), '{\n  "command": 42\n}');
	}
});

void test('output indentation changes whitespace only and leaves plain text untouched', () => {
	const plain = ' {"message":"partial"}\r\nmore text\t \n';
	for (const output of [plain, '  results\t\r\nnext  \n', '', '42', '"text"']) assert.equal(formatToolOutput(output), output);

	const raw = ' {"x":90071992547409993, "x": ["a\\u0020b", {}, [], -3e+04, null]} \n';
	assert.equal(formatToolOutput(raw), [
		'{', '  "x": 90071992547409993,', '  "x": [', '    "a\\u0020b",', '    {},', '    [],',
		'    -3e+04,', '    null', '  ]', '}',
	].join('\n'));
	assert.equal(formatToolOutput(' [true, false] '), '[\n  true,\n  false\n]');
	const deep = '['.repeat(33) + '"leaf"' + ']'.repeat(33);
	assert.equal(formatToolOutput(deep), deep);
});

void test('preview leaves fitting text alone and clips after eight lines', () => {
	assert.equal(toolTextPreview(''), null);
	for (const ending of ['\n', '\r\n', '\r']) {
		const eightLines = Array.from({ length: 8 }, (_, index) => ` ${index + 1} `).join(ending);
		assert.equal(toolTextPreview(eightLines), null);
		assert.equal(toolTextPreview(eightLines + ending), null);
		assert.equal(toolTextPreview(eightLines + ending + 'line nine'), eightLines);
	}
	assert.equal(toolTextPreview('\n'.repeat(9)), '\n'.repeat(7));
});

void test('preview respects the character limit without splitting an emoji or CRLF', () => {
	const prefix = 'a'.repeat(1599);
	assert.equal(toolTextPreview(prefix + 'b'), null);
	assert.equal(toolTextPreview(prefix + 'bc'), prefix + 'b');
	assert.equal(toolTextPreview(prefix + '📝'), prefix);
	assert.equal(toolTextPreview(prefix.slice(1) + '📝b'), prefix.slice(1) + '📝');
	assert.equal(toolTextPreview(prefix + '\r\nb'), prefix);
	assert.equal(toolTextPreview('short\n'.repeat(8) + prefix), 'short\n'.repeat(7) + 'short');
});
