import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { PreparedTool, ToolContext } from '../../types';
import { authorizedLineRange, isWithinPath, recheckToolPath, resolveToolPath } from './pathUtils';
import type { ResolvedToolPath } from './pathUtils';
import { captureNoteChange } from './noteChange';
import { WRITING_RULE_FILENAME } from '../../orchestration/context/writingRules';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const TEXT_LINE_BREAK = /\r\n|[\r\n]/u;
const committingExternalFiles = new Set<string>();

export function fileFingerprint(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export function fileToolInput(input: unknown, fields: string[]): Record<string, unknown> {
	if (input === null || typeof input !== 'object' || Array.isArray(input)
		|| Object.keys(input).some((key) => !fields.includes(key))) {
		throw new Error('工具参数无效。');
	}
	return input as Record<string, unknown>;
}

export function requiredText(input: Record<string, unknown>, key: string, allowEmpty = false): string {
	const value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined;
	if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`参数 ${key} 必须是有效的文本。`);
	return value;
}

export function checkTextSize(text: string): void {
	if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('文件超过 2 MB 的文本处理限制。');
	if (text.includes('\0')) throw new Error('文件包含二进制数据，无法按文本处理。');
}

export async function openToolFile(path: ResolvedToolPath) {
	const file = await open(path.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const current = await file.stat();
		if (!current.isFile() || current.ino !== path.stat?.ino || current.dev !== path.stat?.dev
			|| (path.cacheOutput && current.nlink !== 1)) {
			throw new Error('文件位置或状态已变化，请重新确认。');
		}
		return { file, size: current.size };
	} catch (error) {
		await file.close();
		throw error;
	}
}

async function readDiskFile(ctx: ToolContext, path: ResolvedToolPath): Promise<Buffer> {
	const { file, size } = await openToolFile(path);
	try {
		if (size > MAX_TEXT_BYTES) throw new Error('文件超过 2 MB 的文本处理限制。');
		return await file.readFile({ signal: ctx.signal });
	} finally {
		await file.close();
	}
}

export async function readToolFile(ctx: ToolContext, path: ResolvedToolPath): Promise<string> {
	if (!path.stat?.isFile()) throw new Error('请选择一个文件。');
	if (path.stat.size > MAX_TEXT_BYTES) throw new Error('文件超过 2 MB 的文本处理限制。');
	ctx.signal.throwIfAborted();
	const file = !path.cacheOutput && path.vaultPath ? ctx.app.vault.getFileByPath(path.vaultPath) : null;
	const bytes = file
		? await ctx.app.vault.readBinary(file)
		: await readDiskFile(ctx, path);
	ctx.signal.throwIfAborted();
	const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	checkTextSize(text);
	return text;
}

export async function prepareFileChange(
	ctx: ToolContext,
	input: string,
	update: (before: string | undefined, requireFullRead: () => void) => string,
	options: { allowMissing?: boolean } = {},
): Promise<PreparedTool> {
	const path = await resolveToolPath(ctx, input, 'write', { ...options, requestApproval: true });
	if (authorizedLineRange(ctx, path)) throw new Error('本次仅授权了部分行，请选择整个文件后再修改。');
	let before: string | undefined;
	if (path.stat) {
		if (!ctx.readFiles.has(path.absolutePath)) throw new Error('修改已有文件前，请使用 Read 读取其最新内容。');
		const readPath = await recheckToolPath(ctx, path, 'read');
		before = await readToolFile(ctx, readPath);
	}
	const fingerprint = before === undefined ? undefined : fileFingerprint(before);
	if (fingerprint && ctx.readFiles.get(path.absolutePath) !== fingerprint) {
		throw new Error('修改已有文件前，请使用 Read 读取其最新内容。');
	}
	const requireFullRead = () => {
		if (fingerprint && !ctx.readDelivery.hasFullRead(path.absolutePath, fingerprint)) {
			throw new Error('整篇覆盖前，请用 Read 读取同一版本的全部内容。结果被截短时请减小每次读取的行数；只修改部分内容时可用 Edit。');
		}
	};
	const after = update(before, requireFullRead);
	checkTextSize(after);
	if (before === after) throw new Error('文件内容没有变化。');
	const mode = ctx.permissions.executionMode;
	const external = path.vaultPath === undefined;
	const writingRule = path.vaultPath && posix.basename(path.vaultPath).toLowerCase() === WRITING_RULE_FILENAME.toLowerCase();
	const direct = (!external || ctx.permissions.canSkipFullAccessApproval?.()) && !writingRule && !path.requiresApproval && (mode === 'full-access'
		|| Boolean(mode && path.vaultPath && isWithinPath(ctx.cwd, path.requestedPath)));
	const reason = external ? '此操作将写入当前笔记库以外的文件。'
		: writingRule ? '可信的写作规则会影响此目录后续的聊天任务。' : undefined;
	const checkApproval = () => {
		if (external && direct && !ctx.permissions.canSkipFullAccessApproval?.()) {
			throw new Error('完全访问的审批设置已变化，请重新请求写入。');
		}
	};
	return {
		...(direct ? { independent: true } : {
			approval: { title: before === undefined ? '创建文件' : '修改文件', target: path.displayPath, before, after,
				...(reason && { humanRequired: true, reason }) },
		}),
		async run() {
			const current = await recheckToolPath(ctx, path, 'write', options);
			ctx.signal.throwIfAborted();
			checkApproval();
			const file = current.vaultPath ? ctx.app.vault.getFileByPath(current.vaultPath) : null;
			if (!current.stat) {
				if (current.vaultPath) await ctx.app.vault.create(current.vaultPath, after);
				else await writeFile(current.absolutePath, after, { flag: 'wx' });
			} else if (file) {
				await ctx.app.vault.process(file, (source) => {
					ctx.signal.throwIfAborted();
					if (file.path !== current.vaultPath || source !== before) throw new Error('文件已变化，请重新读取和确认。');
					return after;
				});
			} else if (current.vaultPath) {
				await ctx.app.vault.adapter.process(current.vaultPath, (source) => {
					ctx.signal.throwIfAborted();
					if (source !== before) throw new Error('文件已变化，请重新读取和确认。');
					return after;
				});
			} else {
				await replaceExternalFile(ctx, current, before, after, checkApproval);
			}
			ctx.readFiles.set(current.absolutePath, fileFingerprint(after));
			const content = `${before === undefined ? '已创建' : '已更新'} ${path.displayPath}。`;
			const notePath = current.vaultPath;
			const configDir = ctx.app.vault.configDir;
			const noteChange = notePath && configDir
				&& !notePath.toLowerCase().startsWith(`${configDir.toLowerCase()}/`)
				? captureNoteChange(notePath, before, after) : undefined;
			return noteChange ? { content, noteChange } : content;
		},
	};
}

async function replaceExternalFile(
	ctx: ToolContext,
	path: ResolvedToolPath,
	before: string | undefined,
	after: string,
	checkApproval: () => void,
): Promise<void> {
	const staging = await mkdtemp(join(dirname(path.absolutePath), '.scribe-ai-'));
	try {
		const temp = join(staging, 'content');
		await writeFile(temp, after, { mode: 0o600 });
		await chmod(temp, (path.stat?.mode ?? 0o600) & 0o777);
		// 库外文件没有原子读取后修改的接口，按文件身份保护最终核对和替换。
		const key = path.stat ? `${path.stat.dev}:${path.stat.ino}` : path.absolutePath;
		if (committingExternalFiles.has(key)) throw new Error('另一个任务正在修改此文件，请稍后重新读取和确认。');
		committingExternalFiles.add(key);
		try {
			const current = await recheckToolPath(ctx, path, 'write');
			if (await readToolFile(ctx, current) !== before) {
				throw new Error('文件已变化，请重新读取和确认。');
			}
			ctx.signal.throwIfAborted();
			checkApproval();
			await rename(temp, path.absolutePath);
		} finally {
			committingExternalFiles.delete(key);
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
