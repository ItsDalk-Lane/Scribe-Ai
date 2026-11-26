import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry } from '../../tools';
import { createToolExecutor } from '../../tools/executor';
import { contactSubagentTool, manageSubagentsTool, subagentTools, subagentToolVisible } from '../../tools/subagentTools';
import type { ScribeSettings, SubagentToolAccess, ToolContext } from '../../types';
import { normalizeSettings } from '../settings/defaults';
import { BUILTIN_SUBAGENT_ROLES } from '../settings/subagentSettings';

void test('subagent settings recover safe defaults and keep valid custom role choices', () => {
	assert.deepEqual(normalizeSettings(null).subagents, { mode: 'auto', maxConcurrent: 6, maxDepth: 1, roles: [] });
	const explorer = {
		name: ' explorer ', description: ' Find sources ', instructions: ' Return citations ',
		model: { providerId: ' test-provider ', model: ' test-model ', reasoning: 'high' }, readOnly: true,
	};
	const settings = {
		subagents: { mode: 'explicit', maxConcurrent: -1, maxDepth: 2, roles: [
			{ ...explorer, name: 'invalid name' }, explorer, { ...explorer, description: 'Duplicate' },
		] },
	} as Partial<ScribeSettings>;
	assert.deepEqual(normalizeSettings(settings).subagents, {
		mode: 'explicit', maxConcurrent: 6, maxDepth: 2, roles: [{
			name: 'explorer', description: 'Find sources', instructions: 'Return citations',
			model: { providerId: 'test-provider', model: 'test-model', reasoning: 'high' }, readOnly: true,
		}],
	});
	assert.equal(BUILTIN_SUBAGENT_ROLES.find(({ name }) => name === 'explorer')?.readOnly, true);
});

void test('subagent tools enforce scoped access and validate inputs before dispatch', async () => {
	const calls: { name: string; input: unknown }[] = [];
	const signal = new AbortController().signal;
	const access: SubagentToolAccess = { canSpawn: false, execute: (name, input, callSignal) => {
		calls.push({ name, input });
		assert.equal(callSignal, signal);
		return Promise.resolve('ok');
	} };
	const ctx = {
		signal,
		permissions: { canCallTool: () => true },
		subagents: access,
	} as unknown as ToolContext;
	const registry = createToolRegistry([subagentTools]);
	const executor = createToolExecutor(registry);
	const spawn = { id: 'one', name: 'spawn_agent', input: { message: 'Research', model: 'provider/model', fork_turns: 'none', i: '核对资料' } };
	assert.equal(subagentToolVisible('Read', undefined), true);
	assert.equal(subagentToolVisible(contactSubagentTool, undefined), false);
	assert.equal(subagentToolVisible(contactSubagentTool, ctx.subagents), true);
	assert.equal(registry.all().length, 6);
	assert.equal(registry.find('send_message'), undefined);
	assert.equal((await executor.execute(spawn, ctx)).isError, true);
	access.canSpawn = true;
	assert.equal((await executor.execute({ ...spawn, input: { ...spawn.input, fork_turns: 'bogus' } }, ctx)).isError, true);
	assert.equal((await executor.execute(spawn, ctx)).isError, false);
	assert.equal((await executor.execute({ id: 'two', name: 'wait_agent', input: { targets: [''], timeout_ms: 0 } }, ctx)).isError, true);
	assert.deepEqual(calls, [{ name: 'spawn_agent', input: { message: 'Research', model: 'provider/model', fork_turns: 'none' } }]);
	calls.length = 0;

	const contact = (action: string, fields: Record<string, unknown> = {}) =>
		executor.execute({ id: 'contact', name: contactSubagentTool, input: { action, ...fields } }, ctx);
	const manage = (action: string, fields: Record<string, unknown> = {}) =>
		executor.execute({ id: 'manage', name: manageSubagentsTool, input: { action, ...fields } }, ctx);
	assert.equal((await contact('ask_parent', { message: 'Which source?' })).isError, true);
	assert.equal((await contact('send', { message: 'See update' })).isError, true);
	assert.equal((await contact('answer', { question_id: 'q', message: 'Use A', target: 'worker' })).isError, true);
	assert.equal((await manage('list', { target: 'worker' })).isError, true);
	assert.equal((await manage('toString')).isError, true);
	assert.deepEqual(calls, []);

	access.canAskParent = true;
	const target = 'worker';
	await contact('send', { target, message: 'See update', i: '补充资料' });
	await contact('follow_up', { target, message: 'Continue' });
	await contact('ask_parent', { message: 'Which source?' });
	await contact('answer', { question_id: 'q', message: 'Use A' });
	await manage('list');
	await manage('interrupt', { target });
	await manage('close', { target });
	await manage('reopen', { target });
	assert.deepEqual(calls, [
		{ name: 'send_message', input: { target, message: 'See update' } },
		{ name: 'followup_task', input: { target, message: 'Continue' } },
		{ name: 'ask_parent', input: { message: 'Which source?' } },
		{ name: 'answer_subagent', input: { question_id: 'q', message: 'Use A' } },
		{ name: 'list_agents', input: {} },
		{ name: 'interrupt_agent', input: { target } },
		{ name: 'close_agent', input: { target } },
		{ name: 'resume_agent', input: { target } },
	]);
});
