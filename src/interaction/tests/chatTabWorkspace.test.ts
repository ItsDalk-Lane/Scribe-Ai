import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ViewState, Workspace } from 'obsidian';
import { executionModeKey, loadExecutionMode, replaceActiveTabPane } from '../chatTabWorkspace';
import { readSubagentTabState, SubagentTabs } from '../subagentTabs';

void test('同一子聊天重复打开时复用右栏标签，不同会话独立，删除仅关闭对应会话', async () => {
	const right = {};
	const leaves: { getViewState(): ViewState }[] = [];
	const createLeaf = (split: boolean) => {
		assert.equal(split, false);
		let state: ViewState = { type: 'empty' };
		const leaf = {
			getRoot: () => right,
			getViewState: () => state,
			async setViewState(next: ViewState) { await Promise.resolve(); state = next; },
			detach() { leaves.splice(leaves.indexOf(leaf), 1); },
		};
		leaves.push(leaf);
		return leaf;
	};
	const tabs = new SubagentTabs({ rightSplit: right, getRightLeaf: createLeaf,
		getLeavesOfType: () => [...leaves], revealLeaf: async () => {} } as unknown as Workspace);
	const target = { conversationId: 'first', agentId: 'agent', name: '签到' };
	await Promise.all([tabs.open(target, ''), tabs.open(target, '')]);
	await tabs.open(target, '');
	await tabs.open({ ...target, agentId: 'another-agent' }, '');
	await tabs.open({ ...target, conversationId: 'second' }, '');
	assert.equal(leaves.length, 3);
	assert.deepEqual(readSubagentTabState(leaves[0]?.getViewState().state), target);
	tabs.closeConversation('first');
	assert.deepEqual(leaves.map((leaf) => leaf.getViewState().state?.conversationId), ['second']);
});

interface TestPane {
	conversation: { id: string; runs: unknown[]; queue?: unknown[] };
	open: boolean;
	unread?: boolean;
	hasDraft: boolean;
	status?: string;
	title?: string;
	customTitle?: string;
}

function pane(id: string, extra: Partial<TestPane> = {}): TestPane {
	return { conversation: { id, runs: [] }, open: true, hasDraft: false, ...extra };
}

void test('new conversation replaces the active tab position and preserves a dirty previous pane hidden', () => {
	const next = replaceActiveTabPane({ activeId: 'a', panes: [pane('a', { hasDraft: true }), pane('b')] }, pane('c'), new Map());
	assert.equal(next.activeId, 'c');
	assert.deepEqual(next.panes.map(({ conversation, open }) => [conversation.id, open]), [
		['c', true], ['b', true], ['a', false],
	]);
});

void test('new conversation discards an empty previous pane instead of stacking hidden tabs', () => {
	const next = replaceActiveTabPane({ activeId: 'a', panes: [pane('a'), pane('b')] }, pane('c'), new Map());
	assert.equal(next.activeId, 'c');
	assert.deepEqual(next.panes.map(({ conversation, open }) => [conversation.id, open]), [
		['c', true], ['b', true],
	]);
});

void test('a queued message keeps the previous conversation recoverable', () => {
	const previous = pane('a', { conversation: { id: 'a', runs: [], queue: [{ id: 'q' }] } });
	const next = replaceActiveTabPane({ activeId: 'a', panes: [previous] }, pane('c'), new Map());
	assert.deepEqual(next.panes.map(({ conversation, open }) => [conversation.id, open]), [
		['c', true], ['a', false],
	]);
});

void test('execution mode records restore each conversation and the latest mode independently', () => {
	const entries = new Map<string, unknown>([
		[executionModeKey(), 'full-access'],
		[executionModeKey('older'), 'auto-review'],
		[executionModeKey('invalid'), { mode: 'full-access' }],
	]);
	const app = { loadLocalStorage: (key: string) => entries.get(key) };
	assert.equal(loadExecutionMode(app), 'full-access');
	assert.equal(loadExecutionMode(app, 'older'), 'auto-review');
	assert.equal(loadExecutionMode(app, 'invalid'), 'ask');
	assert.equal(loadExecutionMode(app, 'missing'), 'ask');
	assert.equal(loadExecutionMode({ loadLocalStorage: () => { throw new SyntaxError('invalid local record'); } }), 'ask');
});
