import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry } from '../../tools';
import { createToolExecutor } from '../../tools/executor';
import { subagentTools, subagentToolVisible } from '../../tools/subagentTools';
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
	const executor = createToolExecutor(createToolRegistry([subagentTools]));
	const spawn = { id: 'one', name: 'spawn_agent', input: { message: 'Research', model: 'provider/model', fork_turns: 'none', i: '核对资料' } };
	assert.equal(subagentToolVisible('Read', undefined), true);
	assert.equal(subagentToolVisible('send_message', undefined), false);
	assert.equal(subagentToolVisible('send_message', ctx.subagents), true);
	assert.equal((await executor.execute(spawn, ctx)).isError, true);
	access.canSpawn = true;
	assert.equal((await executor.execute({ ...spawn, input: { ...spawn.input, fork_turns: 'bogus' } }, ctx)).isError, true);
	assert.equal((await executor.execute(spawn, ctx)).isError, false);
	assert.equal((await executor.execute({ id: 'two', name: 'wait_agent', input: { targets: [''], timeout_ms: 0 } }, ctx)).isError, true);
	assert.deepEqual(calls, [{ name: 'spawn_agent', input: { message: 'Research', model: 'provider/model', fork_turns: 'none' } }]);
});
