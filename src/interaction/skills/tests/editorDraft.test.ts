import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManagedSkillLibrary } from '../../../skills/library/contracts';
import { SkillEditorSession } from '../editorDraft';

void test('edits made during a save use the new filename and the latest on-disk base', async () => {
	const calls: string[][] = [];
	let start: () => void = () => {};
	let finish: () => void = () => {};
	const started = new Promise<void>((resolve) => { start = resolve; });
	const gate = new Promise<void>((resolve) => { finish = resolve; });
	const library = { saveFile: async (name: string, path: string, value: string, expected: string) => {
		calls.push([name, path, value, expected]);
		if (calls.length === 1) { start(); await gate; }
		return 'renamed';
	} } as ManagedSkillLibrary;
	const editor = SkillEditorSession.open(library, 'original');
	editor.doc = { file: 'SKILL.md', original: 'a', text: 'a' };
	editor.edit('b');
	const writing = editor.flush();
	await started;
	editor.edit('c');
	finish();
	await writing;
	assert.deepEqual(calls, [['original', 'SKILL.md', 'b', 'a'], ['renamed', 'SKILL.md', 'c', 'b']]);
	assert.equal(editor.dirty, false);
	assert.notEqual(SkillEditorSession.open(library, 'renamed'), editor);
});

void test('conflicting edits survive leaving and reopening the editor', async () => {
	const library = { saveFile: () => Promise.reject(new Error('conflict')) } as unknown as ManagedSkillLibrary;
	const editor = SkillEditorSession.open(library, 'sample');
	editor.doc = { file: 'notes.md', original: 'old', text: 'old' };
	editor.edit('mine');
	await assert.rejects(editor.flush(), /conflict/);
	assert.equal(SkillEditorSession.open(library, 'sample').doc?.text, 'mine');
	SkillEditorSession.discard(library, 'sample');
	assert.equal(SkillEditorSession.open(library, 'sample').doc, undefined);
});
