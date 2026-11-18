import assert from 'node:assert/strict';
import test from 'node:test';
import type { Vault } from 'obsidian';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderAnswerMarkdown } from '../answerMarkdown';
import { resolveNoteCitation } from '../noteCitations';

const notes = new Map(['产品/决策.md', '客服/决策.md'].map(path => [path, { path, extension: 'md', basename: '决策' }]));
const vault = { getFileByPath: (path: string) => notes.get(path) ?? null } as unknown as Pick<Vault, 'getFileByPath'>;

function markup(content: string): string {
	const nodes = renderAnswerMarkdown(content, (citation, key) => {
		const file = resolveNoteCitation(vault, citation);
		return file ? createElement('button', { key, type: 'button', title: file.path + citation.subpath }, file.basename) : citation.raw;
	});
	return renderToStaticMarkup(createElement(Fragment, null, nodes));
}

void test('renders headings, nested lists, quotes and focusable tables with exact note citations', () => {
	const html = markup([
		'## **[[产品/决策.md#回滚|旧方案]]**',
		'3. 复核 `客服/决策.md`',
		'   - *子项*',
		'4. 下一步',
		'> 引用一',
		'> 引用二',
		'> > 内层引用',
		'',
		'| 行 | 说明 | 内联示例 |',
		'| --- | :--- | ---: |',
		'|| [[产品/决策.md|方案]] | `a|b` |',
		'第二行 || a\\|b',
		'| 第三行 | [[过期.md]] ||',
	].join('\n'));

	assert.match(html, /<h2><strong><button type="button" title="产品\/决策\.md#回滚">决策<\/button><\/strong><\/h2>/u);
	assert.match(html, /<ol start="3"><li><p>复核 <button type="button" title="客服\/决策\.md">决策<\/button><\/p><ul><li><p><em>子项<\/em>/u);
	assert.match(html, /<\/li><li><p>下一步<\/p><\/li><\/ol>/u);
	assert.match(html, /<blockquote><p>引用一<br\/>引用二<\/p><blockquote><p>内层引用<\/p><\/blockquote><\/blockquote>/u);
	assert.match(html, /<div class="scribe-answer-table-scroll" tabindex="0"><table><thead><tr><th scope="col">行<\/th>/u);
	assert.match(html, /<tr><td><\/td><td><button type="button" title="产品\/决策\.md">决策<\/button><\/td><td><code>a\|b<\/code><\/td><\/tr>/u);
	assert.match(html, /<tr><td>第二行<\/td><td><\/td><td>a\|b<\/td><\/tr><tr><td>第三行<\/td><td>\[\[过期\.md\]\]<\/td><td><\/td><\/tr>/u);
});

void test('keeps examples, raw HTML, images and non-citation links inert', () => {
	const content = [
		'<img src="https://example.test/image.png" />',
		'![图片](https://example.test/image.png) [网页](https://example.test) [打开](obsidian://open) [执行](javascript:void(0))',
		'![[产品/决策.md]] \\[[产品/决策.md]] `[[产品/决策.md]]` ``产品/决策.md`` `过期.md`',
		'> ~~~~md',
		'>   [[产品/决策.md]]',
		'> ~~~',
		'> `产品/决策.md`',
		'> ~~~~',
		'',
		'```html',
		'<img src="https://example.test/image.png" />',
	].join('\r\n');
	const html = markup(content);

	assert.doesNotMatch(html, /<(?:a|img|button|script)\b/u);
	assert.match(html, /&lt;img src=&quot;https:\/\/example\.test\/image\.png&quot; \/&gt;/u);
	assert.match(html, /<code>\[\[产品\/决策\.md\]\]<\/code> <code>产品\/决策\.md<\/code> `过期\.md`/u);
	assert.match(html, /<pre class="scribe-chat-pre" tabindex="0"><code> {2}\[\[产品\/决策\.md\]\]\n~~~\n`产品\/决策\.md`<\/code><\/pre>/u);
	assert.match(html, /<pre class="scribe-chat-pre" tabindex="0"><code>&lt;img/u);
});
