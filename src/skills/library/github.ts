import { Buffer } from 'node:buffer';
import { get } from 'node:https';
import { posix } from 'node:path';
import { buildSkillPackage, SKILL_IMPORT_MAX_BYTES, SKILL_IMPORT_MAX_FILES } from './skillImport';
import { safeResourcePath } from './vaultAdapter';
import type { SkillPackage } from './contracts';

async function githubData(path: string, limit: number, signal?: AbortSignal, redirects = 0): Promise<unknown> {
	const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
		const req = get('https://api.github.com' + path, {
			headers: { 'User-Agent': 'Scribe-Ai-Skill-Import', Accept: 'application/vnd.github+json' }, signal,
			timeout: 30000,
		}, resolve);
		req.once('timeout', () => req.destroy(new Error('GitHub 请求超时。')));
		req.once('error', reject);
	});
	if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
		response.destroy();
		const destination = new URL(response.headers.location ?? '', 'https://api.github.com' + path);
		if (redirects < 3 && destination.origin === 'https://api.github.com' && !destination.username && !destination.password
			&& (destination.pathname.startsWith('/repositories/') || destination.pathname.startsWith('/repos/'))) {
			return githubData(destination.pathname + destination.search, limit, signal, redirects + 1);
		}
		throw new Error('GitHub 将下载请求转向了不支持的位置。');
	}
	if (response.statusCode !== 200) {
		response.destroy();
		throw new Error('GitHub 未返回公开技能文件（' + String(response.statusCode) + '）。请核对地址，或稍后重试。');
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	try {
		for await (const raw of response as AsyncIterable<Buffer>) {
			bytes += raw.length;
			if (bytes > limit) throw new Error('GitHub 返回的数据超过技能大小限制。');
			chunks.push(raw);
		}
	} finally { response.destroy(); }
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function githubJson(path: string, limit: number, signal?: AbortSignal) {
	const value = await githubData(path, limit, signal);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub 返回的资料无效。');
	return value as Record<string, unknown>;
}
function sha(value: unknown): string {
	if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) throw new Error('GitHub 未提供有效版本。');
	return value;
}
interface TreeItem { path: string; mode: string; type: string; sha: string; size?: number }
export async function githubPackage(input: string, signal?: AbortSignal): Promise<SkillPackage> {
	const address = new URL(input);
	if (address.origin !== 'https://github.com' || address.username || address.password || address.search || address.hash) throw new Error('请输入公开 GitHub 仓库或其中的技能文件夹地址。');
	const parts = address.pathname.replace(/^\/|\/$/gu, '').split('/').map(decodeURIComponent);
	const [owner, repository, view, ref, ...subpath] = parts;
	if (!owner || !repository || ![owner, repository].every((part) => /^[a-zA-Z0-9_.-]+$/u.test(part) && part !== '.' && part !== '..') ||
		(view !== undefined && (view !== 'tree' || !ref)) || subpath.some((part) => part.includes('/') || !safeResourcePath(part))) throw new Error('请输入公开 GitHub 仓库或其中的技能文件夹地址。');
	const base = '/repos/' + owner + '/' + repository;
	const branch = ref ?? (await githubJson(base, 100000, signal)).default_branch;
	if (!branch || typeof branch !== 'string') throw new Error('未找到默认分支。');
	const commit = await githubJson(base + '/commits/' + encodeURIComponent(branch), 8 * 1024 * 1024, signal);
	const pinned = sha(commit.sha);
	const metadata = commit.commit as { tree?: { sha?: string } } | undefined;
	let tree = sha(metadata?.tree?.sha);
	async function children(treeId: string, recursive = false): Promise<TreeItem[]> {
		const data = await githubJson(base + '/git/trees/' + treeId + (recursive ? '?recursive=1' : ''), 8 * 1024 * 1024, signal);
		if (data.truncated || !Array.isArray(data.tree)) throw new Error('GitHub 无法完整列出此文件夹。请选择具体技能文件夹。');
		return data.tree as TreeItem[];
	}
	for (const part of subpath) {
		const target = (await children(tree)).find((entry) => entry.path === part && entry.type === 'tree');
		if (!target) throw new Error('GitHub 上找不到指定技能文件夹。');
		tree = sha(target.sha);
	}
	const listing = await children(tree, true);
	let total = 0;
	const files = listing.filter((item) => {
		if (!safeResourcePath(item.path) || !['040000','100644','100755'].includes(item.mode)) throw new Error('技能包含链接或不安全的路径。');
		return item.type !== 'tree';
	}).map((item) => {
		if (item.type !== 'blob' || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('GitHub 技能清单无效。');
		const size = item.size;
		total += size;
		return { path: item.path, size, read: async () => {
			const data = await githubJson(base + '/git/blobs/' + sha(item.sha), 2 * size + 10000, signal);
			if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error('无法读取技能文件。');
			return new Uint8Array(Buffer.from(data.content, 'base64'));
		} };
	});
	if (files.length > SKILL_IMPORT_MAX_FILES || total > SKILL_IMPORT_MAX_BYTES) throw new Error('技能最多包含 2000 个文件、50 MB。');
	const origin = 'https://github.com/' + owner + '/' + repository + (subpath.length ? '/tree/' + encodeURIComponent(branch) + '/' + subpath.map(encodeURIComponent).join('/') : '');
	return buildSkillPackage(files, { kind: 'github', origin, displayPath: origin, version: pinned }, subpath.length ? posix.basename(subpath.join('/')) : undefined, signal);
}

export async function listCuratedSkills(signal?: AbortSignal): Promise<string[]> {
	const entries = await githubData('/repos/openai/skills/contents/skills/.curated', 1024 * 1024, signal);
	if (!Array.isArray(entries)) throw new Error('精选技能列表格式无效。');
	return entries.flatMap((item: unknown) => {
		if (!item || typeof item !== 'object' || !('type' in item) || item.type !== 'dir' || !('name' in item)) return [];
		return typeof item.name === 'string' && safeResourcePath(item.name) && !item.name.includes('/') ? [item.name] : [];
	});
}
