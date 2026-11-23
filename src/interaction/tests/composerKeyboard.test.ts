import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerShortcut, referenceQuery, removeReferenceQuery, sideChatCommand } from '../composerKeyboard';
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

void test('inline reference queries use the last same-line marker and accept names with spaces', () => {
	assert.equal(composerShortcut(key('@', { shiftKey: true })), undefined);
	assert.deepEqual(referenceQuery('@', 1), { start: 0, end: 1, term: '' });
	const text = '参考 @甲\n最近 @项目 计划';
	assert.deepEqual(referenceQuery(text, text.length), { start: text.lastIndexOf('@'), end: text.length, term: '项目 计划' });
	for (const body of ['name@example.com', '@研究\n正文', '@研究 $', '@研究 $skill']) {
		assert.equal(referenceQuery(body, body.length), undefined, body);
	}
});

void test('selecting an inline reference removes its query and preserves the rest of the draft', () => {
	const before = '第一行\n前文 ';
	const token = '@项目 计划';
	const text = before + token + ' 后文\n第三行';
	const query = referenceQuery(text, before.length + token.length)!;
	assert.deepEqual(removeReferenceQuery(text, query), { instruction: before + '后文\n第三行', caret: before.length });
	assert.deepEqual(removeReferenceQuery('@名字  正文', { start: 0, end: 3 }), { instruction: ' 正文', caret: 0 });
	assert.deepEqual(removeReferenceQuery('前文 @名字\n正文', { start: 3, end: 6 }), { instruction: '前文 \n正文', caret: 3 });
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
