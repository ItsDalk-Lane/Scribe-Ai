import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createContextBuilder } from '../../orchestration/context/contextBuilder';
import { createReadDelivery } from '../../runtime/readDelivery';
import { createPermissionPolicy } from '../../orchestration/policies/permissions';
import { createRunContext } from '../../orchestration/runContext';
import { createConversationStore } from '../../orchestration/storage/conversationStore';
import { scribeDataPaths } from '../../orchestration/storage/paths';
import type { NoteRef, ShellOutputPreview, ToolApproval, ToolContext } from '../../types';
import { createToolLayer, createToolRegistry } from '..';
import { createToolExecutor } from '../executor';
import { hasMacShellSandbox, macShellSandboxArgs } from '../external/macosShellSandbox';
import { JobOutputRing, renderRingRead } from '../external/jobOutput';
import { ShellJobs, FOREGROUND_WAIT_MS } from '../external/shellJobs';
import { captureShellOutput } from '../external/shellOutput';
import { shellTools } from '../external/shellTool';
import { boundToolResult, estimateResultTokens, MAX_INLINE_TOKENS } from '../support/resultSpill';
import { clearSpillFiles, sweepSpillFiles } from '../support/spillCleanup';
import { retainDraftImages, retainedImagePaths } from '../../orchestration/storage/retainedImages';
import { saveCachedImage } from '../support/imageData';

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

void test('关闭模型工具开关后，三档权限都隐藏全部工具并在执行前拦住调用', async (t) => {
	const { ctx } = await fixture(t);
	const guarded = createToolExecutor(createToolRegistry([() => registry.all().map((tool) => ({
		...tool, prepare: () => assert.fail('禁用的工具不应进入准备或执行阶段'),
	}))]));
	const builder = createContextBuilder(registry);
	const options = { cwd: ctx.cwd, signal: ctx.signal, model: { providerId: 'test', model: 'test' }, observer: {} };
	for (const mode of ['ask', 'auto-review', 'full-access'] as const) {
		const run = await createRunContext(ctx.task, options, ctx.app.vault.configDir, () => false, false, mode);
		assert.deepEqual((await builder.build(run, [], 100_000)).tools, []);
		for (const { name } of registry.all()) {
			const result = await guarded.execute({ id: name, name, input: {} }, { ...ctx, permissions: run.permissions });
			assert.equal(result.isError, true);
			assert.equal(result.content, `未授权使用工具：${name}`);
		}
	}
});

void test('计划模式沿用配置目录的真实位置，并保留通常可读的笔记', async (t) => {
	const { ctx } = await fixture(t);
	const actual = join(ctx.cwd, 'settings-directory');
	await mkdir(actual);
	await symlink(actual, join(ctx.cwd, ctx.app.vault.configDir), process.platform === 'win32' ? 'junction' : 'dir');
	const task = { ...ctx.task, request: { ...ctx.task.request, intent: 'plan' as const, refs: [{ path: 'settings-directory', kind: 'folder' as const }] } };
	const run = await createRunContext(task, { cwd: ctx.cwd, signal: ctx.signal, model: { providerId: 'test', model: 'test' }, observer: {} },
		ctx.app.vault.configDir, () => true, false, 'full-access');
	assert.equal(run.permissions.canRead(join(actual, 'workspace.json')), false);
	assert.equal(run.permissions.canRead(join(ctx.cwd, ctx.app.vault.configDir, 'workspace.json')), false);
	assert.equal(run.permissions.canRead(join(ctx.cwd, 'notes.md')), true);
});

void test('Windows advertises the PowerShell version it selects, preferring 7 over 5.1', async (t) => {
	const { ctx } = await fixture(t);
	const run = await createRunContext(ctx.task, {
		cwd: ctx.cwd, signal: ctx.signal, model: { providerId: 'test', model: 'test' }, observer: {},
	}, ctx.app.vault.configDir);
	const builder = createContextBuilder(registry);
	const versionHint = async () => (await builder.build(run, [], 100_000)).tools
		.find(({ name }) => name === 'PowerShell')?.description;
	const binaries = new Set(['pwsh.exe', 'powershell.exe']);
	const access = fs.accessSync;
	const mock = t.mock.method(fs, 'accessSync', (path: fs.PathLike, mode?: number) => {
		const name = typeof path === 'string' ? basename(path) : '';
		if (name !== 'pwsh.exe' && name !== 'powershell.exe') return access(path, mode);
		if (!binaries.has(name)) throw new Error('解释器未安装');
	});
	const platform = process.platform;
	const originalPaths = { ProgramW6432: process.env.ProgramW6432, SystemRoot: process.env.SystemRoot };
	Object.defineProperty(process, 'platform', { value: 'win32' });
	process.env.ProgramW6432 = ctx.cwd;
	process.env.SystemRoot = ctx.cwd;
	syncBuiltinESMExports();
	try {
		assert.match(await versionHint() ?? '', /^使用真实的 PowerShell 7 /);
		binaries.delete('pwsh.exe');
		assert.match(await versionHint() ?? '', /^使用真实的 Windows PowerShell 5\.1 /);
		binaries.delete('powershell.exe');
		assert.equal(await versionHint(), undefined);
	} finally {
		mock.mock.restore();
		syncBuiltinESMExports();
		Object.defineProperty(process, 'platform', { value: platform });
		for (const [key, value] of Object.entries(originalPaths)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
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
	const refused = await execute(ctx, 'Bash', { command });
	assert.equal(refused.isError, true);
	assert.equal(refused.content, '用户未批准本次操作。');
	assert.equal(refused.shellStatus, undefined);
	await assert.rejects(readFile(join(ctx.cwd, 'marker.txt')), { code: 'ENOENT' });
	const result = await execute(ctx, 'Bash', { command });
	assert.equal(result.isError, false);
	assert.equal(result.shellStatus, 'success');
	assert.equal(await readFile(join(ctx.cwd, 'marker.txt'), 'utf8'), 'scribe verified');
	assert.equal((await execute(ctx, 'Bash', { command, cwd: outside })).isError, false);
	assert.equal(await readFile(join(outside, 'marker.txt'), 'utf8'), 'scribe verified');
	assert.deepEqual(approvals[2], { title: 'Bash', kind: 'shell', target: outside, after: command, humanRequired: true,
		reason: '此命令申请访问库外资料或联网。' });
	assert.equal((await execute(ctx, 'Bash', { command, cwd: denied })).isError, true);
	assert.equal((await execute(ctx, 'Bash', { command: 'echo text\u202E' })).isError, true);
	assert.equal(approvals.length, 3);
});

void test('配置受限终端前会重新核对插件私有目录和技能目录', async (t) => {
	const { ctx } = await fixture(t);
	const data = scribeDataPaths(ctx.cwd);
	await writeFile(data.root, '');
	await assert.rejects(macShellSandboxArgs(ctx), /数据目录位置已变化/u);
	await rm(data.root);
	await mkdir(data.root);
	await writeFile(data.skills, '');
	await assert.rejects(macShellSandboxArgs(ctx), /数据目录位置已变化/u);
});

void test('macOS Bash restricts vault commands until a single escalation is approved in every mode', {
	skip: !available('Bash') || !hasMacShellSandbox(),
}, async (t) => {
	const { ctx, denied } = await fixture(t);
	const config = join(ctx.cwd, 'plugin-config');
	const data = scribeDataPaths(ctx.cwd);
	const secret = join(denied, 'outside.txt');
	await Promise.all([mkdir(config), mkdir(data.cache, { recursive: true }), mkdir(data.skills, { recursive: true }),
		mkdir(data.memory, { recursive: true }), mkdir(join(ctx.cwd, 'drafts'))]);
	await Promise.all([
		writeFile(secret, 'private'),
		writeFile(join(config, 'private.txt'), 'config'),
		writeFile(join(ctx.cwd, 'lines.txt'), 'first\nsecond\n'),
		writeFile(data.settings, '{}'),
		writeFile(join(data.cache, 'private.txt'), 'cache'),
		writeFile(join(data.memory, 'private.txt'), 'memory'),
		writeFile(join(data.skills, 'example.md'), 'available skill'),
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
	const write = 'printf work > note.md';
	assert.equal((await execute(ctx, 'Bash', { command: write })).isError, true);
	await assert.rejects(readFile(join(ctx.cwd, 'note.md')), { code: 'ENOENT' });
	for (const command of ['cat link.txt', 'printf changed > link.txt', 'cat plugin-config/private.txt', 'cat lines.txt',
		'cat .scribe-ai/settings.json', 'cat .scribe-ai/cache/private.txt', 'cat .scribe-ai/memory/private.txt',
		'printf changed > .scribe-ai/state.json', connect]) {
		assert.equal((await execute(ctx, 'Bash', { command })).isError, true, command);
	}
	assert.match((await execute(ctx, 'Bash', { command: 'cat .scribe-ai/skills/example.md' })).content, /available skill/);
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
	const local = await execute(ctx, 'Bash', { command: write, vault_write: true });
	assert.equal(local.isError, false, local.content);
	assert.equal(await readFile(join(ctx.cwd, 'note.md'), 'utf8'), 'work');
	assert.equal(approvals[2]?.kind, 'vault-shell');
	assert.equal(approvals[2]?.humanRequired, true);
	assert.equal((await execute(ctx, 'Bash', { command: 'printf changed > AGENTS.md', vault_write: true })).isError, true);
	await assert.rejects(readFile(join(ctx.cwd, 'AGENTS.md')), { code: 'ENOENT' });
	assert.equal((await execute(ctx, 'Bash', { command: 'printf changed > drafts/AGENTS.md', vault_write: true })).isError, true);
	await assert.rejects(readFile(join(ctx.cwd, 'drafts', 'AGENTS.md')), { code: 'ENOENT' });

	ctx.permissions = { ...baseline, executionMode: 'full-access', canRead: () => true };
	approved = false;
	assert.equal((await execute(ctx, 'Bash', { command: 'printf blocked > never.txt', cwd: denied })).isError, true);
	await assert.rejects(readFile(join(denied, 'never.txt')), { code: 'ENOENT' });
	assert.equal(approvals.at(-1)?.humanRequired, true);
	approved = true;
	assert.equal((await execute(ctx, 'Bash', { command: connect, cwd: denied })).isError, false);
	assert.equal(approvals.length, 7);
});

void test('full access can waive approval for commands beyond the read-only sandbox and can revoke a prepared command', {
	skip: !available('Bash'),
}, async (t) => {
	const { ctx, outside } = await fixture(t);
	let confirm = false;
	ctx.permissions = await createPermissionPolicy(ctx.cwd, ctx.app.vault.configDir, [], undefined, 'full-access', true, () => confirm);
	ctx.approve = async () => assert.fail('an explicitly waived approval should not be requested');
	const command = { command: 'printf allowed > direct.txt', cwd: outside, elevated: true };
	assert.equal((await execute(ctx, 'Bash', command)).isError, false);
	assert.equal(await readFile(join(outside, 'direct.txt'), 'utf8'), 'allowed');
	if (hasMacShellSandbox()) {
		const write = { command: 'printf local > sandbox.txt' };
		assert.equal((await execute(ctx, 'Bash', write)).isError, true);
		assert.equal((await execute(ctx, 'Bash', { ...write, vault_write: true })).isError, false);
		assert.equal(await readFile(join(ctx.cwd, 'sandbox.txt'), 'utf8'), 'local');
	}
	const pending = await registry.find('Bash')!.prepare({ ...command, command: 'printf blocked > revoked.txt' }, ctx);
	assert.equal(pending.approval, undefined);
	confirm = true;
	await assert.rejects(async () => pending.run(), /审批设置已变化/u);
	await assert.rejects(readFile(join(outside, 'revoked.txt')), { code: 'ENOENT' });
});

void test('Bash without a native vault boundary requires approval before running', {
	skip: !available('Bash') || hasMacShellSandbox(),
}, async (t) => {
	const { ctx } = await fixture(t);
	ctx.permissions = { ...ctx.permissions, executionMode: 'full-access' };
	const approvals: ToolApproval[] = [];
	ctx.approve = async (approval) => {
		approvals.push(approval);
		return false;
	};
	const result = await execute(ctx, 'Bash', { command: 'printf work > note.md' });
	assert.equal(result.isError, true);
	assert.match(approvals[0]?.reason ?? '', /无法限制/);
	assert.equal(approvals[0]?.humanRequired, true);
	await assert.rejects(readFile(join(ctx.cwd, 'note.md')), { code: 'ENOENT' });
});

void test('stopping Bash terminates a running command', { skip: !available('Bash') }, async (t) => {
	const { ctx, controller } = await fixture(t);
	ctx.approve = async () => true;
	const command = "printf '停止前的诊断\\n' >&2; printf started > started.txt; sleep 30; printf finished > finished.txt";
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
	assert.equal(result.shellStatus, 'stopped');
	assert.match(result.content, /已停止/);
	assert.match(result.content, /停止前的诊断/);
	await assert.rejects(readFile(join(ctx.cwd, 'finished.txt')), { code: 'ENOENT' });
});

void test('PowerShell reports both live streams and returns the approved command result', { skip: !available('PowerShell') }, async (t) => {
	const { ctx, outside } = await fixture(t);
	ctx.approve = async () => true;
	let report!: (output: ShellOutputPreview) => void;
	const reported = new Promise<ShellOutputPreview>((resolve) => { report = resolve; });
	ctx.onShellOutput = (output) => { if (output.stdout && output.stderr) report(output); };
	const command = "[Console]::WriteLine((Get-Location).ProviderPath); [Console]::Error.WriteLine('等候中的错误输出'); "
		+ "while (-not (Test-Path 'preview-seen.txt')) { Start-Sleep -Milliseconds 25 }";
	const running = execute(ctx, 'PowerShell', { command, cwd: outside, timeout: 10_000 });
	const preview = await Promise.race([reported, running.then(() => undefined)]);
	if (preview) await writeFile(join(outside, 'preview-seen.txt'), '');
	const result = await running;
	assert.ok(preview, result.content);
	assert.ok(preview.stdout.includes(outside));
	assert.equal(preview.stderr, '等候中的错误输出');
	assert.equal(result.isError, false, result.content);
	assert.equal(result.shellStatus, 'success');
	assert.ok(result.content.includes(outside), result.content);
});

void test('shell previews batch bursts and cancel pending updates when the command finishes', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const reports: ShellOutputPreview[] = [];
	const output = captureShellOutput((preview) => reports.push(preview));
	for (let line = 1; line <= 10; line++) output.addStdout(Buffer.from(`第 ${line} 行\r\n`));
	const error = Buffer.from('报错');
	output.addStderr(error.subarray(0, 4));
	t.mock.timers.tick(249);
	assert.deepEqual(reports, []);
	t.mock.timers.tick(1);
	assert.deepEqual(reports, [{ stdout: '第 8 行\n第 9 行\n第 10 行', stderr: '报' }]);
	output.addStderr(error.subarray(4));
	output.stopReporting();
	t.mock.timers.tick(250);
	assert.equal(reports.length, 1);
	assert.equal(output.text().stderr, '报错');
});

void test('model tool results keep a 12,500-token preview and a full copy under the conversation cache', async (t) => {
	const { ctx } = await fixture(t);
	const cacheDirectory = scribeDataPaths(ctx.cwd).cache;
	const location = { cacheDirectory, conversationId: 'test', subagentId: 'worker-one' };
	const text = `开头\n${'界'.repeat(60_000)}\n末尾`;
	assert.ok(estimateResultTokens(text) > MAX_INLINE_TOKENS);
	const result = boundToolResult(text, 'Bash', location);
	assert.match(result, /开头/);
	assert.match(result, /末尾/);
	assert.match(result, /完整结果/);
	assert.ok(estimateResultTokens(result) <= MAX_INLINE_TOKENS);
	const path = /完整结果：([^。]+)/.exec(result)?.[1];
	assert.ok(path);
	assert.ok(path.startsWith(join(cacheDirectory, 'test', 'worker-one', 'scribe-ai-tools-')));
	assert.equal(basename(path), 'result.txt');
	assert.equal(fs.readFileSync(path, 'utf8'), text);
	assert.equal(boundToolResult('short', 'Bash'), 'short');
	assert.equal(boundToolResult(text, 'read', location), text);
	assert.equal(boundToolResult(text, 'Bash', { ...location, conversationId: '../outside' }), text);
});

void test('the executor saves the complete tool result even when a tool has a shorter preview limit', async (t) => {
	const { ctx } = await fixture(t);
	const cacheDirectory = scribeDataPaths(ctx.cwd).cache;
	const text = '开头\n' + '长正文'.repeat(30_000) + '\n末尾';
	const output = createToolExecutor(createToolRegistry([() => [{
		name: 'Fixture', description: 'Fixture', inputSchema: {}, isReadOnly: true, maxResultSizeChars: 800,
		prepare: () => ({ run: () => text }),
	}]]), cacheDirectory);
	const result = await output.execute({ name: 'Fixture', id: 'large', input: {} }, ctx);
	assert.equal(result.isError, false);
	assert.ok(result.content.length <= 800);
	assert.match(result.content, /开头[\s\S]*末尾/);
	const path = /完整结果：([^。]+)/.exec(result.content)?.[1];
	assert.ok(path);
	assert.equal(await readFile(path, 'utf8'), text);
	const blocked = await output.execute({ name: 'Fixture', id: 'bad-cache', input: {} },
		{ ...ctx, task: { ...ctx.task, request: { ...ctx.task.request, conversationId: '../invalid' } } });
	assert.match(blocked.content, /完整输出未能保存/);
	assert.ok(blocked.content.length <= 800);
});

void test('spill cleanup removes files older than the retention period and prunes empty roots', async (t) => {
	const base = await mkdtemp(join(tmpdir(), 'scribe-spill-check-'));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = await mkdtemp(join(base, 'scribe-ai-tools-'));
	const oldPath = join(root, 'old.txt');
	const freshPath = join(root, 'fresh.txt');
	await Promise.all([writeFile(oldPath, 'old'), writeFile(freshPath, 'fresh')]);
	const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
	await utimes(oldPath, old, old);
	await sweepSpillFiles({ baseDir: base, now: Date.now(), cleanupPeriodDays: 0 });
	assert.equal(fs.existsSync(oldPath), true);
	await sweepSpillFiles({ baseDir: base, now: Date.now(), cleanupPeriodDays: 30 });
	assert.equal(fs.existsSync(oldPath), false);
	assert.equal(fs.existsSync(freshPath), true);
	await rm(freshPath);
	await sweepSpillFiles({ baseDir: base, now: Date.now(), cleanupPeriodDays: 30 });
	assert.equal(fs.existsSync(root), false);
});

void test('startup removes expired cache outputs for this vault and leaves fresh files and other vaults alone', async (t) => {
	const { ctx, outside } = await fixture(t);
	const cacheDirectory = scribeDataPaths(ctx.cwd).cache;
	const text = '完整工具返回内容'.repeat(10_000);
	const save = (directory: string, conversationId: string) => {
		const path = /完整结果：([^。]+)/.exec(boundToolResult(text, 'Grep', { cacheDirectory: directory, conversationId }))?.[1];
		assert.ok(path);
		return path;
	};
	const old = save(cacheDirectory, 'old');
	const fresh = save(cacheDirectory, 'new');
	const other = save(scribeDataPaths(outside).cache, 'other');
	const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
	await Promise.all([utimes(old, past, past), utimes(other, past, past)]);
	const options = { cacheDirectory, baseDir: join(ctx.cwd, 'empty-legacy'), now: Date.now() };
	await sweepSpillFiles({ ...options, cleanupPeriodDays: 0 });
	assert.equal(fs.existsSync(old), true);
	await sweepSpillFiles(options);
	assert.equal(fs.existsSync(join(cacheDirectory, 'old')), false);
	assert.equal(fs.existsSync(fresh), true);
	assert.equal(fs.existsSync(other), true);
});

void test('排队、待续做、分支和草稿中的图片跨清理保留，删除最后一段引用时清除原图', async (t) => {
	const { ctx } = await fixture(t);
	const { conversations, cache } = scribeDataPaths(ctx.cwd);
	const store = createConversationStore(conversations, undefined, cache);
	const image = (conversationId: string) => saveCachedImage(ctx.cwd, { cacheDirectory: cache, conversationId },
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'screenshot');
	const screenshot = await image('first'), queued = await image('queue'), draft = await image('unsent'), unused = await image('unused');
	const ref = (path: string): NoteRef => ({ kind: 'file', path, pastedImage: true });
	const start = { type: 'start' as const, task: { id: 'run', status: 'pending' as const, createdAt: 1, updatedAt: 1,
		request: { conversationId: 'first', instruction: '查看附图', refs: [ref(screenshot)] } }, model: { providerId: 'test', model: 'test' } };
	await store.append('first', [start]);
	await store.enqueue('queue', { id: 'q', request: { conversationId: 'queue', instruction: '查看排队截图', refs: [ref(queued)] } });
	const fork = await store.fork('first', 'run');
	const release = retainDraftImages(store, 'unsent', [ref(draft)]);
	t.after(release);
	const keep = () => retainedImagePaths(store);
	const exists = (path: string) => fs.existsSync(join(ctx.cwd, path));
	const old = new Date(Date.now() - 40 * 86_400_000);
	for (const path of [screenshot, queued, draft, unused]) await utimes(join(ctx.cwd, path), old, old);
	await sweepSpillFiles({ baseDir: join(ctx.cwd, 'no-legacy'), cacheDirectory: cache }, keep);
	assert.deepEqual([screenshot, queued, draft, unused].map(exists), [true, true, true, false]);
	await clearSpillFiles(cache, keep);
	assert.deepEqual([screenshot, queued, draft].map(exists), [true, true, true]);
	await store.delete('first');
	assert.equal(exists(screenshot), true);
	await store.delete(fork.id);
	assert.equal(exists(screenshot), false);
	await store.delete('queue');
	assert.equal(exists(queued), false);
	release();
	await clearSpillFiles(cache, keep);
	assert.equal(exists(draft), false);
});

void test('background reads preserve split UTF-8, skip consumed bytes and mark gaps', () => {
	const output = captureShellOutput();
	const cursor = { stdout: 0, stderr: 0 };
	const tail = Buffer.from('新🙂');
	output.addStdout(tail.subarray(0, 5));
	assert.equal(output.readSince(cursor, false).stdout, '新');
	output.addStdout(tail.subarray(5));
	assert.equal(output.readSince(cursor, false).stdout, '🙂');
	assert.equal(output.readSince(cursor, false).stdout, '');
	output.addStdout(Buffer.from('界'.repeat(6_000) + '\n末尾'));
	const next = output.readSince(cursor, false).stdout;
	assert.match(next, /^界+\n…（已省略 \d+ 字节的新增输出）\n[\s\S]*末尾$/u);
	assert.doesNotMatch(next, /�/u);
	assert.equal(output.readSince(cursor, true).stdout, '');
});

void test('job output keeps a 256 KiB live window, 16 KiB settled tail and a bounded spill file', async (t) => {
	const { ctx } = await fixture(t);
	const cacheDirectory = scribeDataPaths(ctx.cwd).cache;
	const ring = new JobOutputRing({ cacheDirectory, conversationId: 'job-fixture' });
	t.after(() => ring.dispose());
	const total = 300_000;
	ring.appendText('stdout', 'a'.repeat(total));
	const live = ring.text().stdout;
	assert.match(live, /较早的输出已丢弃/);
	assert.ok(Buffer.byteLength(live, 'utf8') <= 262_144 + 40);
	const read = ring.readFrom({ stdout: 0, stderr: 0 }).stdout;
	assert.equal(read.lossy, true);
	assert.match(renderRingRead(read), /已省略 \d+ 字节的新增输出/);
	assert.ok(Buffer.byteLength(read.text, 'utf8') <= 262_144);
	const paths = ring.paths();
	assert.ok(paths[0]);
	assert.equal(fs.statSync(paths[0]).size, total);
	ring.end();
	ring.trimSettled({ stdout: 0, stderr: 0 });
	assert.ok(Buffer.byteLength(ring.text().stdout, 'utf8') > 16_384);
	ring.trimSettled({ stdout: total, stderr: 0 });
	assert.ok(Buffer.byteLength(ring.text().stdout, 'utf8') <= 16_384 + 40);
	const spill = ring.paths()[0];
	assert.ok(spill);
	assert.ok(spill.startsWith(join(cacheDirectory, 'job-fixture', 'root', 'scribe-ai-shell-')));
	assert.equal(basename(spill), 'stdout.log');
	ring.dispose();
	assert.equal(fs.existsSync(spill), true);
});

void test('background commands ignore the call timeout and keep running until stopped', { skip: !available('Bash') }, async (t) => {
	const { ctx, controller } = await fixture(t);
	const { executor: jobsExecutor, shellJobs } = createToolLayer();
	t.after(() => shellJobs.dispose());
	ctx.approve = async () => true;
	const result = await jobsExecutor.execute({ id: 'start', name: 'Bash', input: {
		command: 'sleep 30', run_in_background: true, timeout: 150,
	} }, ctx);
	assert.equal(result.isError, false, result.content);
	controller.abort();
	const owner = ctx.task.request.conversationId;
	const started = shellJobs.list(owner)[0];
	assert.ok(started);
	// The process timeout uses the real platform clock; fake timers cannot prove it did not fire.
	await setTimeout(500);
	assert.equal(shellJobs.get(owner, started.id)?.status, 'running');
	await shellJobs.stop(owner, started.id);
	assert.equal(shellJobs.get(owner, started.id)?.status, 'stopped');
});

void test('subagent shell jobs have isolated access and stop scopes, including saved output', { skip: !available('Bash') }, async (t) => {
	const { ctx } = await fixture(t);
	const conversationId = ctx.task.request.conversationId;
	const directory = join(ctx.cwd, 'conversations');
	const store = createConversationStore(directory);
	await store.append(conversationId, [{ type: 'start', task: ctx.task, model: { providerId: 'test', model: 'test' } }]);
	const permissions = await createPermissionPolicy(ctx.cwd, ctx.app.vault.configDir, [], () => true, 'full-access');
	const main = { ...ctx, permissions };
	const first = { ...main, subagentId: 'worker-one' };
	const second = { ...main, subagentId: 'worker-two' };
	const layer = createToolLayer(store.shellJobHistory);
	const { shellJobs: jobs } = layer;
	t.after(() => jobs.dispose());
	const run = (context: ToolContext, name: string, input: unknown, current = layer) => current.executor.execute({ id: name, name, input }, context);
	for (const child of [first, second]) {
		const launched = await run(child, 'Bash', { command: "printf '子任务内容\\n'; sleep 30", run_in_background: true });
		assert.equal(launched.isError, false, launched.content);
	}
	const [job, sibling] = jobs.list(conversationId);
	assert.equal(job?.subagentId, first.subagentId);
	assert.equal(sibling?.subagentId, second.subagentId);
	assert.ok(job && sibling);
	const input = { job_id: job.id };
	assert.equal((await run(second, 'ShellJobOutput', input)).isError, true);
	assert.equal((await run(second, 'ShellJobStop', input)).isError, true);
	const deadline = Date.now() + 4_000;
	while (!jobs.outputSnapshot(conversationId, job.id)?.includes('子任务内容') && Date.now() < deadline) await setTimeout(20);
	assert.match((await run(main, 'ShellJobOutput', input)).content, /子任务内容/u);
	assert.match((await run(first, 'ShellJobOutput', input)).content, /子任务内容/u);

	await jobs.stopSubagents(conversationId, new Set([first.subagentId]));
	assert.equal(jobs.get(conversationId, job.id)?.status, 'stopped');
	assert.equal(jobs.get(conversationId, sibling.id)?.status, 'running');
	assert.equal((await run(main, 'ShellJobStop', { job_id: sibling.id })).isError, false);
	await jobs.dispose();
	const reopened = createToolLayer(createConversationStore(directory).shellJobHistory);
	t.after(() => reopened.shellJobs.dispose());
	assert.match((await run(first, 'ShellJobOutput', input, reopened)).content, /子任务内容/u);
	assert.equal((await run(second, 'ShellJobOutput', input, reopened)).isError, true);
});

void test('background commands accept a ten-minute wait argument and reject longer ones', { skip: !available('Bash') }, async (t) => {
	const { ctx } = await fixture(t);
	const { executor, shellJobs } = createToolLayer();
	t.after(() => shellJobs.dispose());
	ctx.approve = async () => true;
	const accepted = await executor.execute({ id: 'accepted', name: 'Bash', input: {
		command: 'printf accepted', run_in_background: true, timeout: 600_000,
	} }, ctx);
	assert.equal(accepted.isError, false, accepted.content);
	const rejected = await executor.execute({ id: 'rejected', name: 'Bash', input: {
		command: 'printf rejected', run_in_background: true, timeout: 600_001,
	} }, ctx);
	assert.equal(rejected.isError, true);
	assert.match(rejected.content, /600000/);
});

void test('PowerShell background results and their read state survive reopening', { skip: !available('PowerShell') }, async (t) => {
	const { ctx } = await fixture(t);
	const owner = ctx.task.request.conversationId;
	const directory = join(ctx.cwd, 'conversations');
	const store = createConversationStore(directory);
	await store.append(owner, [{ type: 'start', task: ctx.task, model: { providerId: 'test', model: 'test' } }]);
	const { executor: jobsExecutor, shellJobs } = createToolLayer(store.shellJobHistory);
	t.after(() => shellJobs.dispose());
	ctx.approve = async (approval) => {
		assert.equal(approval.background, true);
		return true;
	};
	const command = "while (-not (Test-Path 'allow-exit.txt')) { Start-Sleep -Milliseconds 25 }; "
		+ "[Console]::WriteLine('最终输出'); [Console]::Error.WriteLine('最后诊断'); exit 3";
	const result = await jobsExecutor.execute({ id: 'start', name: 'PowerShell', input: {
		command, run_in_background: true, timeout: 15_000,
	} }, ctx);
	assert.equal(result.isError, false, result.content);
	const started = shellJobs.list(owner)[0];
	assert.ok(started && result.content.includes(started.id));
	assert.equal(started.status, 'running');
	await writeFile(join(ctx.cwd, 'allow-exit.txt'), '');
	const deadline = Date.now() + 10_000;
	while (shellJobs.get(owner, started.id)?.status === 'running' && Date.now() < deadline) await setTimeout(25);
	const job = shellJobs.get(owner, started.id);
	assert.equal(job?.status, 'failed', job?.content);
	assert.match(job?.content ?? '', /退出状态 3[\s\S]*最终输出[\s\S]*最后诊断/);
	assert.deepEqual(shellJobs.listUnread(owner), [{ id: started.id, status: 'failed' }]);
	await shellJobs.dispose();
	const reopen = () => new ShellJobs(createConversationStore(directory).shellJobHistory);
	const reopened = reopen();
	t.after(() => reopened.dispose());
	assert.deepEqual(reopened.list(owner), []);
	assert.deepEqual(await reopened.listSaved(owner), [{ ...job, unread: true }]);
	assert.deepEqual(reopened.listUnread(owner), [{ id: started.id, status: 'failed' }]);
	await reopened.markRead(owner, started.id);
	assert.deepEqual(reopened.listUnread(owner), []);
	await reopened.dispose();
	const reopenedAgain = reopen();
	t.after(() => reopenedAgain.dispose());
	await reopenedAgain.listSaved(owner);
	assert.deepEqual(reopenedAgain.listUnread(owner), []);
	assert.equal((await reopenedAgain.getSaved(owner, started.id))?.content, job.content);
});

void test('PowerShell hands off its running process and collected output', {
	skip: !available('PowerShell'), timeout: 15_000,
}, async (t) => {
	const { ctx, controller } = await fixture(t);
	const { executor: jobsExecutor, shellJobs } = createToolLayer();
	t.after(async () => {
		controller.abort();
		await shellJobs.dispose();
	});
	let approvals = 0;
	ctx.approve = async (approval) => {
		approvals++;
		assert.equal(approval.background, undefined);
		return true;
	};
	const delay = setTimeout;
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const command = "Add-Content -LiteralPath 'launches.txt' -Value $PID; [Console]::WriteLine('前台输出'); "
		+ "[Console]::Error.WriteLine('前台诊断'); while (-not (Test-Path 'allow-exit.txt')) { Start-Sleep -Milliseconds 25 }; "
		+ "[Console]::WriteLine('后台输出')";
	const running = jobsExecutor.execute({ id: 'start', name: 'PowerShell', input: { command, timeout: 20_000 } }, ctx);
	const marker = join(ctx.cwd, 'launches.txt');
	const deadline = Date.now() + 10_000;
	let pid = '';
	while (!(pid = (await readFile(marker, 'utf8').catch(() => '')).trim())) {
		assert.ok(Date.now() < deadline, 'PowerShell did not start');
		await delay(25);
	}
	t.mock.timers.tick(FOREGROUND_WAIT_MS);
	const receipt = await running;
	assert.equal(receipt.isError, false, receipt.content);
	const owner = ctx.task.request.conversationId;
	const job = shellJobs.list(owner)[0];
	assert.ok(job && receipt.content.includes(job.id));
	controller.abort();
	await writeFile(join(ctx.cwd, 'allow-exit.txt'), '');
	while (shellJobs.get(owner, job.id)?.status === 'running') {
		assert.ok(Date.now() < deadline, 'PowerShell did not finish in the background');
		await delay(25);
	}
	assert.equal(shellJobs.get(owner, job.id)?.status, 'success');
	const output = shellJobs.read(owner, job.id);
	assert.match(output?.stdout ?? '', /前台输出[\s\S]*后台输出/u);
	assert.match(output?.stderr ?? '', /前台诊断/u);
	assert.equal((await readFile(marker, 'utf8')).trim(), pid);
	assert.equal(approvals, 1);
});

void test('unread results remain available after other chats fill the live cache', async (t) => {
	const { ctx } = await fixture(t);
	const store = createConversationStore(join(ctx.cwd, 'conversations'));
	const owner = ctx.task.request.conversationId;
	const other = 'other-chat';
	const model = { providerId: 'test', model: 'test' };
	for (const conversationId of [owner, other]) {
		await store.append(conversationId, [{
			type: 'start', task: { ...ctx.task, request: { ...ctx.task.request, conversationId } }, model,
		}]);
	}
	const jobs = new ShellJobs(store.shellJobHistory);
	t.after(() => jobs.dispose());
	const finish = async (conversationId: string) => {
		const output = captureShellOutput();
		const command = `echo ${conversationId}`;
		const id = jobs.start(conversationId, 'Bash', output,
			() => Promise.resolve({ content: '已结束', shellStatus: 'success', exitCode: 0 }), command);
		output.addStdout(Buffer.from('保留输出\n'));
		await jobs.stop(conversationId, id);
		const saved = await jobs.getSaved(conversationId, id);
		assert.equal(saved?.command, command);
		assert.equal(saved?.exitCode, 0);
		assert.ok(saved?.startedAt !== undefined && saved.finishedAt !== undefined);
		assert.equal(saved.finishedAt >= saved.startedAt, true);
		assert.equal(jobs.outputSnapshot(conversationId, id), '保留输出\n');
		return id;
	};
	const original = await finish(owner);
	for (let count = 0; count < 32; count++) await finish(other);
	assert.equal(jobs.get(owner, original), undefined);
	assert.equal((await jobs.getSaved(owner, original))?.content, '已结束');
	assert.deepEqual(jobs.listUnread(owner), [{ id: original, status: 'success' }]);
	assert.equal(jobs.listUnread(other).length, 32);
	let readSaved = false;
	const marking = jobs.markRead(owner, original).then(() => { readSaved = true; });
	await jobs.dispose();
	assert.equal(readSaved, true);
	await marking;
	const reopened = new ShellJobs(store.shellJobHistory);
	t.after(() => reopened.dispose());
	assert.equal((await reopened.listSaved(owner))[0]?.content, '已结束');
	assert.deepEqual(reopened.listUnread(owner), []);
	await reopened.listSaved(other);
	assert.equal(reopened.listUnread(other).length, 32);
});

void test('a full background queue leaves an existing command in the foreground', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const jobs = new ShellJobs();
	t.after(() => jobs.dispose());
	for (let i = 0; i < 8; i++) {
		jobs.start('busy', 'Bash', captureShellOutput(), (signal) => new Promise((resolve) => {
			signal.addEventListener('abort', () => resolve({ content: '已停止', shellStatus: 'stopped' }), { once: true });
		}));
	}
	let finish!: () => void;
	const result = new Promise<{ content: string; shellStatus: 'success' }>((resolve) => {
		finish = () => resolve({ content: '原命令结束', shellStatus: 'success' });
	});
	const foreground = jobs.waitInForeground('pending', 'Bash', captureShellOutput(), new AbortController().signal,
		() => ({ result, isRunning: () => true }));
	t.mock.timers.tick(FOREGROUND_WAIT_MS);
	assert.deepEqual(jobs.list('pending'), []);
	finish();
	assert.deepEqual(await foreground, await result);
});

void test('a foreground command with no free slot is timed out at its wait deadline', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const jobs = new ShellJobs();
	t.after(() => jobs.dispose());
	for (let i = 0; i < 8; i++) {
		jobs.start('busy', 'Bash', captureShellOutput(), (signal) => new Promise((resolve) => {
			signal.addEventListener('abort', () => resolve({ content: '已停止', shellStatus: 'stopped' }), { once: true });
		}));
	}
	const foreground = jobs.waitInForeground('pending', 'Bash', captureShellOutput(), new AbortController().signal,
		(signal) => ({
			isRunning: () => true,
			result: new Promise((resolve) => {
				signal.addEventListener('abort', () => resolve({ content: '命令已超时。', shellStatus: 'timed-out' }), { once: true });
			}),
		}), 'sleep 1', 100);
	t.mock.timers.tick(100);
	const result = await foreground;
	assert.ok(typeof result !== 'string');
	assert.equal(result.shellStatus, 'timed-out');
});

const longCommands = {
	Bash: [
		"printf '输出开头\\n'; printf '界%.0s' {1..5200}; printf '\\n输出末尾\\n'",
		"{ printf '错误开头\\n'; printf '错%.0s' {1..5200}; printf '\\n最后两行\\n最后一行\\n'; } >&2",
		'exit 7',
	],
	PowerShell: [
		"[Console]::WriteLine('输出开头'); [Console]::WriteLine(('界' * 5200)); [Console]::WriteLine('输出末尾')",
		"[Console]::Error.WriteLine('错误开头'); [Console]::Error.WriteLine(('错' * 5200))",
		"[Console]::Error.WriteLine('最后两行'); [Console]::Error.WriteLine('最后一行'); exit 7",
	],
};

for (const [name, commands] of Object.entries(longCommands)) {
	void test(`${name} preserves both ends of long stdout and stderr on failure`, { skip: !available(name) }, async (t) => {
		const { ctx } = await fixture(t);
		ctx.approve = async () => true;
		const result = await execute(ctx, name, { command: commands.join('; ') });
		assert.equal(result.shellStatus, 'failed', result.content);
		assert.equal(result.isError, true);
		assert.match(result.content, /退出状态 7/);
		assert.match(result.content, /输出开头[\s\S]*输出中间已截断[\s\S]*输出末尾/);
		assert.match(result.content, /错误开头[\s\S]*输出中间已截断[\s\S]*最后两行\r?\n最后一行\s*$/);
		assert.equal(result.content.match(/输出中间已截断/g)?.length, 2);
		assert.doesNotMatch(result.content, /�/);
		assert.ok(Buffer.byteLength(result.content) < 30_000);
	});
}

void test('Bash distinguishes a timeout from a failed launch', { skip: !available('Bash') }, async (t) => {
	const { ctx } = await fixture(t);
	ctx.approve = async () => true;
	const timedOut = await execute(ctx, 'Bash', { command: 'sleep 30', timeout: 100 });
	assert.equal(timedOut.shellStatus, 'timed-out', timedOut.content);
	assert.match(timedOut.content, /已超时/);

	const spawn = childProcess.spawn;
	const mock = t.mock.method(childProcess, 'spawn', () => spawn(join(ctx.cwd, 'missing-shell')));
	syncBuiltinESMExports();
	try {
		const result = await execute(ctx, 'Bash', { command: 'printf hello' });
		assert.equal(result.shellStatus, 'start-failed', result.content);
		assert.match(result.content, /启动失败.*\n.*ENOENT/);
	} finally {
		mock.mock.restore();
		syncBuiltinESMExports();
	}
});
