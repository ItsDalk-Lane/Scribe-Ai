import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ViewState, Workspace, WorkspaceLeaf } from 'obsidian';
import { initializeLocalState, executionModeKey } from '../../orchestration/storage/localState';
import type { ChatGoal } from '../chatGoal';
import { replaceActiveTabPane } from '../chatTabWorkspace';
import { readSubagentTabState, ConversationViews } from '../conversationViews';
import { testSecretStorage } from '../../orchestration/tests/testSecretStorage';

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
	const tabs = new ConversationViews({ rightSplit: right, getRightLeaf: createLeaf,
		getLeavesOfType: () => [...leaves], revealLeaf: async () => {} } as unknown as Workspace);
	const target = { conversationId: 'first', agentId: 'agent', name: '签到' };
	await Promise.all([tabs.openSubagent(target, ''), tabs.openSubagent(target, '')]);
	await tabs.openSubagent(target, '');
	await tabs.openSubagent({ ...target, agentId: 'another-agent' }, '');
	await tabs.openSubagent({ ...target, conversationId: 'second' }, '');
	assert.equal(leaves.length, 3);
	assert.deepEqual(readSubagentTabState(leaves[0]?.getViewState().state), target);
	const firstSide = createLeaf(false);
	const secondSide = createLeaf(false);
	tabs.sideChatParents.set(firstSide as unknown as WorkspaceLeaf, 'first');
	tabs.sideChatParents.set(secondSide as unknown as WorkspaceLeaf, 'second');
	tabs.closeConversation('first');
	assert.ok(!leaves.includes(firstSide));
	assert.deepEqual([...tabs.sideChatParents.values()], ['second']);
	assert.deepEqual(leaves.filter((leaf) => leaf !== secondSide).map((leaf) => leaf.getViewState().state?.conversationId), ['second']);
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

void test('本机状态和旧目标迁移后可重开，验证之前保留旧副本', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'scribe-state-test-'));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, 'state.json');
	const goal: ChatGoal = { objective: '保存旧目标', status: 'active', usedRounds: 0, totalRounds: 0 };
	const entries = new Map<string, unknown>([
		[executionModeKey(), 'full-access'],
		[executionModeKey('older'), 'auto-review'],
		[executionModeKey('invalid'), { mode: 'full-access' }],
		['scribe-ai:timeline-expanded', ['tool:1']],
		['oauth-device-id', 'previous-device'],
		['scribe-ai:chat-goal:older', goal],
		['scribe-ai:chat-goal:unavailable', goal],
	]);
	const app = { secretStorage: testSecretStorage(), loadLocalStorage: (key: string) => entries.get(key), saveLocalStorage: (key: string) => { entries.delete(key); } };
	const goals = new Map<string, ChatGoal | null>();
	const store = {
		loadGoal: (id: string) => Promise.resolve(goals.get(id)),
		saveGoal: (id: string, value: ChatGoal | null) => { goals.set(id, value); return Promise.resolve(); },
	};
	const ids = ['older', 'invalid'];
	const state = await initializeLocalState(path, app, ids);
	await state.migrateLegacyGoals(store);
	assert.equal(state.loadExecutionMode(), 'full-access');
	assert.equal(state.loadExecutionMode('older'), 'auto-review');
	assert.equal(state.loadExecutionMode('invalid'), 'ask');
	assert.equal(state.loadExecutionMode('missing'), 'ask');
	assert.equal(await state.getOAuthDeviceId(), 'previous-device');
	assert.deepEqual([...state.timelineExpanded()], ['tool:1']);
	assert.deepEqual(goals.get('older'), { ...goal, status: 'paused', reason: 'closed' });
	assert.equal(entries.size, 7);

	await state.saveExecutionMode('ask', 'older');
	const reopened = await initializeLocalState(path, app, ids);
	assert.equal(reopened.loadExecutionMode('older'), 'ask');
	const raw = await readFile(path, 'utf8');
	await writeFile(path, JSON.stringify({ device: 'incomplete' }));
	await assert.rejects(reopened.clearLegacy(store), /无法确认/u);
	assert.equal(entries.size, 7);
	await writeFile(path, raw);
	await reopened.clearLegacy(store);
	assert.deepEqual([...entries.keys()], ['scribe-ai:chat-goal:unavailable']);
	const saved: unknown = JSON.parse(raw);
	await writeFile(path, JSON.stringify({ ...saved as object, device: 'another-device', lastExecutionMode: 'full-access' }));
	const otherDevice = await initializeLocalState(path, app, ids);
	assert.equal(otherDevice.loadExecutionMode(), 'ask');
	assert.notEqual(await otherDevice.getOAuthDeviceId(), 'previous-device');
});

void test('权限写入失败后，排队的界面更新不会重新保存失败的权限', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'scribe-state-test-'));
	t.after(() => rm(directory, { force: true, recursive: true }));
	const path = join(directory, 'state.json');
	const app = { secretStorage: testSecretStorage(), loadLocalStorage: () => undefined, saveLocalStorage: () => {} };
	const state = await initializeLocalState(path, app, []);
	t.mock.method(fs, 'rename', () => { throw new Error('磁盘写入失败'); }, { times: 1 });
	const mode = state.saveExecutionMode('full-access', 'test-chat');
	const timeline = state.saveTimelineExpanded(new Set(['tool:1']));
	await assert.rejects(mode, /磁盘写入失败/u);
	assert.equal(state.loadExecutionMode('test-chat'), 'ask');
	await timeline;
	const reopened = await initializeLocalState(path, app, []);
	assert.equal(reopened.loadExecutionMode(), 'ask');
	assert.equal(reopened.loadExecutionMode('test-chat'), 'ask');
	assert.deepEqual([...reopened.timelineExpanded()], ['tool:1']);
});
