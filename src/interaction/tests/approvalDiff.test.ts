import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalDiff } from '../approvalDiff';

void test('distant changes at lines 28 and 174 each get two lines of context', () => {
	const before = Array.from({ length: 185 }, (_, i) => `第 ${i + 1} 行\n`);
	const after = [...before];
	after[27] = '新标题\n';
	after[173] = '新检查时间\n';
	const groups = approvalDiff(before.join(''), after.join(''));
	assert.ok(groups);
	assert.deepEqual(groups.map(group => group.map(({ kind, oldLine, newLine }) => [kind, oldLine, newLine])), [
		[['context', 26, 26], ['context', 27, 27], ['remove', 28, undefined], ['add', undefined, 28], ['context', 29, 29], ['context', 30, 30]],
		[['context', 172, 172], ['context', 173, 173], ['remove', 174, undefined], ['add', undefined, 174], ['context', 175, 175], ['context', 176, 176]],
	]);
	assert.deepEqual(groups.map(group => group.find(row => row.kind === 'add')?.text), ['新标题', '新检查时间']);
});

void test('nearby edits share context and keep before and after line numbers after insertions and removals', () => {
	const groups = approvalDiff('头\n中间一\n中间二\n删除\n保留\n最后\n', '头\n插入一\n插入二\n中间一\n中间二\n保留\n最后\n');
	assert.ok(groups);
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0]?.map(({ kind, oldLine, newLine, text }) => [kind, oldLine, newLine, text]), [
		['context', 1, 1, '头'],
		['add', undefined, 2, '插入一'],
		['add', undefined, 3, '插入二'],
		['context', 2, 4, '中间一'],
		['context', 3, 5, '中间二'],
		['remove', 4, undefined, '删除'],
		['context', 5, 6, '保留'],
		['context', 6, 7, '最后'],
	]);
});

void test('shows line-ending changes, blank lines and trailing whitespace without removing them from the comparison', () => {
	const diff = approvalDiff('a \r\n\rb', 'a\n\rb\n');
	assert.ok(diff);
	assert.deepEqual(diff.flat().map(({ kind, oldLine, newLine, text, ending }) => [kind, oldLine, newLine, text, ending]), [
		['remove', 1, undefined, 'a ', 'CRLF'],
		['add', undefined, 1, 'a', undefined],
		['context', 2, 2, '', 'CR'],
		['remove', 3, undefined, 'b', 'none'],
		['add', undefined, 3, 'b', undefined],
	]);
});

void test('compares a new file, omits unchanged groups and falls back for an oversized preview', () => {
	assert.deepEqual(approvalDiff('', ''), []);
	assert.deepEqual(approvalDiff('没有变化\n', '没有变化\n'), []);
	assert.deepEqual(approvalDiff('', '新文件\n'), [[{ kind: 'add', oldLine: undefined, newLine: 1, text: '新文件', ending: undefined }]]);
	assert.equal(approvalDiff('', '新增\n'.repeat(401)), null);
});
