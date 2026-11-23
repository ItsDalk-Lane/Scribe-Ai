import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTimelineChange, restoredTimelineExpansion, timelineRows, toggleTimelineExpansion } from '../chatTimeline';
import type { NoticeRow, TimelineChange, TimelineItem, ToolRow } from '../chatTimeline';

const messageId = 'assistant:task:1';
const read = (id: string): ToolRow => ({ kind: 'tool', id, call: { id, name: 'Read', input: { file_path: '笔记.md' } } });
const project = (...events: TimelineChange[]) => events.reduce<readonly TimelineItem[]>(applyTimelineChange, []);

void test('a start and result occupy the same row; a notice leaves it untouched', () => {
	const tool = read('read-1');
	const before = project({ type: 'put', item: tool });
	const output = { ...tool, result: { callId: tool.call.id, content: '笔记正文', isError: false } };
	const after = applyTimelineChange(before, { type: 'put', item: output });
	assert.deepEqual(timelineRows(after), [output]);
	assert.equal(after[0]?.id, before[0]?.id);
	const notice: NoticeRow = { kind: 'notice', id: 'interrupted', code: 'interrupted', tone: 'warning' };
	const notified = applyTimelineChange(after, { type: 'put', item: notice });
	assert.deepEqual(timelineRows(notified), [output, notice]);
	assert.equal(notified[0], after[0]);
});

void test('only a continuous series of tools of the same kind forms a group', () => {
	const first = read('read-1');
	const second = read('read-2');
	const third = read('read-3');
	const fourth = read('read-4');
	const fifth = { ...read('edit-5'), call: { id: 'edit-5', name: 'Edit', input: {} } };
	const text = { kind: 'text' as const, id: 'answer', messageId, content: '接着检查。' };
	const rows = timelineRows([first, second, third, text, fourth, fifth]);
	assert.deepEqual(rows, [
		{ kind: 'tool-group', id: 'group:read-1', members: [first, second, third] }, text, fourth, fifth,
	]);
});

void test('each skill read has an individual row, including consecutive reads', () => {
	const first = { ...read('skill-1'), call: { id: 'skill-1', name: 'read_skill', input: { id: 'one' } } };
	const second = { ...read('skill-2'), call: { id: 'skill-2', name: 'read_skill', input: { id: 'one', file: 'notes.md' } } };
	assert.deepEqual(timelineRows([first, second]), [first, second]);
});

void test('thinking deltas grow one row with a stable key before the following reply', () => {
	const delta = { type: 'delta' as const, kind: 'thinking' as const, messageId, contentIndex: 0, text: '先' };
	const original = project(delta);
	const pending = applyTimelineChange(original, { ...delta, text: '读笔记' });
	assert.equal(pending.length, 1);
	assert.deepEqual(pending[0], { ...original[0], content: '先读笔记' });
	const done = applyTimelineChange(pending, { type: 'thinking-end', messageId, contentIndex: 0, durationMs: 3500 });
	const rows = timelineRows([...done, read('read-1'), { kind: 'text', id: 'response', messageId, content: '读完了。' }, read('read-2')]);
	assert.deepEqual(rows.map(({ kind }) => kind), ['thinking', 'tool', 'text', 'tool']);
	assert.deepEqual(rows[0], { ...pending[0], pending: false, durationMs: 3500 });
});

void test('open rows reload by key and the mapping has a finite size', () => {
	let expanded = restoredTimelineExpansion(null);
	for (let i = 0; i < 20; i++) expanded = toggleTimelineExpansion(expanded, 'tool-' + i);
	assert.deepEqual(restoredTimelineExpansion(JSON.parse(JSON.stringify([...expanded]))), expanded);
	for (let i = 20; i < 400; i++) expanded = toggleTimelineExpansion(expanded, 'tool-' + i);
	assert.equal(expanded.size, 256);
	assert.equal(expanded.has('tool-0'), false);
	assert.equal(expanded.has('tool-399'), true);
	expanded = toggleTimelineExpansion(expanded, 'tool-399');
	assert.equal(expanded.size, 255);
	assert.equal(expanded.has('tool-399'), false);
});
