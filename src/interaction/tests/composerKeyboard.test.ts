import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerShortcut } from '../composerKeyboard';

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
