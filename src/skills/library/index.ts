import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { isMap, isSeq, isScalar } from 'yaml';
import { getBuiltinSkillPackages } from './builtinSkills';
import { SkillLibrary, SKILL_LIBRARY, fingerprintFiles } from './SkillLibrary';
import { createLibraryVault, ensureFolderExists, safeResourcePath, writeVaultFile } from './vaultAdapter';
import { parseSkillFile, serializeSkillFile, validateName } from './skillFormat';
import { prepareSkillImportDescription, readSkillPackage } from './skillImport';
import { searchSystemSkills } from './systemSkillSearch';
import { githubPackage } from './github';
import { editOpenAiMetadata, parseOpenAiMetadata } from './openAiMetadata';
import { checkDependency } from './dependencies';
import type { BuiltinStatus, ImportPreview, LibrarySkill, ManagedSkillLibrary, SkillPackage, SkillSource } from './contracts';
export type * from './contracts';
export { parseSkillFile, serializeSkillFile } from './skillFormat';
export { BUILTIN_SKILL_PROVENANCE } from './builtinSkills';

const usagePath = SKILL_LIBRARY + '/.usage.json';
const libraryQueues = new Map<string, Promise<unknown>>();
const decoder = new TextDecoder('utf-8', { fatal: true });
type Ledger = Record<string, LibrarySkill['usage']>;
function sameSource(a: SkillSource, b: SkillSource) { return a.kind === b.kind && a.origin === b.origin; }
function resource(name: string, path: string) {
	if (!safeResourcePath(name) || name.includes('/') || name.startsWith('.') || !safeResourcePath(path)) throw new Error('无效的技能文件位置。');
	return SKILL_LIBRARY + '/' + name + '/' + path;
}
function description(pkg: SkillPackage) {
	const main = pkg.files.find((file) => file.path === 'SKILL.md');
	if (!main) throw new Error('没有找到 SKILL.md。');
	return parseSkillFile(decoder.decode(main.data), pkg.name).frontmatter.description;
}

export function createSkillLibrary(vaultRoot: string, options: { pluginVersion?: (id: string) => string | undefined } = {}): ManagedSkillLibrary {
	const vault = createLibraryVault(vaultRoot);
	const store = new SkillLibrary(vault);
	const directory = join(vaultRoot, SKILL_LIBRARY);
	const previews = new WeakMap<ImportPreview, { pkg: SkillPackage; expected?: string }>();
	let initial: Promise<void> | undefined;
	const queueKey = resolve(directory);

	async function initialize() {
		await store.load();
		const occupied = new Set((await store.occupiedNames()).map((name) => name.toLowerCase()));
		for (const pkg of getBuiltinSkillPackages()) {
			const entry = store.entry(pkg.name);
			if (!entry && !occupied.has(pkg.name)) await store.install(pkg);
			else if (entry?.state === 'installed' && entry.source.kind === 'builtin' && entry.source.version !== pkg.source.version
				&& occupied.has(pkg.name) && await store.fingerprint(pkg.name) === entry.baseline) {
				await store.install(pkg, { replace: true, expectedFingerprint: entry.baseline });
			}
		}
	}
	function queued<T>(work: () => Promise<T>, reload = false): Promise<T> {
		const next = (libraryQueues.get(queueKey) ?? Promise.resolve()).catch(() => undefined).then(async () => {
			await (initial ??= initialize().catch((error: unknown) => { initial = undefined; throw error; }));
			if (reload) await store.load();
			return work();
		});
		libraryQueues.set(queueKey, next);
		void next.finally(() => { if (libraryQueues.get(queueKey) === next) libraryQueues.delete(queueKey); }).catch(() => undefined);
		return next;
	}
	async function ledger(): Promise<{ value: Ledger; text: string | null }> {
		if (!await vault.adapter.exists(usagePath)) return { value: {}, text: null };
		const text = await vault.adapter.read(usagePath);
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('技能使用记录格式无效。');
		const entries: Ledger = Object.create(null) as Ledger;
		for (const [key, info] of Object.entries(value as Record<string, Partial<LibrarySkill['usage']>>)) {
			if (!info || !Number.isSafeInteger(info.count) || Number(info.count) < 0 || !Number.isFinite(info.lastUsedAt)) continue;
			entries[key] = { count: Number(info.count), lastUsedAt: info.lastUsedAt, ...((info.lastSource === 'manual' || info.lastSource === 'auto') && {lastSource: info.lastSource}) };
		}
		return { value: entries, text };
	}
	async function revision(name: string) {
		const hash = createHash('sha256');
		for (const file of (await store.listFiles(name)).sort()) {
			const entry = await lstat(join(directory, name, file), { bigint: true });
			hash.update(JSON.stringify([file, String(entry.ino), String(entry.ctimeNs), String(entry.size)]));
		}
		return hash.digest('hex');
	}
	async function info(name: string, usage?: Ledger, withRevision = false): Promise<LibrarySkill> {
		const source = store.entry(name)?.source ?? { kind: 'local' };
		const base = { name, path: join(directory, name, 'SKILL.md'), source, usage: usage && Object.prototype.hasOwnProperty.call(usage,name) ? usage[name]! : { count: 0 } };
		try {
			const parsed = parseSkillFile(await vault.adapter.readHead(resource(name, 'SKILL.md'), 131072), name);
			const meta = parsed.doc.get('metadata', true);
			const attr = (key: string) => parsed.doc.get(key) ?? (isMap(meta) ? meta.get(key) : undefined);
			const f = parsed.frontmatter;
			const spec = await vault.adapter.readHead(resource(name, 'agents/openai.yaml'), 65536).then(parseOpenAiMetadata).catch(() => undefined);
			const tags = attr('tags');
			return { ...base, revision: withRevision ? await revision(name) : undefined, description: f.description, ...f.uiMetadata, ...spec?.fields,
				author: typeof attr('author') === 'string' ? String(attr('author')) : undefined,
				version: ['string','number','bigint'].includes(typeof attr('version')) ? String(attr('version')) : source.version,
				tags: isSeq(tags) ? tags.items.filter(isScalar).map((item) => String(item.value)) : undefined,
				enabled: !isMap(meta) || !meta.has('scribe-enabled-agents') || f.enabledAgents.includes('native'),
				allowImplicit: f.disableModelInvocation !== true && spec?.implicit !== false, userInvocable: f.userInvocable !== false, dependencies: [...f.dependencies ?? [], ...spec?.dependencies ?? []] };
		} catch (error) {
			return { ...base, error: error instanceof Error ? error.message : String(error), description: '', allowImplicit: false, userInvocable: false, enabled: false, dependencies: [] };
		}
	}
	async function list(withRevisions = false) {
		const { value } = await ledger();
		const entries = await Promise.all((await store.occupiedNames()).sort().map((name) => info(name, value, withRevisions)));
		return entries;
	}
	function editable(name: string) {
		if (store.entry(name)?.source.kind === 'builtin') throw new Error('内置技能只读，可通过恢复功能还原。');
	}
	async function saveFile(name: string, path: string, text: string, expected: string, toggle = false) {
		if (!toggle) editable(name);
		const relative = resource(name, path);
		if (await vault.adapter.read(relative) !== expected) throw new Error('文件已在其他地方修改，请重新载入或保留草稿。');
		let nextName = name;
		if (path === 'SKILL.md') nextName = parseSkillFile(text).frontmatter.name;
		const files = await store.readFiles(name);
		const before = fingerprintFiles(files, name);
		const selected = files.find((file) => file.path === path);
		if (!selected || decoder.decode(selected.data) !== expected) throw new Error('文件已在其他地方修改。');
		const main = files.find((file) => file.path === 'SKILL.md');
		if (!main) throw new Error('未找到技能说明文件。');
		const old = decoder.decode(main.data);
		selected.data = new TextEncoder().encode(text);
		await store.install({ name: nextName, files, source: store.entry(name)?.source ?? { kind: 'local' } },
			{ previousName: name, expectedContent: old, expectedFingerprint: before, replace: true, updateBaseline: false });
		if (nextName !== name) {
			const usage = await ledger();
			if (Object.prototype.hasOwnProperty.call(usage.value,name) && usage.value[name]) {
				usage.value[nextName] = usage.value[name]; delete usage.value[name];
				await writeVaultFile(vault, usagePath, JSON.stringify(usage.value), usage.text);
			}
		}
		return nextName;
	}
	async function builtinStatus(): Promise<BuiltinStatus[]> {
		const occupied = (await store.occupiedNames()).map((name) => name.toLowerCase());
		return Promise.all(getBuiltinSkillPackages().map(async (pkg) => {
			const entry = store.entry(pkg.name);
			const present = occupied.includes(pkg.name);
			let status: BuiltinStatus['status'] = 'missing';
			if (present && (entry?.source.kind !== 'builtin' || entry.state !== 'installed')) status = 'conflict';
			else if (present && entry) status = await store.fingerprint(pkg.name) === entry.baseline ? 'installed' : 'modified';
			else if (entry?.state === 'uninstalled') status = 'removed';
			return { name: pkg.name, status };
		}));
	}
	async function preview(pkg: SkillPackage): Promise<ImportPreview> {
		const previous = pkg.source.origin && store.entries().find((entry) => entry.state === 'installed' && sameSource(pkg.source, entry.source));
		if (previous && previous.name !== pkg.name && await vault.adapter.exists(SKILL_LIBRARY + '/' + previous.name)) {
			const main = pkg.files.find((file) => file.path === 'SKILL.md');
			if (!main) throw new Error('没有找到技能说明文件。');
			const text = serializeSkillFile(parseSkillFile(decoder.decode(main.data)), { name: previous.name });
			pkg = { ...pkg, name: previous.name, files: pkg.files.map((file) =>
				file === main ? { path: file.path, data: new TextEncoder().encode(text) } : file) };
		}
		const occupied = (await store.occupiedNames()).find((name) => name.toLowerCase() === pkg.name);
		const entry = store.entry(pkg.name);
		const current = entry?.source ?? { kind: 'local' as const };
		const status = occupied ? (occupied === pkg.name && sameSource(current, pkg.source) && current.kind !== 'agent' ? 'replace' : 'conflict')
			: entry && !sameSource(current, pkg.source) ? 'conflict' : 'new';
		const result: ImportPreview = { name: pkg.name, description: description(pkg), files: pkg.files.map((file) => file.path),
			repairs: pkg.repair ?? [], source: { ...pkg.source }, status, token: randomUUID() };
		previews.set(result, { pkg, expected: status === 'replace' ? await store.fingerprint(pkg.name) : undefined });
		return result;
	}
	function selected(preview: ImportPreview) {
		const value = previews.get(preview);
		if (!value) throw new Error('请重新预览要安装的技能。');
		return value;
	}
	return {
		directory, list: (opts) => queued(() => list(opts?.withRevisions), true),
		revision: (name) => queued(() => revision(name)),
		listFiles: (name) => queued(() => store.listFiles(name)),
		readFile: (name, path) => queued(async () => {
			const content = await vault.adapter.read(resource(name, path));
			if (content.includes('\0')) throw new Error('此文件不能作为文字预览。');
			return content;
		}),
		saveFile: (name, path, text, expected) => queued(() => saveFile(name, path, text, expected)),
		setEnabled: (name, enabled) => queued(async () => {
			const text = await vault.adapter.read(resource(name, 'SKILL.md'));
			const parsed = parseSkillFile(text, name);
			const others = parsed.frontmatter.enabledAgents.filter((agent) => agent !== 'native');
			const updated = serializeSkillFile(parsed, { enabledAgents: enabled ? [...others, 'native'] : others });
			if (updated !== text) await saveFile(name, 'SKILL.md', updated, text, true);
		}),
		remove: (name, expectedRevision) => queued(async () => {
			if (expectedRevision && await revision(name) !== expectedRevision) throw new Error('文件已改变，请刷新并重新确认卸载。');
			await store.remove(name);
			const usage = await ledger();
			if (Object.prototype.hasOwnProperty.call(usage.value,name)) { delete usage.value[name]; await writeVaultFile(vault, usagePath, JSON.stringify(usage.value), usage.text); }
		}),
		builtinStatus: () => queued(builtinStatus),
		restore: (name, expectedStatus, expectedRevision) => queued(async () => {
			const pkg = getBuiltinSkillPackages().find((item) => item.name === name);
			if (!pkg) throw new Error('没有这个内置技能。');
			const status = (await builtinStatus()).find((item) => item.name === name)?.status;
			if (status === 'conflict') throw new Error('同名技能已被占用。');
			if (expectedStatus && status !== expectedStatus) throw new Error('内置技能状态已变化，请刷新后重新确认。');
			if (status === 'installed') return;
			if (status === 'modified' && (expectedStatus !== 'modified' || !expectedRevision))
				throw new Error('本地内置技能已被修改，请先确认要重置的版本。');
			const expectedFingerprint = status === 'modified' ? await store.fingerprint(name) : undefined;
			if (expectedRevision && await revision(name) !== expectedRevision) throw new Error('技能文件已改变，请重新确认重置。');
			await store.install(pkg, { replace: status === 'modified', expectedFingerprint });
		}),
		searchSystem: async (signal) => searchSystemSkills({ skillsDirectory: directory, installed: await queued(list), signal }),
		previewLocal: async (path, kind = 'local', signal) => { const pkg = await readSkillPackage(path, kind, signal); return queued(() => preview(pkg)); },
		previewGithub: async (url, signal) => { const pkg = await githubPackage(url, signal); return queued(() => preview(pkg)); },
		previewDraft: (content) => queued(async () => {
			const draft = prepareSkillImportDescription(content);
			return preview({ name: draft.name, source: { kind: 'agent' }, files: [{ path: 'SKILL.md', data: new TextEncoder().encode(draft.content) }] });
		}),
		install: (item, signal) => queued(async () => {
			const { pkg, expected } = selected(item);
			if (item.status === 'conflict') throw new Error('这个名称已被其他来源使用。');
			await store.install(pkg, { replace: expected !== undefined, expectedFingerprint: expected, signal });
			previews.delete(item);
		}),
		previewPackage: (preview) => {
			const { pkg } = selected(preview);
			return { ...pkg, source: { ...pkg.source }, files: pkg.files.map((file) => ({ path: file.path, data: file.data.slice() })) };
		},
		discard: (preview) => { previews.delete(preview); },
		recordUse: (name, kind) => queued(async () => {
			validateName(name, name);
			const usage = await ledger();
			const count = Object.prototype.hasOwnProperty.call(usage.value,name) ? usage.value[name]!.count : 0;
			usage.value[name] = { count: count + 1, lastUsedAt: Date.now(), ...(kind && {lastSource: kind}) };
			await ensureFolderExists(vault, SKILL_LIBRARY);
			await writeVaultFile(vault, usagePath, JSON.stringify(usage.value), usage.text);
		}),
		checkDependencies: (name) => queued(async () => Promise.all((await info(name)).dependencies.map((dep) => checkDependency(dep, options.pluginVersion)))),
		saveMetadata: (name, patch, expected) => queued(async () => {
			editable(name);
			const files = await store.readFiles(name);
			const fingerprint = fingerprintFiles(files, name);
			const main = files.find((file) => file.path === 'SKILL.md');
			if (!main) throw new Error('没有找到技能说明文件。');
			const source = decoder.decode(main.data);
			const parsed = parseSkillFile(source, name);
			const sidecar = files.find((file) => file.path === 'agents/openai.yaml');
			const sideText = sidecar && decoder.decode(sidecar.data);
			const side = sideText !== undefined ? parseOpenAiMetadata(sideText) : undefined;
			const fields = { ...parsed.frontmatter.uiMetadata, ...side?.fields };
			const localPatch: typeof patch = {}, sidePatch: typeof patch = {};
			for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
				if (fields[key] !== expected[key]) throw new Error('显示信息已发生变化，请重新载入。');
				const value = patch[key]?.trim() || undefined;
				if (value && key === 'icon' && !safeResourcePath(value.replace(/^\.\//u, ''))) throw new Error('图标应位于该技能的文件夹内。');
				if (value && key === 'brandColor' && !/^#[a-f0-9]{6}$/iu.test(value)) throw new Error('品牌色格式应为 #RRGGBB。');
				// 已有字段留在原文件，新字段优先写入技能已自带的 Codex 界面说明。
				if (!side || (!side.fields[key] && parsed.frontmatter.uiMetadata?.[key])) localPatch[key] = value;
				else {
					sidePatch[key] = value;
					if (!value && parsed.frontmatter.uiMetadata?.[key]) localPatch[key] = undefined;
				}
			}
			if (Object.keys(sidePatch).length && sidecar && side && sideText !== undefined)
				sidecar.data = new TextEncoder().encode(editOpenAiMetadata(sideText, sidePatch, side.iconKey));
			if (Object.keys(localPatch).length) main.data = new TextEncoder().encode(serializeSkillFile(parsed, { uiMetadata: localPatch }));
			await store.install({name, files, source: store.entry(name)?.source ?? {kind:'local'}},
				{replace:true, expectedContent:source, expectedFingerprint:fingerprint, updateBaseline:false});
		}),
		readIcon: (name) => queued(async () => {
			const icon = (await info(name)).icon?.replace(/^\.\//u, '');
			if (!icon || !safeResourcePath(icon)) return undefined;
			const kind = /\.(svg|png|jpe?g|webp|gif)$/iu.exec(icon)?.[1]?.toLowerCase();
			if (!kind) return undefined;
			const bytes = await vault.adapter.readBinary(resource(name, icon));
			if (bytes.length > 1024 * 1024) return undefined;
			if (kind === 'svg' && /<!ENTITY|<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href\s*=\s*["']|url\(\s*["']?)(?:[^#'"\s)]|$)/iu.test(bytes.toString('utf8'))) return undefined;
			return 'data:image/' + (kind === 'jpg' ? 'jpeg' : kind === 'svg' ? 'svg+xml' : kind) + ';base64,' + Buffer.from(bytes).toString('base64');
		}),
	};
}
