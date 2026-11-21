import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createContextBuilder } from '../../orchestration/context/contextBuilder';
import { createReadDelivery } from '../../runtime/readDelivery';
import { createPermissionPolicy } from '../../orchestration/policies/permissions';
import { createRunContext } from '../../orchestration/runContext';
import type { NoteRef, ToolApproval, ToolContext } from '../../types';
import { createToolLayer } from '..';
import { hasMacShellSandbox } from '../external/macosShellSandbox';
import { shellTools } from '../external/shellTool';

const { registry, executor } = createToolLayer();
const shells = shellTools();
const installedShells = shells.filter((tool) => tool.isAvailable?.() ?? true).map(({ name }) => name);
const available = (name: string) => installedShells.includes(name);
const execute = (ctx: ToolContext, name: string, input: unknown) => executor.execute({ id: name, name, input }, ctx);

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-search-shell-')));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const cwd = join(root, 'vault');
	const outside = join(root, 'authorized');
	const denied = join(root, 'unlisted');
	await Promise.all([mkdir(cwd), mkdir(outside), mkdir(denied)]);
	const refs: NoteRef[] = [{ path: outside, kind: 'folder' }];
	const controller = new AbortController();
	const ctx: ToolContext = {
		task: { id: 'test', request: { conversationId: 'test', instruction: 'test', refs }, status: 'running', createdAt: 0, updatedAt: 0 },
		permissions: await createPermissionPolicy(cwd, 'plugin-config', refs),
		app: { vault: { configDir: 'plugin-config', getFileByPath: () => null } } as unknown as ToolContext['app'],
		signal: controller.signal,
		cwd,
		readFiles: new Map(),
		readDelivery: createReadDelivery(),
	};
	return { ctx, controller, outside, denied };
}

void test('only main chat with tool calling enabled advertises the installed shells', async (t) => {
	const { ctx } = await fixture(t);
	const builder = createContextBuilder(registry);
	const options = { cwd: ctx.cwd, signal: ctx.signal, model: { providerId: 'test', model: 'test' }, observer: {} };
	for (const [sideChat, enabled] of [[false, true], [true, true], [false, false]] as const) {
		const run = await createRunContext(ctx.task, options, 'plugin-config', () => enabled, sideChat);
		const request = await builder.build(run, [], 100_000);
		const advertised = request.tools.filter(({ name }) => shells.some((shell) => shell.name === name)).map(({ name }) => name);
		assert.deepEqual(advertised, !sideChat && enabled ? installedShells : []);
	}
});

void test('Glob and Grep search the vault and authorized external locations', async (t) => {
	const { ctx, outside, denied } = await fixture(t);
	const drafts = join(ctx.cwd, 'drafts');
	await mkdir(drafts);
	await Promise.all([
		writeFile(join(ctx.cwd, 'local.md'), 'first\nScribe match\nLast\n'),
		writeFile(join(drafts, 'unused.txt'), 'draft'),
		writeFile(join(outside, 'external.txt'), 'Scribe match\nScribe match\n'),
		writeFile(join(denied, 'private.md'), 'Scribe match\n'),
	]);
	const files = await execute(ctx, 'Glob', { pattern: '**/*.{md,txt}' });
	assert.equal(files.isError, false);
	assert.ok(files.content.includes('local.md'));
	assert.ok(files.content.includes('drafts/unused.txt'));
	assert.ok(files.content.includes(join(outside, 'external.txt')));
	assert.ok(!files.content.includes('private.md'));
	const content = await execute(ctx, 'Grep', { pattern: 'scribe match', '-i': true, output_mode: 'content', glob: '*.md' });
	assert.equal(content.isError, false);
	assert.match(content.content, /^local\.md:2:Scribe match$/);
	const count = await execute(ctx, 'Grep', { pattern: 'match', path: outside, output_mode: 'count' });
	assert.equal(count.content, `${join(outside, 'external.txt')}:2`);
	assert.equal((await execute(ctx, 'Glob', { pattern: '*', path: denied })).isError, true);
	assert.equal((await execute(ctx, 'Grep', { pattern: '(' })).isError, true);
});

void test('Bash uses the vault by default and runs the exact approved command in an outside directory', { skip: !available('Bash') }, async (t) => {
	const { ctx, outside, denied } = await fixture(t);
	const command = "printf 'scribe verified' > marker.txt";
	const approvals: ToolApproval[] = [];
	ctx.approve = async (approval) => {
		approvals.push(approval);
		return approvals.length !== 1;
	};
	assert.equal((await execute(ctx, 'Bash', { command })).isError, true);
	await assert.rejects(readFile(join(ctx.cwd, 'marker.txt')), { code: 'ENOENT' });
	assert.equal((await execute(ctx, 'Bash', { command })).isError, false);
	assert.equal(await readFile(join(ctx.cwd, 'marker.txt'), 'utf8'), 'scribe verified');
	assert.equal((await execute(ctx, 'Bash', { command, cwd: outside })).isError, false);
	assert.equal(await readFile(join(outside, 'marker.txt'), 'utf8'), 'scribe verified');
	assert.deepEqual(approvals[2], { title: 'Bash', kind: 'shell', target: outside, after: command });
	assert.equal((await execute(ctx, 'Bash', { command, cwd: denied })).isError, true);
	assert.equal((await execute(ctx, 'Bash', { command: 'echo text\u202E' })).isError, true);
	assert.equal(approvals.length, 3);
});

void test('macOS Bash restricts vault commands until a single escalation is approved or full access is selected', {
	skip: !available('Bash') || !hasMacShellSandbox(),
}, async (t) => {
	const { ctx, denied } = await fixture(t);
	const config = join(ctx.cwd, 'plugin-config');
	const secret = join(denied, 'outside.txt');
	await mkdir(config);
	await Promise.all([
		writeFile(secret, 'private'),
		writeFile(join(config, 'private.txt'), 'config'),
		writeFile(join(ctx.cwd, 'lines.txt'), 'first\nsecond\n'),
	]);
	ctx.task.request.refs.push({ path: 'lines.txt', lines: [1, 1] });
	await symlink(secret, join(ctx.cwd, 'link.txt'));
	const server = createServer((socket) => { socket.end(); });
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.close(); });
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const connect = `< /dev/tcp/127.0.0.1/${address.port}`;

	const baseline = await createPermissionPolicy(ctx.cwd, 'plugin-config', ctx.task.request.refs);
	const approvals: ToolApproval[] = [];
	let approved = false;
	ctx.approve = async (approval) => {
		approvals.push(approval);
		return approved;
	};
	ctx.permissions = { ...baseline, executionMode: 'ask', canRequestPath: (path) => path === denied };
	const local = await execute(ctx, 'Bash', { command: 'printf work > note.md && cat note.md' });
	assert.equal(local.isError, false, local.content);
	assert.match(local.content, /work/);
	for (const command of ['cat link.txt', 'printf changed > link.txt', 'cat plugin-config/private.txt', 'cat lines.txt', connect]) {
		assert.equal((await execute(ctx, 'Bash', { command })).isError, true);
	}
	assert.equal(await readFile(secret, 'utf8'), 'private');
	assert.equal(approvals.length, 0);
	assert.equal((await execute(ctx, 'Bash', { command: connect, elevated: true })).isError, true);
	assert.equal(approvals[0]?.after, connect);

	approved = true;
	ctx.permissions = { ...ctx.permissions, executionMode: 'auto-review' };
	const outside = await execute(ctx, 'Bash', { command: 'cat outside.txt', cwd: denied });
	assert.equal(outside.isError, false, outside.content);
	assert.match(outside.content, /private/);
	assert.equal(approvals[1]?.target, denied);

	ctx.permissions = { ...baseline, executionMode: 'full-access', canRead: () => true };
	assert.equal((await execute(ctx, 'Bash', { command: connect, cwd: denied })).isError, false);
	assert.equal(approvals.length, 2);
});

void test('Bash without a native vault boundary requires approval before running', {
	skip: !available('Bash') || hasMacShellSandbox(),
}, async (t) => {
	const { ctx } = await fixture(t);
	ctx.permissions = { ...ctx.permissions, executionMode: 'ask' };
	const approvals: ToolApproval[] = [];
	ctx.approve = async (approval) => {
		approvals.push(approval);
		return false;
	};
	const result = await execute(ctx, 'Bash', { command: 'printf work > note.md' });
	assert.equal(result.isError, true);
	assert.match(approvals[0]?.reason ?? '', /无法限制/);
	await assert.rejects(readFile(join(ctx.cwd, 'note.md')), { code: 'ENOENT' });
});

void test('stopping Bash terminates a running command', { skip: !available('Bash') }, async (t) => {
	const { ctx, controller } = await fixture(t);
	ctx.approve = async () => true;
	const command = 'printf started > started.txt; sleep 30; printf finished > finished.txt';
	const running = execute(ctx, 'Bash', { command });
	try {
		const deadline = Date.now() + 3_000;
		while (true) {
			const marker = await readFile(join(ctx.cwd, 'started.txt'), 'utf8').catch(() => '');
			if (marker === 'started') break;
			assert.ok(Date.now() < deadline, 'Bash did not start');
			await setTimeout(25);
		}
	} finally {
		controller.abort();
	}
	const result = await running;
	assert.equal(result.isError, true);
	assert.match(result.content, /已停止/);
	await assert.rejects(readFile(join(ctx.cwd, 'finished.txt')), { code: 'ENOENT' });
});

void test('PowerShell returns real approved command output', { skip: !available('PowerShell') }, async (t) => {
	const { ctx, outside } = await fixture(t);
	ctx.approve = async () => true;
	const result = await execute(ctx, 'PowerShell', { command: '(Get-Location).ProviderPath', cwd: outside });
	assert.equal(result.isError, false, result.content);
	assert.ok(result.content.includes(outside), result.content);
});
