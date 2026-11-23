import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateOverflowTitle } from '../overflowTitle';

void test('a tooltip shows the full text only while the label is clipped', () => {
	const label = { textContent: '完整标题', clientWidth: 80, scrollWidth: 120, clientHeight: 20, scrollHeight: 20 };
	const button = { title: '' } as HTMLElement;
	updateOverflowTitle(button, label as Element);
	assert.equal(button.title, label.textContent);

	label.clientWidth = label.scrollWidth;
	updateOverflowTitle(button, label as Element);
	assert.equal(button.title, '');

	label.scrollHeight = 40;
	updateOverflowTitle(button, label as Element);
	assert.equal(button.title, label.textContent);
	updateOverflowTitle(button, null);
	assert.equal(button.title, '');
});
