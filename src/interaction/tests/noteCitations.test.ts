import assert from 'node:assert/strict';
import test from 'node:test';
import type { Vault } from 'obsidian';
import { parseNoteCitations, resolveNoteCitation } from '../noteCitations';
import type { NoteCitation } from '../noteCitations';

function note(path: string, basename: string) {
	return { path, basename, extension: 'md' };
}

function testVault(...notes: Array<ReturnType<typeof note>>): Pick<Vault, 'getFileByPath'> {
	const files = new Map(notes.map((file) => [file.path, file]));
	return { getFileByPath: (path: string) => files.get(path) ?? null } as unknown as Pick<Vault, 'getFileByPath'>;
}

void test('same-name citations in a saved answer resolve to their exact notes', () => {
	const product = note('产品/发布决策.md', '发布决策');
	const support = note('客服/发布决策.md', '发布决策');
	const summary = note('汇总.md', '汇总');
	const vault = testVault(product, support, summary);
	const productCitation = '[[产品/发布决策#回滚|退回方案]]';
	const supportCitation = '`客服/发布决策.md`';
	const summaryCitation = '[[汇总.md]]';
	const answer = `先看${productCitation}，再比对${supportCitation}。\n另见${summaryCitation}。`;
	const parts = parseNoteCitations(answer);
	const citations = parts.filter((part): part is NoteCitation => typeof part !== 'string');

	assert.equal(parts.map((part) => typeof part === 'string' ? part : part.raw).join(''), answer);
	assert.deepEqual(citations.map(({ raw }) => raw), [productCitation, supportCitation, summaryCitation]);
	assert.deepEqual(citations.map(({ subpath }) => subpath), ['#回滚', '', '']);
	assert.deepEqual(citations.map((citation) => resolveNoteCitation(vault, citation)), [product, support, summary]);
});

void test('ambiguous, missing, unsafe, and literal references stay as text', () => {
	const original = note('产品/发布决策.md', '发布决策');
	const lookup = [
		original,
		note('客服/发布决策.md', '发布决策'),
		note('/产品/发布决策.md', '发布决策'),
		note('../产品/发布决策.md', '发布决策'),
		note('https://example.test/发布决策.md', '发布决策'),
	];
	const vault = testVault(...lookup);
	const answer = [
		'名称不明确：[[发布决策]]。',
		'已删除：[[旧文档/发布决策]]。',
		'不安全的位置：[[/产品/发布决策.md]] [[../产品/发布决策.md]] [[https://example.test/发布决策.md]]。',
		'内嵌示例：![[产品/发布决策]]；代码示例：`[[产品/发布决策]]`。',
		'```md',
		'[[产品/发布决策]]',
		'```',
	].join('\n');
	const parts = parseNoteCitations(answer);
	const citations = parts.filter((part): part is NoteCitation => typeof part !== 'string');

	assert.equal(parts.map((part) => typeof part === 'string' ? part : part.raw).join(''), answer);
	assert.ok(citations.every((citation) => resolveNoteCitation(vault, citation) === null));
});
