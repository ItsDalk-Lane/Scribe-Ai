import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyableMarkdownParts } from '../slashCopy';

void test('copy separates quotes from fenced code and accepts a longer closing fence', () => {
	const rendered = ['> 第一条', '> 紧接着', '```text', '> 代码内的符号', '~~~', '````', '', '> 第二条'].join('\r\n');
	assert.deepEqual(copyableMarkdownParts(rendered), {
		snippets: ['> 代码内的符号\r\n~~~'], quotes: ['第一条\r\n紧接着', '第二条'],
	});
});

void test('copy keeps unclosed fenced code separate from quotes until the end', () => {
	assert.deepEqual(copyableMarkdownParts('> 摘录\n\n~~~~ text\n~~~\n> 这仍是代码'), {
		snippets: ['~~~\n> 这仍是代码'], quotes: ['摘录'],
	});
});
