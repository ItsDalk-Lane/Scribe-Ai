import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import { parse } from 'yaml';
import { safeResourcePath } from './library/vaultAdapter';
import { parseOpenAiMetadata } from './library/openAiMetadata';
import type { NoteRef, SkillInfo } from '../types';
import { hasFileErrorCode, isWithinPath } from '../tools/support/pathUtils';

export interface DiscoveredSkill extends SkillInfo {
	managed?: string;
	dependencies?: string[];
}

export interface SkillScanIssue { path: string; reason: string }
type Metadata = Pick<DiscoveredSkill, 'name' | 'description' | 'manual' | 'implicit' | 'displayName' | 'defaultPrompt' | 'dependencies'>;
type CacheEntry = { key: string } & ({ value: Metadata; warning?: string } | { error: string });
export function createLiveSkillCache() { return new Map<string, CacheEntry>(); }
type DiscoveryOptions = { cache?: ReturnType<typeof createLiveSkillCache>; issues?: SkillScanIssue[] };

const maxDirectories = 2_000;
const maxEntries = 20_000;
const maxDepth = 6;
const maxFileSize = 50 * 1024 * 1024;

export function skillScope(refs: NoteRef[] = [], activeNote?: string): string[] {
	const scopes = new Set<string>();
	const vaultRefs = refs.filter(({ path }) => path && !isAbsolute(path) && !win32.isAbsolute(path) && !path.includes('\\')
		&& !path.includes('\0') && !path.split('/').includes('..'));
	for (const ref of vaultRefs.length ? vaultRefs : activeNote ? [{ path: activeNote }] : []) {
		const folder = ref.kind === 'folder' ? ref.path : posix.dirname(ref.path);
		if (folder !== '.' && safeResourcePath(folder)) scopes.add(folder);
	}
	return [...scopes];
}

function fields(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function optionalText(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function missing(error: unknown) { return hasFileErrorCode(error, 'ENOENT') || hasFileErrorCode(error, 'ENOTDIR'); }
function reason(error: unknown) { return error instanceof Error ? error.message : '无法读取技能。'; }
function canonicalError() { return new Error('技能文件超出授权目录、含有链接或在读取时发生变化。'); }

async function verifyDirectory(path: string) {
	if (await realpath(path) !== path) throw canonicalError();
	const info = await lstat(path, { bigint: true });
	if (!info.isDirectory()) throw canonicalError();
	return info;
}
async function verifyFile(path: string) {
	if (await realpath(path) !== path) throw canonicalError();
	const info = await lstat(path, { bigint: true });
	if (!info.isFile() || info.nlink !== 1n) throw canonicalError();
	if (info.size > maxFileSize) throw new Error('此技能文件超过 50 MB。');
	return info;
}
function signature(info: Awaited<ReturnType<typeof verifyFile>>): string {
	return [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs].join(':');
}

// 读取已校验的文件句柄，读取期间移位或修改的内容不能交付给模型。
export async function skillText(directory: string, filename: string, maxBytes?: number): Promise<string> {
	if (!isAbsolute(directory) || !safeResourcePath(filename)) throw new Error('请选择技能目录中的文件。');
	const path = join(directory, filename);
	const expected = signature(await verifyFile(path));
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const info = await file.stat({ bigint: true });
		if (!info.isFile() || info.nlink !== 1n || signature(info) !== expected || await realpath(path) !== path) throw canonicalError();
		const size = Number(info.size);
		const buffer = Buffer.alloc(Math.min(size, maxBytes ?? size));
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset !== buffer.length || signature(await verifyFile(path)) !== expected) throw canonicalError();
		try {
			const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: size > offset });
			if (value.includes('\0')) throw new Error();
			return value;
		} catch { throw new Error('所选技能文件不是 UTF-8 文本。'); }
	} finally { await file.close(); }
}

async function directoryEntries(path: string, limit: number) {
	const before = await verifyDirectory(path);
	const entries = [];
	let truncated = false;
	const dir = await opendir(path);
	for await (const entry of dir) {
		if (entries.length >= limit) { truncated = true; break; }
		entries.push(entry);
	}
	const after = await verifyDirectory(path);
	if (after.ino !== before.ino || after.dev !== before.dev) throw canonicalError();
	return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), truncated };
}

export async function listSkillFiles(directory: string): Promise<string[]> {
	const folders = [''], files: string[] = [];
	let remaining = maxEntries;
	for (let i = 0; i < folders.length; i++) {
		const folder = folders[i]!;
		const { entries, truncated } = await directoryEntries(join(directory, folder), remaining);
		if (truncated) throw new Error('此技能的配套文件列表超过扫描上限。');
		remaining -= entries.length;
		for (const entry of entries) {
			if (entry.name.startsWith('.') || !safeResourcePath(entry.name)) continue;
			const path = folder ? folder + '/' + entry.name : entry.name;
			if (entry.isDirectory()) folders.push(path);
			else if (entry.isFile()) {
				const info = await lstat(join(directory, path));
				if (info.isFile() && info.nlink === 1) files.push(path);
			}
			if (folders.length > maxDirectories || files.length > 2_000) throw new Error('此技能的配套文件列表超过扫描上限。');
		}
	}
	return files.sort();
}

function descriptor(head: string, directory: string): Metadata {
	const front = /^[\uFEFF \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/u.exec(head);
	if (!front) throw new Error('找不到完整的技能说明头部（最多读取 128 KiB）。');
	const yaml = front[1]!;
	let meta;
	try { meta = fields(parse(yaml)); } catch {
		// 兼容第三方技能常见的未加引号的冒号说明，仅修复单行说明字段。
		const repaired = yaml.replace(/^(description:[ \t]+)([^"'|>\s][^\n]*?:[ \t]+[^\n]*)$/gmu,
			(_, prefix: string, value: string) => prefix + JSON.stringify(value.replace(/\s+#.*$/u, '')));
		if (repaired === yaml) throw new Error('技能说明头部格式无效，请检查 YAML。');
		try { meta = fields(parse(repaired)); } catch { throw new Error('技能说明头部格式无效，请检查 YAML。'); }
	}
	if (meta.name != null && typeof meta.name !== 'string') throw new Error('技能名称（name）须为文字。');
	const name = optionalText(meta.name)?.replace(/\s+/gu, ' ') ?? basename(directory);
	const description = optionalText(meta.description)?.replace(/\s+/gu, ' ');
	if (!description) throw new Error('技能缺少有效的说明（description）。');
	if (!name || [...name].length > 64) throw new Error('技能名称须为 1 至 64 个字符。');
	return { name, description, displayName: optionalText(fields(meta.ui).displayName),
		implicit: meta['disable-model-invocation'] !== true, manual: meta['user-invocable'] !== false };
}

async function loadMetadata(directory: string, cache: DiscoveryOptions['cache']): Promise<CacheEntry> {
	const id = join(directory, 'SKILL.md');
	const config = join(directory, 'agents', 'openai.yaml');
	const mainKey = signature(await verifyFile(id));
	let configKey = '', warning: string | undefined;
	try {
		configKey = signature(await verifyFile(config));
	} catch (error) {
		if (!hasFileErrorCode(error, 'ENOENT')) warning = reason(error);
		else if (await lstat(config).then((file) => file.isSymbolicLink(), () => false)) warning = '技能界面说明指向了不存在的位置。';
	}
	const key = [mainKey, configKey, warning].join('|');
	const hit = cache?.get(id);
	if (hit?.key === key) return hit;
	const head = await skillText(directory, 'SKILL.md', 131_072);
	let entry: CacheEntry;
	try { entry = { key, value: descriptor(head, directory), warning }; } catch (error) { entry = { key, error: reason(error) }; }
	if (configKey && 'value' in entry) {
		const value = entry.value;
		try {
			const metadata = parseOpenAiMetadata(await skillText(directory, 'agents/openai.yaml', 65_537));
			if ((await verifyFile(config)).size > 65_536) throw new Error('技能界面说明超过 64 KiB。');
			value.displayName = metadata.fields.displayName ?? value.displayName;
			value.defaultPrompt = metadata.fields.defaultPrompt;
			value.implicit &&= metadata.implicit;
			value.dependencies = metadata.dependencies.map((dep) => dep.name);
		} catch (error) { entry.warning = reason(error); }
	}
	if (cache) {
		if (!cache.has(id) && cache.size >= maxDirectories) cache.delete(cache.keys().next().value!);
		cache.set(id, entry);
	}
	return entry;
}

export async function discoverLiveSkills(cwd: string, configDir: string, scope: string[], shared: string[],
	disabled: ReadonlySet<string>, { cache, issues }: DiscoveryOptions = {}): Promise<DiscoveredSkill[]> {
	const vault = await realpath(cwd);
	const protectedRoot = resolve(vault, configDir);
	const protectedReal = await realpath(protectedRoot).catch(() => protectedRoot);
	const protectedPath = (p: string) => isWithinPath(protectedRoot, p) || isWithinPath(protectedReal, p);
	const issuePaths = new Set<string>();
	const note = (path: string, message: string) => {
		if (issues && !issuePaths.has(path)) { issues.push({ path, reason: message }); issuePaths.add(path); }
	};
	const candidates = new Map<string, { label: string; shared: boolean }>();
	const folders = new Set(['']);
	for (const leaf of scope) {
		if (!safeResourcePath(leaf) || protectedPath(join(vault, leaf))) continue;
		for (let dir = leaf; dir !== '.'; dir = posix.dirname(dir)) folders.add(dir);
	}
	for (const dir of folders) candidates.set(join(vault, dir, '.agents', 'skills'), { label: dir || '笔记库', shared: false });
	for (const path of shared) {
		if (!isAbsolute(path) || protectedPath(resolve(path))) { note(path, '共享路径无效或属于 Obsidian 配置目录。'); continue; }
		candidates.set(resolve(path), { label: path, shared: true });
	}
	const roots = new Map<string, string>();
	const linked: { path: string; actual: string; label: string }[] = [];
	for (const [path, source] of candidates) {
		try {
			const actual = await realpath(path);
			if (protectedPath(actual)) { note(path, '已略过 Obsidian 配置目录。'); continue; }
			if (actual !== path) { linked.push({ path, actual, label: source.label }); continue; }
			await verifyDirectory(actual);
			roots.set(actual, source.label);
		} catch (error) {
			if (source.shared || !missing(error)) note(path, reason(error));
			else if (await lstat(path).then((file) => file.isSymbolicLink(), () => false)) note(path, '技能目录链接指向了不存在的位置。');
		}
	}
	// 用户添加共享目录时已保存真实路径。链接只能复用已有授权，不能自行扩大授权。
	const allowedRoots = [...roots.keys()];
	const allowed = (p: string) => !protectedPath(p) && allowedRoots.some((root) => isWithinPath(root, p));
	for (const link of linked) {
		if (!allowed(link.actual)) note(link.path, '链接目标不在本轮已授权的技能目录中。');
		else if (!roots.has(link.actual)) roots.set(link.actual, link.label);
	}
	const found = new Map<string, DiscoveredSkill>();
	for (const [base, label] of roots) {
		const queue = [{ path: base, depth: 0 }], seen = new Set<string>();
		let remaining = maxEntries, clipped = false;
		for (let i = 0; i < queue.length; i++) {
			if (i >= maxDirectories) { clipped = true; break; }
			const item = queue[i]!;
			try {
				const dir = await realpath(item.path);
				if (!allowed(dir)) { note(item.path, '链接目标不在本轮已授权的技能目录中。'); continue; }
				if (seen.has(dir)) continue;
				seen.add(dir);
				const info = await lstat(dir);
				if (!info.isDirectory()) continue;
				const id = join(dir, 'SKILL.md');
				const hasDescriptor = await lstat(id).then(() => true, (error: unknown) => { if (!missing(error)) throw error; return false; });
				if (hasDescriptor && (isWithinPath(dir, protectedRoot) || isWithinPath(dir, protectedReal))) {
					note(id, '技能所在文件夹包含 Obsidian 配置目录，请将技能放入独立的子文件夹。');
				} else if (hasDescriptor) {
					if (found.has(id)) continue;
					try {
						const entry = await loadMetadata(dir, cache);
						if ('error' in entry) { note(id, entry.error); continue; }
						const { value, warning } = entry;
						found.set(id, { ...value, id, sourceLabel: label + ' · ' + (relative(base, item.path) || basename(dir)), enabled: !disabled.has(id) });
						if (warning) note(join(dir, 'agents/openai.yaml'), warning);
					} catch (error) { note(id, reason(error)); }
					continue;
				}
				const { entries, truncated } = await directoryEntries(dir, remaining);
				remaining -= entries.length;
				clipped ||= truncated;
				for (const child of entries) {
					if (child.name.startsWith('.') || !(child.isDirectory() || child.isSymbolicLink())) continue;
					if (item.depth >= maxDepth || queue.length >= maxDirectories) { clipped = true; continue; }
					queue.push({ path: join(dir, child.name), depth: item.depth + 1 });
				}
			} catch (error) { note(item.path, reason(error)); }
		}
		if (clipped) note(base, '本次扫描达到上限（6 层、2000 个目录或 20000 个条目），列表可能不完整。');
	}
	return [...found.values()];
}

export function skillDirectory(skill: SkillInfo): string { return dirname(skill.id); }
