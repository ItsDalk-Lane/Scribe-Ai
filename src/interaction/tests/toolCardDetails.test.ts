import assert from 'node:assert/strict';
import test from 'node:test';
import { actionTarget, toolCardDetails, toolTextPreview } from '../toolCardDetails';

void test('Read uses its file path and validates the requested range', () => {
	const call = { id: '1', name: 'Read', input: { file_path: 'notes.md', offset: 0, limit: 3 } };
	assert.equal(actionTarget(call), 'notes.md');
	assert.deepEqual(toolCardDetails(call), { kind: 'read', target: 'notes.md', offset: 0, limit: 3 });

	const noRange = { kind: 'read', target: undefined, offset: undefined, limit: undefined };
	assert.deepEqual(toolCardDetails({ ...call, input: { file_path: ' ', path: 'other.md', offset: '0', limit: 0 } }), noRange);
	for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		assert.deepEqual(toolCardDetails({ ...call, input: { offset: value, limit: value } }), noRange);
	}
	assert.deepEqual(toolCardDetails({ ...call, input: null }), noRange);
});

void test('terminal cards use the command, explicit working directory and description', () => {
	for (const name of ['Bash', 'PowerShell']) {
		const call = { id: '1', name, input: { command: '  whoami\n', cwd: 'notes', description: 'Show user', file_path: 'unrelated' } };
		assert.equal(actionTarget(call), 'notes');
		assert.deepEqual(toolCardDetails(call), { kind: 'terminal', target: 'notes', command: '  whoami\n', description: 'Show user' });
		assert.deepEqual(toolCardDetails({ ...call, input: { command: 'whoami', description: 10 } }), {
			kind: 'terminal', target: undefined, command: 'whoami', description: undefined,
		});
	}
});

void test('search cards use the search path, with a file filter only for Grep', () => {
	const input = { path: 'notes', pattern: '*.md', glob: '*.txt', file_path: 'unrelated' };
	assert.deepEqual(toolCardDetails({ id: '1', name: 'Glob', input }), {
		kind: 'search', target: 'notes', pattern: '*.md', glob: undefined,
	});
	assert.deepEqual(toolCardDetails({ id: '1', name: 'Grep', input: { ...input, pattern: '^Title' } }), {
		kind: 'search', target: 'notes', pattern: '^Title', glob: '*.txt',
	});
	assert.deepEqual(toolCardDetails({ id: '1', name: 'Grep', input: { path: 0, pattern: false, glob: ' ' } }), {
		kind: 'search', target: undefined, pattern: undefined, glob: undefined,
	});
});

void test('file changes keep empty and whitespace-only text', () => {
	assert.deepEqual(toolCardDetails({ id: '1', name: 'Write', input: { file_path: 'note.md', content: '' } }), {
		kind: 'write', target: 'note.md', content: '',
	});
	assert.deepEqual(toolCardDetails({ id: '1', name: 'Edit', input: { file_path: 'note.md', old_string: '', new_string: ' \n' } }), {
		kind: 'edit', target: 'note.md', before: '', after: ' \n',
	});
	assert.deepEqual(toolCardDetails({ id: '1', name: 'Edit', input: { old_string: [], new_string: '' } }), {
		kind: 'edit', target: undefined, before: undefined, after: '',
	});
});

void test('NotebookEdit accepts declared modes and leaves missing metadata unset', () => {
	const call = { id: '1', name: 'NotebookEdit' };
	for (const mode of ['replace', 'insert', 'delete']) {
		assert.deepEqual(toolCardDetails({ ...call, input: { notebook_path: 'lab.ipynb', file_path: 'unrelated', cell_id: 'cell-0', edit_mode: mode, new_source: '' } }), {
			kind: 'notebook', target: 'lab.ipynb', cellId: 'cell-0', mode, source: '',
		});
	}
	const input = { notebook_path: 'lab.ipynb' };
	const details = { kind: 'notebook', target: 'lab.ipynb', cellId: undefined, mode: undefined, source: undefined };
	assert.deepEqual(toolCardDetails({ ...call, input }), details);
	assert.deepEqual(toolCardDetails({ ...call, input: { ...input, cell_id: '', edit_mode: 'rename', new_source: [] } }), details);
});

void test('unknown tools keep explicit path fields and serialize their input', () => {
	const call = { id: '1', name: 'constructor' };
	const input = { path: 'notes', nested: { file_path: 'unrelated' } };
	assert.deepEqual(toolCardDetails({ ...call, input }), { kind: 'generic', target: 'notes', input: JSON.stringify(input, null, 2) });
	assert.deepEqual(toolCardDetails({ ...call, input: 'notes' }), { kind: 'generic', target: undefined, input: '"notes"' });
	assert.equal(actionTarget({ ...call, input: { nested: input } }), undefined);
	assert.equal(actionTarget({ ...call, input: Object.create({ path: 'inherited' }) }), undefined);
	const cyclic = { path: 'notes', self: { } };
	cyclic.self = cyclic;
	assert.deepEqual(toolCardDetails({ ...call, input: cyclic }), { kind: 'generic', target: 'notes', input: undefined });
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
