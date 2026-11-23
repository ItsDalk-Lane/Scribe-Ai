import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerBodyEdit, composerTargetPrefix, deleteSkillAtCaret, editSkillText, insertSkill, skillMentionParts } from '../components/skillMentionText';

void test('skill mention parts split chips and ignore invalid or overlapping ranges', () => {
	const parts = skillMentionParts('$alpha $beta', [
		{ id: 'a', name: 'alpha', start: 0, end: 6 },
		{ id: 'b', name: 'beta', start: 7, end: 12 },
		{ id: 'c', name: 'bad', start: 40, end: 60 },
		{ id: 'd', name: 'overlap', start: 3, end: 5 },
	]);
	assert.deepEqual(parts, [{ text: '$alpha', mention: true }, ' ', { text: '$beta', mention: true }]);
	assert.deepEqual(skillMentionParts('plain text'), ['plain text']);
});

void test('composer target labels stay outside editable task text and skill offsets', () => {
	const prefix = composerTargetPrefix({ kind: 'mcp', id: 'docs', label: '文档工具' });
	const body = '$format 整理笔记';
	assert.equal(prefix, '文档工具  ');
	assert.deepEqual(composerBodyEdit(prefix + body, prefix.length + 7, prefix),
		{ instruction: body, caret: 7, removedTarget: false });
	assert.deepEqual(composerBodyEdit('替换任务', 4, prefix),
		{ instruction: '替换任务', caret: 4, removedTarget: true });
	assert.deepEqual(composerBodyEdit('', 0, prefix), { instruction: '', caret: 0, removedTarget: true });
	assert.deepEqual(composerBodyEdit(body, 7, ''), { instruction: body, caret: 7, removedTarget: false });
});

void test('Backspace removes the selected skill at the caret, including its insertion space', () => {
	const draft = insertSkill({ instruction: '' }, 0, 0, { id: 'a', name: 'alpha' });
	assert.deepEqual(deleteSkillAtCaret(draft, draft.cursor), { instruction: '', cursor: 0 });
	assert.deepEqual(deleteSkillAtCaret(draft, 6), { instruction: ' ', cursor: 0 });
	assert.deepEqual(deleteSkillAtCaret(draft, 3), { instruction: ' ', cursor: 0 });
	assert.equal(deleteSkillAtCaret({ instruction: '$alpha ' }, 7), undefined);
	assert.equal(deleteSkillAtCaret(draft, 0), undefined);
});

void test('deleting a skill preserves nearby text and shifts other skill bindings', () => {
	const draft = { instruction: '用 $draw $draw 整理', skillMentions: [
		{ name: 'draw', id: 'first', start: 2, end: 7 },
		{ name: 'draw', id: 'second', start: 8, end: 13 },
	] };
	const deletion = deleteSkillAtCaret(draft, 8)!;
	assert.deepEqual(editSkillText(draft, deletion.instruction, deletion.cursor), {
		instruction: '用 $draw 整理',
		skillMentions: [{ name: 'draw', id: 'second', start: 2, end: 7 }],
	});
});
