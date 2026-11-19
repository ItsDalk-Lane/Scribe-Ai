import assert from 'node:assert/strict';
import test from 'node:test';

import type { Vault } from 'obsidian';
import { splitMarkdownBlocks } from '../markdownBlocks';
import { resolveInlineNote } from '../noteCitations';

function blocks(text: string): string[] {
	return splitMarkdownBlocks(text).map(block => block.text);
}

void test('preserves blank lines and matches fence character, length and closing suffix', () => {
	const code = '````js\nconst first = 1;\n\n```\n\n~~~~\n\n````suffix\n\nconst next = 2;\n`````';
	assert.deepEqual(blocks(`${code}\n\nAfter`), [code, 'After']);
	const tilde = '~~~js\na()\n\nb()\n~~~  ';
	assert.deepEqual(blocks(`Before\n\n${tilde}`), ['Before', tilde]);
});

void test('keeps an unfinished fence and its trailing blanks together', () => {
	const code = '```js\nconst first = 1;\n\nAnother line\n\n';
	assert.deepEqual(blocks(`Before\n\n${code}`), ['Before', code]);
});

void test('keeps list items and lazy or indented continuations together', () => {
	const list = ['1. First item', 'A lazy continuation', '', '   Another item paragraph', '', '   - Nested item', '', '2. Second item', '', '\tNested code', '', '    More code'].join('\n');
	assert.deepEqual(blocks(`${list}\n\nAfter`), [list, 'After']);
});

void test('keeps quote lines together and separates the next paragraph', () => {
	const quote = '> First paragraph\n\n> Last paragraph\n> > Nested quote';
	assert.deepEqual(blocks(`${quote}\n\nAfter`), [quote, 'After']);
});

void test('keeps table headers, rules and rows together, including pipe lines after a blank', () => {
	const table = '| Name | Count |\n| --- | ---: |\n| Example | 12 |\n\nAnother | 4';
	assert.deepEqual(blocks(`${table}\n\nAfter`), [table, 'After']);
});

void test('keeps display math together and does not treat a single line formula as unfinished', () => {
	const math = '$$\n1 + 2\n\n= 3\n$$';
	assert.deepEqual(blocks(`Before\n\n${math}\n\n$$4$$\n\nAfter`), ['Before', math, '$$4$$', 'After']);
});

void test('reports original offsets and line numbers for CRLF and CR', () => {
	const text = '\r\nFirst\r\nSecond\r\n\r\nThird\r\rFourth\r';
	assert.deepEqual(splitMarkdownBlocks(text), [
		{ text: 'First\r\nSecond', offset: 2, line: 1 },
		{ text: 'Third', offset: 19, line: 4 },
		{ text: 'Fourth', offset: 26, line: 6 },
	]);
});

void test('does not produce empty blocks from empty input or surrounding blanks', () => {
	assert.deepEqual(splitMarkdownBlocks(''), []);
	assert.deepEqual(splitMarkdownBlocks(' \r\n\t\r '), []);
	assert.deepEqual(splitMarkdownBlocks('\nText\n\n'), [{ text: 'Text', offset: 1, line: 1 }]);
});

void test('leaves finished prefix blocks unchanged when streaming more text', () => {
	const prefix = '# Heading\n\nOne paragraph\n\n';
	const previous = splitMarkdownBlocks(prefix + '```js\ncon');
	const next = splitMarkdownBlocks(prefix + '```js\nconst answer = 42;\n```\n\nAfter');
	assert.deepEqual(next.slice(0, 2), previous.slice(0, 2));
});

void test('preserves the parsing context for references and comments separated by blank lines', () => {
	const reference = '[Visit][site]\n\nMore\n\n[site]: https://example.test';
	assert.deepEqual(blocks(`Before\n\n${reference}`), ['Before', reference]);
	assert.deepEqual(blocks('Before\n\n[Visit][site]\n\nMore'), ['Before', '[Visit][site]\n\nMore']);
	const comment = '%% hidden\n\nstill hidden %%\n\nAfter';
	assert.deepEqual(blocks(`Before\n\n${comment}`), ['Before', comment]);
});

void test('inline note references resolve only exact Markdown file paths', () => {
	const file = { path: '文件夹/笔记.md', extension: 'md' };
	const checks: string[] = [];
	const vault = { getFileByPath: (path: string) => { checks.push(path); return file; } } as unknown as Pick<Vault, 'getFileByPath'>;
	assert.deepEqual(resolveInlineNote(vault, ' 文件夹/笔记.md#标题 '), { file, subpath: '#标题' });
	assert.equal(resolveInlineNote(vault, '笔记.md'), undefined);
	for (const invalid of ['../笔记.md', '/笔记.md', 'https://example.test/笔记.md', '脚本.js']) {
		assert.equal(resolveInlineNote(vault, invalid), undefined);
	}
	assert.deepEqual(checks, ['文件夹/笔记.md', '笔记.md']);
});
