import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { App, FileSystemAdapter } from 'obsidian';
import { createSkillLibrary } from '../../skills/library';
import type { ImportPreview } from '../../skills/library/contracts';
import { createLiveSkillCache, discoverLiveSkills, skillDirectory, skillScope, skillText } from '../../skills/discovery';
import type { DiscoveredSkill, SkillScanIssue } from '../../skills/discovery';
import { installSharedPackage } from '../../skills/installTarget';
import type { NoteRef, ScribeSettings } from '../../types';
import { normalizeSkillSettings } from '../settings/defaults';
import { isWithinPath } from '../../tools/support/pathUtils';

export const INSTALLER_ID = 'scribe:skill-installer';
const installerGuide = '帮助用户列出官方精选技能，或安装官方精选技能、公开 GitHub 仓库中指定的技能目录。列出精选技能用 list_curated_skills，安装用 install_skill。输入仓库目录链接或精选技能名称，由安装预览让用户指定保存位置。';
export interface SkillReviewActions {
	draft(content: string, save: (text: string, target?: string) => Promise<void>, signal: AbortSignal, roots: string[]): Promise<boolean>;
	install(preview: ImportPreview, save: (target?: string) => Promise<void>, signal: AbortSignal, roots: string[]): Promise<boolean>;
}

export function createSkillRegistry(app: App, settings: ScribeSettings, save: () => Promise<void>, review: SkillReviewActions) {
	const cwd = (app.vault.adapter as FileSystemAdapter).getBasePath();
	const library = createSkillLibrary(cwd, { pluginVersion(id) {
		const plugins = (app as App & { plugins?: { enabledPlugins?: Set<string>; manifests?: Record<string, { version: string }> } }).plugins;
		return plugins?.enabledPlugins?.has(id) ? plugins.manifests?.[id]?.version : undefined;
	} });
	const options = () => settings.skillSettings ??= normalizeSkillSettings();
	const listeners = new Set<() => void>();
	let budget: { listed?: number; shortened: boolean; omitted: string[] } = { shortened: false, omitted: [] as string[] };
	const notify = () => listeners.forEach((listener) => listener());
	const scope = (refs?: NoteRef[], activeNote = app.workspace.getActiveFile()?.path) => skillScope(refs, activeNote);
	const cache = createLiveSkillCache();
	async function inspect(refs?: NoteRef[], activeNote?: string, folders = scope(refs, activeNote)) {
		const prefs = options();
		const issues: SkillScanIssue[] = [];
		const [managed, live] = await Promise.all([library.list(), discoverLiveSkills(cwd, app.vault.configDir, folders, prefs.sharedDirectories, new Set(prefs.disabledIds), { cache, issues })]);
		for (const skill of managed) if (skill.error) issues.push({ path: skill.path, reason: skill.error });
		const labels = { builtin: '内置', agent: 'Agent 创建', system: '系统导入', local: '本地', github: 'GitHub' };
		const local: DiscoveredSkill[] = managed.filter((item) => !item.error).map((s) => ({
			id: s.path, name: s.name, managed: s.name, description: s.description, sourceLabel: labels[s.source.kind],
			displayName: s.displayName, defaultPrompt: s.defaultPrompt,
			enabled: s.enabled, manual: s.userInvocable, implicit: s.allowImplicit,
		}));
		const ids = new Set(local.map((item) => item.id));
		const items: DiscoveredSkill[] = [...local, ...live.filter((item) => !ids.has(item.id)), {
			id: INSTALLER_ID, name: 'skill-installer', description: '从官方精选列表或公开 GitHub 仓库安装技能。',
			sourceLabel: '聊天安装入口', enabled: true, manual: true, implicit: false,
		}];
		return { items, issues };
	}
	async function list(refs?: NoteRef[], activeNote?: string, folders?: string[]) {
		return (await inspect(refs, activeNote, folders)).items;
	}
	async function sharedDirectory(path: string) {
		const actual = await realpath(path);
		const config = join(await realpath(cwd), app.vault.configDir);
		const canonicalConfig = await realpath(config).catch(() => config);
		if (isWithinPath(config, actual) || isWithinPath(canonicalConfig, actual)) throw new Error('请选择 Obsidian 配置目录以外的技能文件夹。');
		return actual;
	}
	async function commit(preview: ImportPreview, signal: AbortSignal, target?: string) {
		signal.throwIfAborted();
		if (target) {
			await sharedDirectory(target);
			await installSharedPackage(library.previewPackage(preview), target, () => options().sharedDirectories, signal);
		}
		else await library.install(preview, signal);
		notify();
	}
	return {
		library, scope, inspect, list, options, notify, sharedDirectory,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		budgetStatus: () => budget,
		reportBudget(next: typeof budget) {
			if (JSON.stringify(next) !== JSON.stringify(budget)) { budget = next; notify(); }
		},
		async setEnabled(id: string, enabled: boolean) {
			if (id === INSTALLER_ID) throw new Error('这是聊天安装入口。');
			const managed = (await library.list()).find((s) => s.path === id);
			if (managed) await library.setEnabled(managed.name, enabled);
			else {
				const prefs = options();
				const previous = prefs.disabledIds;
				const next = [...new Set(enabled ? previous.filter((x) => x !== id) : [...previous, id])];
				prefs.disabledIds = next;
				try { await save(); }
				catch (error) {
					if (options().disabledIds === next) options().disabledIds = previous;
					throw error;
				}
			}
			notify();
		},
		isCreator(skill: DiscoveredSkill) {
			return skill.managed === 'skill-creator' && skill.sourceLabel === '内置';
		},
		async read(skill: DiscoveredSkill, file = 'SKILL.md'): Promise<string> {
			if (skill.id === INSTALLER_ID) {
				if (file !== 'SKILL.md') throw new Error('安装入口没有配套文件。');
				return installerGuide;
			}
			const value = skill.managed ? await library.readFile(skill.managed, file) : await skillText(skillDirectory(skill), file);
			if (file !== 'SKILL.md') return value;
			const missing = skill.dependencies?.map((service) => `外部工具服务 ${service} 尚未连接。`) ?? [];
			if (skill.managed) for (const dep of await library.checkDependencies(skill.managed)) missing.push(`${dep.name}：${dep.detail}`);
			return [value, missing.length ? '当前依赖状态\n' + missing.join('\n') : ''].filter(Boolean).join('\n\n');
		},
		async propose(content: string, signal: AbortSignal) {
			const saved = await review.draft(content, async (text, target) => {
				const preview = await library.previewDraft(text);
				try {
					if (!target && preview.status !== 'new') throw new Error('已有同名技能，请更改草稿名称后保存。');
					await commit(preview, signal, target);
				} finally { library.discard(preview); }
			}, signal, [...options().sharedDirectories]);
			return saved ? '技能草稿已保存。' : '用户已取消，草稿未安装。';
		},
		async install(source: string, signal: AbortSignal) {
			const url = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(source)
				? 'https://github.com/openai/skills/tree/main/skills/.curated/' + source : source;
			const preview = await library.previewGithub(url, signal);
			try {
				const saved = await review.install(preview, (target) => commit(preview, signal, target), signal, [...options().sharedDirectories]);
				return saved ? `已安装 ${preview.name}。` : '用户已取消安装。';
			} finally { library.discard(preview); }
		},
		creatorPath: join(library.directory, 'skill-creator', 'SKILL.md'),
	};
}

export type SkillRegistry = ReturnType<typeof createSkillRegistry>;
