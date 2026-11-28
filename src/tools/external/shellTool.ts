import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { clearTimeout, setTimeout } from 'node:timers';
import type { PreparedTool, ShellStatus, ToolDefinition } from '../../types';
import { fileToolInput, requiredText } from '../support/fileAccess';
import { resolveToolPath } from '../support/pathUtils';
import { hasMacShellSandbox, macSandboxExecutable, macShellSandboxArgs } from './macosShellSandbox';
import { captureShellOutput } from './shellOutput';
import { FOREGROUND_WAIT_MS } from './shellJobs';
import type { ShellExecution, ShellJobs } from './shellJobs';
import type { ShellOutputCapture } from './shellOutput';

type ShellName = 'Bash' | 'PowerShell';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const windows = process.platform === 'win32';

function executable(name: ShellName): string | undefined {
	let candidates: string[];
	if (process.platform === 'win32') {
		const programFiles = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
			.filter((directory): directory is string => directory !== undefined && isAbsolute(directory));
		const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
		candidates = name === 'Bash'
			? programFiles.map((directory) => join(directory, 'Git', 'bin', 'bash.exe'))
			: [
				...programFiles.map((directory) => join(directory, 'PowerShell', '7', 'pwsh.exe')),
				join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			];
	} else {
		candidates = name === 'Bash'
			? ['/bin/bash', '/usr/bin/bash']
			: ['/usr/bin/pwsh', '/opt/microsoft/powershell/7/pwsh', '/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh'];
	}
	return candidates.find((candidate) => {
		if (!isAbsolute(candidate)) return false;
		try {
			accessSync(candidate, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

function shellEnvironment(restricted = false): NodeJS.ProcessEnv {
	if (restricted) return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
	const keep = [
		'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'SystemRoot', 'windir',
		'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
	];
	const env = Object.fromEntries(keep.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
	if (!windows) {
		env.PATH = [...(env.PATH ?? '/usr/bin:/bin').split(delimiter), '/usr/local/bin', '/opt/homebrew/bin'].join(delimiter);
	}
	env.POWERSHELL_TELEMETRY_OPTOUT = '1';
	env.POWERSHELL_UPDATECHECK = 'Off';
	return env;
}

function shellArgs(name: ShellName, command: string): string[] {
	if (name === 'Bash') return ['--noprofile', '--norc', '-c', command];
	const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n' + command;
	return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function stopProcessTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (windows) {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
		const fallback = () => { child.kill('SIGKILL'); };
		const terminator = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
			stdio: 'ignore', windowsHide: true, env: shellEnvironment(),
		});
		terminator.once('error', fallback);
		terminator.once('close', (code) => { if (code !== 0 && child.exitCode === null && child.signalCode === null) fallback(); });
	} else {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		}
	}
}

function startFailure(error: unknown) {
	return { shellStatus: 'start-failed' as const, content: `命令启动失败。\n${error instanceof Error ? error.message : String(error)}` };
}

function runShell(
	name: ShellName,
	binary: string,
	command: string,
	signal: AbortSignal,
	cwd: string,
	timeout: number | undefined,
	output: ShellOutputCapture,
	sandboxArgs?: string[],
): ShellExecution {
	signal.throwIfAborted();
	const commandArgs = shellArgs(name, command);
	const env = shellEnvironment(Boolean(sandboxArgs));
	let child: ChildProcessByStdio<null, Readable, Readable>;
	try {
		child = spawn(sandboxArgs ? macSandboxExecutable : binary, sandboxArgs ? [...sandboxArgs, binary, ...commandArgs] : commandArgs, {
			cwd,
			detached: !windows,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
	} catch (error) {
		return { result: Promise.resolve(startFailure(error)), isRunning: () => false };
	}
	let termination: 'timed-out' | 'stopped' | undefined;
	let settled = false;
	const result = new Promise<{ content: string; shellStatus: ShellStatus; exitCode?: number | null }>((resolve) => {
		let drain: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			termination ??= signal.reason === 'timed-out' ? 'timed-out' : 'stopped';
			stopProcessTree(child);
		};
		const deadline = timeout === undefined ? undefined : setTimeout(() => {
			termination ??= 'timed-out';
			stopProcessTree(child);
		}, timeout);
		signal.addEventListener('abort', onAbort, { once: true });

		const cleanup = () => {
			settled = true;
			clearTimeout(deadline);
			clearTimeout(drain);
			output.stopReporting();
			signal.removeEventListener('abort', onAbort);
		};
		const finish = (shellStatus: ShellStatus, summary: string, exitCode?: number | null) => {
			cleanup();
			const { stdout, stderr } = output.text();
			const retry = shellStatus === 'failed' && sandboxArgs
				? '命令在受限环境中运行。先核对已执行的步骤，修改库内笔记优先使用文件工具；确需命令写入时用 vault_write 申请，访问库外或联网用 elevated 申请。'
				: '';
			const content = [summary, retry, stdout, stderr && `错误输出\n${stderr}`].filter(Boolean).join('\n');
			resolve({ content, shellStatus, exitCode });
		};
		child.stdout.on('data', output.addStdout);
		child.stderr.on('data', output.addStderr);
		child.once('error', (error) => {
			if (child.pid !== undefined) finish(termination ?? 'failed', error.message);
			else {
				cleanup();
				resolve(startFailure(error));
			}
		});
		child.once('exit', () => {
			clearTimeout(deadline);
			if (!windows) stopProcessTree(child);
			drain = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
			}, 1_000);
		});
		child.once('close', (code, exitSignal) => {
			const shellStatus = termination ?? (code === 0 ? 'success' : 'failed');
			const summary = shellStatus === 'timed-out' ? '命令已超时。'
				: shellStatus === 'stopped' ? '命令已停止。' : `命令退出状态 ${code ?? exitSignal ?? '未知'}。`;
			finish(shellStatus, summary, code);
		});
	});
	return {
		result,
		isRunning: () => !settled && !termination && child.pid !== undefined && child.exitCode === null && child.signalCode === null,
	};
}

function hidesCommandText(command: string): boolean {
	return /\r(?!\n)/.test(command) || Array.from(command).some((character) => {
		const code = character.charCodeAt(0);
		return (code < 32 && code !== 9 && code !== 10 && code !== 13)
			|| (code >= 0x7f && code <= 0x9f)
			|| code === 0x061c || code === 0x200e || code === 0x200f
			|| (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
	});
}

function shellTool(name: ShellName, jobs?: ShellJobs): ToolDefinition {
	return {
		name,
		get description() {
			const binary = process.platform === 'win32' && name === 'PowerShell' ? executable(name) : undefined;
			// Windows 只在 PowerShell 7 安装目录和系统自带的 5.1 目录中查找。
			const interpreter = binary ? (basename(binary) === 'pwsh.exe' ? 'PowerShell 7' : 'Windows PowerShell 5.1') : name;
			return `使用真实的 ${interpreter} 执行无需交互输入的本地命令。受限命令默认在笔记库内只读离线运行。命令写入、访问库外或联网需要额外权限。笔记编辑优先使用专用文件工具。`;
		},
		isReadOnly: false,
		isAvailable: () => executable(name) !== undefined,
		maxResultSizeChars: 30_000,
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: '要执行的完整命令。' },
				cwd: { type: 'string', description: '工作目录。省略或留空时使用当前笔记库。' },
				vault_write: { type: 'boolean', description: '需要在离线沙箱内用命令写入普通笔记库文件时设为 true，默认由用户确认。' },
				elevated: { type: 'boolean', description: '仅在命令需要访问库外文件或联网时设为 true，默认由用户确认。' },
				timeout: {
					type: 'integer', minimum: 1, maximum: MAX_TIMEOUT,
					description: `前台等待上限毫秒数，默认 ${DEFAULT_TIMEOUT}，最长 ${MAX_TIMEOUT}。显式后台运行不使用这个时限。`,
				},
				description: { type: 'string', description: '命令用途的简短说明。' },
				...(jobs && { run_in_background: {
					type: 'boolean', description: `仅在用户明确要求立即后台运行时设为 true；后台任务没有运行时限。否则前台最多等待 ${FOREGROUND_WAIT_MS / 1000} 秒，仍在运行且有后台名额时移交原命令并返回编号；timeout 只约束这次前台等待。`,
				} }),
			},
			required: ['command'],
			additionalProperties: false,
		},
		async prepare(input, ctx) {
			const args = fileToolInput(input, ['command', 'cwd', 'elevated', 'vault_write', 'timeout', 'description', 'run_in_background']);
			const command = requiredText(args, 'command');
			if (hidesCommandText(command)) throw new Error('命令包含会妨碍确认的不可见控制符。');
			if (args.description !== undefined) requiredText(args, 'description');
			if (args.elevated !== undefined && typeof args.elevated !== 'boolean') throw new Error('elevated 必须是布尔值。');
			if (args.vault_write !== undefined && typeof args.vault_write !== 'boolean') throw new Error('vault_write 必须是布尔值。');
			if (args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') {
				throw new Error('run_in_background 必须是布尔值。');
			}
			const background = args.run_in_background === true ? jobs : undefined;
			if (args.run_in_background && !background) throw new Error('后台运行不可用。');
			const timeout = args.timeout === undefined ? DEFAULT_TIMEOUT : args.timeout;
			if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) {
				throw new Error(`timeout 必须是 1 至 ${MAX_TIMEOUT} 之间的毫秒整数。`);
			}
			const binary = executable(name);
			if (!binary) throw new Error(`找不到 ${name} 解释器。`);
			const cwdArg = args.cwd;
			const requestedCwd = cwdArg === undefined || (typeof cwdArg === 'string' && !cwdArg.trim())
				? ctx.cwd : requiredText(args, 'cwd');
			const { permissions } = ctx;
			const mode = permissions.executionMode;
			const limited = mode === 'ask' || mode === 'auto-review';
			const cwdContext = limited ? {
				...ctx, permissions: {
					...permissions,
					canRead: (path: string) => permissions.canRead(path) || permissions.canRequestPath?.(path, 'read') === true,
				},
			} : ctx;
			const cwd = await resolveToolPath(cwdContext, requestedCwd, 'read');
			if (!cwd.stat?.isDirectory()) throw new Error('命令工作目录必须是文件夹。');
			const inVault = cwd.vaultPath !== undefined && permissions.canRead(cwd.requestedPath) && permissions.canRead(cwd.absolutePath);
			const restricted = Boolean(mode) && inVault && !args.elevated && name === 'Bash' && hasMacShellSandbox();
			const vaultWrite = args.vault_write === true;
			if (vaultWrite && !restricted) throw new Error('当前命令无法限制在笔记库内。请使用文件编辑工具，或另行申请解除限制。');
			const reason = restricted && vaultWrite ? '此命令可修改或删除库内笔记。执行范围限于当前笔记库，网络仍关闭。'
				: (!inVault || args.elevated
					? '此命令申请访问库外资料或联网。'
					: '此系统或命令环境无法限制在笔记库内，运行前需要确认。');
			const beyondReadOnly = !restricted || vaultWrite;
			const permission: Pick<PreparedTool, 'approval' | 'independent'> = !beyondReadOnly || permissions.canSkipFullAccessApproval?.()
				? { independent: true }
				: { approval: { title: name, target: cwd.absolutePath, after: command, kind: restricted ? 'vault-shell' : 'shell',
					humanRequired: true, ...(background && { background: true }), reason,
				} };
			return {
				...permission,
				...(permission.approval && { approvalIdentity: JSON.stringify([binary, cwd.stat.dev, cwd.stat.ino, timeout, Boolean(background)]) }),
				async run() {
					const current = await resolveToolPath(cwdContext, requestedCwd, 'read');
					if (!current.stat?.isDirectory() || current.absolutePath !== cwd.absolutePath
						|| current.stat.ino !== cwd.stat?.ino || current.stat.dev !== cwd.stat?.dev) {
						throw new Error('工作目录已变化，请重新确认命令。');
					}
					const sandboxArgs = restricted ? await macShellSandboxArgs(ctx, vaultWrite) : undefined;
					ctx.signal.throwIfAborted();
					if (beyondReadOnly && permission.independent && !permissions.canSkipFullAccessApproval?.()) {
						throw new Error('完全访问的审批设置已变化，请重新请求执行命令。');
					}
					const output = captureShellOutput(background ? undefined : ctx.onShellOutput);
					const run = (signal: AbortSignal, deadline?: number) =>
						runShell(name, binary, command, signal, current.absolutePath, deadline, output, sandboxArgs);
					const owner = ctx.task.request.conversationId;
					const result = background ? background.start(owner, name, output, (signal) => run(signal).result, command, ctx.subagentId)
						: jobs && timeout > FOREGROUND_WAIT_MS
							? await jobs.waitInForeground(owner, name, output, ctx.signal, run, command, timeout, ctx.subagentId)
							: await run(ctx.signal, timeout).result;
					if (typeof result !== 'string') return result;
					return `后台任务编号：${result}。后台任务没有运行时限。用 ShellJobOutput 查看已有及新增输出或最终结果，用 ShellJobStop 停止。`;
				},
			};
		},
	};
}

export function shellTools(jobs?: ShellJobs): ToolDefinition[] {
	return [shellTool('Bash', jobs), shellTool('PowerShell', jobs)];
}
