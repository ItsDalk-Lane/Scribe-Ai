import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import type { PreparedTool, ToolContext, ToolDefinition, ToolModule } from '../../types';
import { fileToolInput, requiredText } from '../support/fileAccess';
import { resolveToolPath } from '../support/pathUtils';
import { hasMacShellSandbox, macSandboxExecutable, macShellSandboxArgs } from './macosShellSandbox';

type ShellName = 'Bash' | 'PowerShell';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const STREAM_LIMIT = 14_000;
const windows = process.platform === 'win32';

function executable(name: ShellName): string | undefined {
	let candidates: string[];
	if (windows) {
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

function shellEnvironment(): NodeJS.ProcessEnv {
	const keep = new Set([
		'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'SYSTEMROOT', 'WINDIR',
		'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
	]);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.has(key.toUpperCase()) || key.startsWith('LC_')));
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

function outputCapture() {
	const prefix: Buffer[] = [];
	let size = 0;
	return {
		add: (chunk: Buffer) => {
			if (size < STREAM_LIMIT) prefix.push(chunk.subarray(0, STREAM_LIMIT - size));
			size += chunk.length;
		},
		text() {
			const content = Buffer.concat(prefix).toString('utf8');
			return size > STREAM_LIMIT ? `${content}\n…（命令输出已截断）` : content;
		},
	};
}

async function runShell(
	name: ShellName,
	binary: string,
	command: string,
	ctx: ToolContext,
	cwd: string,
	timeout: number,
	sandboxArgs?: string[],
): Promise<string> {
	ctx.signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const stdout = outputCapture();
		const stderr = outputCapture();
		const commandArgs = shellArgs(name, command);
		const env = shellEnvironment();
		if (sandboxArgs) env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
		const child = spawn(sandboxArgs ? macSandboxExecutable : binary, sandboxArgs ? [...sandboxArgs, binary, ...commandArgs] : commandArgs, {
			cwd,
			detached: !windows,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		let timedOut = false;
		let drain: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => stopProcessTree(child);
		const deadline = setTimeout(() => {
			timedOut = true;
			stopProcessTree(child);
		}, timeout);
		ctx.signal.addEventListener('abort', onAbort, { once: true });

		const cleanup = () => {
			clearTimeout(deadline);
			clearTimeout(drain);
			ctx.signal.removeEventListener('abort', onAbort);
		};
		child.stdout.on('data', stdout.add);
		child.stderr.on('data', stderr.add);
		child.once('error', (error) => {
			cleanup();
			reject(error);
		});
		child.once('exit', () => {
			clearTimeout(deadline);
			if (!windows) stopProcessTree(child);
			drain = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
			}, 1_000);
		});
		child.once('close', (code, signal) => {
			cleanup();
			const errors = stderr.text();
			const errorOutput = errors ? `错误输出\n${errors}` : '';
			const failed = timedOut || code !== 0;
			const output = [
				timedOut ? '命令已超时。' : `命令退出状态 ${code ?? signal ?? '未知'}。`,
				...(failed ? [errorOutput, stdout.text()] : [stdout.text(), errorOutput]),
				failed && sandboxArgs && !timedOut
					? '命令在受限环境中运行。确需访问库外或联网时，先核对已执行的步骤，再用 elevated 申请所需权限。'
					: '',
			].filter(Boolean).join('\n');
			if (ctx.signal.aborted) reject(new Error('任务已停止。'));
			else if (failed) reject(new Error(output));
			else resolve(output);
		});
	});
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

function shellTool(name: ShellName): ToolDefinition {
	return {
		name,
		description: `使用真实的 ${name} 执行无需交互输入的本地命令。普通命令优先在笔记库内离线运行，访问库外或联网需要额外权限。文件操作优先使用专用文件工具。`,
		isReadOnly: false,
		isAvailable: () => executable(name) !== undefined,
		maxResultSizeChars: 30_000,
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: '要执行的完整命令。' },
				cwd: { type: 'string', description: '工作目录。省略或留空时使用当前笔记库。' },
				elevated: { type: 'boolean', description: '仅在命令需要访问库外文件或联网时设为 true，以申请本次命令的额外权限。' },
				timeout: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT, description: '超时毫秒数，默认 120000。' },
				description: { type: 'string', description: '命令用途的简短说明。' },
			},
			required: ['command'],
			additionalProperties: false,
		},
		async prepare(input, ctx) {
			const args = fileToolInput(input, ['command', 'cwd', 'elevated', 'timeout', 'description']);
			const command = requiredText(args, 'command');
			if (hidesCommandText(command)) throw new Error('命令包含会妨碍确认的不可见控制符。');
			if (args.description !== undefined) requiredText(args, 'description');
			if (args.elevated !== undefined && typeof args.elevated !== 'boolean') throw new Error('elevated 必须是布尔值。');
			const timeout = args.timeout === undefined ? DEFAULT_TIMEOUT : args.timeout;
			if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) {
				throw new Error('timeout 必须是 1 至 600000 之间的毫秒整数。');
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
			const restricted = limited && inVault && !args.elevated && name === 'Bash' && hasMacShellSandbox();
			const reason = limited && (!inVault || args.elevated
				? '此命令申请访问库外资料或联网。'
				: '此系统或命令环境无法限制在笔记库内，运行前需要确认。');
			const permission: Pick<PreparedTool, 'approval' | 'independent'> = restricted || mode === 'full-access'
				? { independent: true }
				: { approval: { title: name, target: cwd.absolutePath, after: command, kind: 'shell', ...(reason ? { reason } : {}) } };
			return {
				...permission,
				async run() {
					const current = await resolveToolPath(cwdContext, requestedCwd, 'read');
					if (!current.stat?.isDirectory() || current.absolutePath !== cwd.absolutePath
						|| current.stat.ino !== cwd.stat?.ino || current.stat.dev !== cwd.stat?.dev) {
						throw new Error('工作目录已变化，请重新确认命令。');
					}
					const sandboxArgs = restricted ? await macShellSandboxArgs(ctx) : undefined;
					return runShell(name, binary, command, ctx, current.absolutePath, timeout, sandboxArgs);
				},
			};
		},
	};
}

export const shellTools: ToolModule = () => [shellTool('Bash'), shellTool('PowerShell')];
