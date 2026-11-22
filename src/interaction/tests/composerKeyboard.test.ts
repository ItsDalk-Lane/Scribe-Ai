import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerShortcut, sideChatCommand } from '../composerKeyboard';
import { editSkillText, insertSkill, skillQuery, sliceSkillMentions } from '../components/skillMentionText';
import { bindSkillMentions } from '../../skills/mentions';

const key = (name: string, modifiers?: Partial<KeyboardEvent>) => ({
	key: name, isComposing: false, repeat: false,
	shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, keyCode: 0, ...modifiers,
});

void test('only unmodified Enter submits, without repeating or stealing IME confirmation', () => {
	assert.equal(composerShortcut(key('Enter')), 'send');
	assert.equal(composerShortcut(key('Enter', { repeat: true })), 'ignore');
	for (const modifiers of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }]) {
		assert.equal(composerShortcut(key('Enter', modifiers)), undefined);
	}
});

void test('the reference picker triggers at a word boundary but not inside a typed address or selection', () => {
	assert.equal(composerShortcut(key('@', { shiftKey: true }), '', 0), 'reference');
	assert.equal(composerShortcut(key('@'), '参考 ', 3), 'reference');
	assert.equal(composerShortcut(key('@'), 'mail', 4), undefined);
	assert.equal(composerShortcut(key('@'), '参考 正文', 3, 5), undefined);
	assert.equal(composerShortcut(key('@', { isComposing: true }), '', 0), undefined);
});

void test('Escape skips repeat, IME and modified presses', () => {
	assert.equal(composerShortcut(key('Escape')), 'escape');
	for (const modifiers of [{ repeat: true }, { isComposing: true }, { shiftKey: true }, { keyCode: 229 }]) {
		assert.equal(composerShortcut(key('Escape', modifiers)), undefined);
	}
});

void test('side chat recognizes a standalone slash command with an optional draft', () => {
	assert.equal(sideChatCommand(' /side '), '');
	assert.equal(sideChatCommand('/side  请解释\n这段文字'), '请解释\n这段文字');
	assert.equal(sideChatCommand('/sidebar'), null);
	assert.equal(sideChatCommand('请解释 /side'), null);
});

void test('selecting a skill replaces only the token at the cursor and records its source', () => {
	const draft = { instruction: '📔 ($edi) $later' };
	const query = skillQuery(draft.instruction, 7)!;
	assert.deepEqual(query, { start: 4, end: 8, query: 'edi' });
	const result = insertSkill(draft, query.start, query.end, { name: 'editor', id: 'folder-a', sourceLabel: '笔记库' });
	assert.equal(result.instruction, '📔 ($editor) $later');
	assert.deepEqual(result.skillMentions, [{ name: 'editor', id: 'folder-a', sourceLabel: '笔记库', start: 4, end: 11 }]);
	assert.equal(skillQuery('address$foo', 11), undefined);
});

void test('editing duplicate skill mentions preserves the unchanged occurrence and side-chat offsets', () => {
	const instruction = '/side $draw $draw';
	const skillMentions = [
		{ name: 'draw', id: 'first', start: 6, end: 11 },
		{ name: 'draw', id: 'second', start: 12, end: 17 },
	];
	const draft = { instruction, skillMentions };
	assert.equal(editSkillText(draft, '/side $draw', 6).skillMentions?.[0]?.id, 'second');
	assert.equal(editSkillText(draft, '/side $draw', 11).skillMentions?.[0]?.id, 'first');
	assert.deepEqual(editSkillText(draft, '/side $drawn $draw', 12).skillMentions, [{ ...skillMentions[1], start: 13, end: 18 }]);
	assert.deepEqual(sliceSkillMentions(draft, 6, 17), [
		{ name: 'draw', id: 'first', start: 0, end: 5 },
		{ name: 'draw', id: 'second', start: 6, end: 11 },
	]);
});

void test('typed skills bind to a unique enabled source and an existing binding cannot silently change source', () => {
	const draft = '用 $draw；然后 $edit.file。';
	const item = (name: string, id: string) => ({ name, id, sourceLabel: id, enabled: true, manual: true, implicit: true, description: '' });
	const items = [item('draw', '个人'), item('edit.file', '笔记库')];
	const explicit = bindSkillMentions(draft, [], items);
	assert.deepEqual(explicit.map((m) => [draft.slice(m.start, m.end), m.sourceLabel]), [['$draw', '个人'], ['$edit.file', '笔记库']]);
	const both = [...items, item('draw', '项目')];
	assert.throws(() => bindSkillMentions(draft, [], both), /选择来源/u);
	assert.deepEqual(bindSkillMentions(draft, explicit, both), explicit);
	assert.throws(() => bindSkillMentions(draft, explicit, both.slice(1)), /找不到/u);
	assert.deepEqual(bindSkillMentions('US$draw / $NOT_A_SKILL', [], both), []);
});
