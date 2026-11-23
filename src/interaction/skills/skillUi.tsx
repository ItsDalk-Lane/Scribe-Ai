import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type ScribeAiPlugin from '../../main';
import type { ImportPreview, LibrarySkill } from '../../skills/library/contracts';
import ChatIcon from '../components/ChatIcon';
import { updateOverflowTitle } from '../overflowTitle';
import { confirmSkill, errorText, IconButton, openSkillDialog, SaveReview, tr } from './dialog';
import { LocalImport, openPackageReview, RestoreBuiltins, SystemImport } from './importDialogs';
import { SkillDetails, SkillIcon, SkillSwitch, sourceLabel } from './skillDetails';
import { SkillEditorSession } from './editorDraft';
import { renderSkillPreferences } from './generalSettings';

function SkillPreferences({ plugin }: { plugin: ScribeAiPlugin }) {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => { if (host.current) renderSkillPreferences(plugin, host.current); }, [plugin]);
	return <div ref={host} className="scribe-skill-preferences" />;
}

export function openSkillDraftReview(app: App, initialContent: string, save: (content: string, target?: string) => Promise<void>, signal?: AbortSignal, sharedDirectories?: readonly string[]) {
	return openSkillDialog(app, tr('确认技能草稿', 'Review skill draft'), (done, active) => <SaveReview
		initialContent={initialContent} sharedDirectories={sharedDirectories} label={tr('保存', 'Save')} commit={save} done={done} signal={active}>
		<p>{tr('请检查完整草稿。选择保存后才会安装这项技能。', 'Review the complete draft. The skill is installed when you choose Save.')}</p>
	</SaveReview>, signal);
}
export function openGithubSkillReview(app: App, preview: ImportPreview, install: (target?: string) => Promise<void>, signal?: AbortSignal, sharedDirectories?: readonly string[]) {
	return openPackageReview(app, preview, install, signal, sharedDirectories);
}

function usageNote(skill: LibrarySkill) {
	if (!skill.usage.count || !skill.usage.lastUsedAt) return '';
	const hours = Math.max(0, Math.floor((Date.now() - skill.usage.lastUsedAt) / 3600000));
	const last = hours === 0 ? tr('刚刚', 'just now') : hours < 24 ? tr(hours + ' 小时前', hours + 'h ago') : tr(Math.floor(hours / 24) + ' 天前', Math.floor(hours / 24) + 'd ago');
	return tr('使用 ' + skill.usage.count + ' 次，上次使用于' + last, 'Used ' + skill.usage.count + ' times, last ' + last);
}
function settingsClose(app: App) { (app as App & { setting?: { close(): void } }).setting?.close(); }

export interface SkillPageHandle { beforeLeave: () => Promise<void>; dispose: () => void }
export function renderSkillSettings(plugin: ScribeAiPlugin, container: HTMLElement, warning: (count: number) => void): SkillPageHandle {
	const root = createRoot(container);
	const leave = { current: null as (() => Promise<void>) | null };
	root.render(<SkillPage plugin={plugin} leave={leave} warning={warning} />);
	return { beforeLeave: async () => { await leave.current?.(); }, dispose: () => root.unmount() };
}
function SkillPage({ plugin, leave, warning }: { plugin: ScribeAiPlugin; leave: { current: (() => Promise<void>) | null }; warning: (count: number) => void }) {
	const { app } = plugin;
	const registry = plugin.services.orchestration.skills;
	const { library } = registry;
	const [rows, setRows] = useState<LibrarySkill[]>([]);
	const [selected, setSelected] = useState<string>();
	const [query, setQuery] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [attention, setAttention] = useState(false);
	const [budget, setBudget] = useState<{ omitted: string[]; shortened: boolean; listed?: number }>(() => registry.budgetStatus());
	const lastBudget = useRef(registry.budgetStatus());
	const notifying = useRef(false);
	const [menu, setMenu] = useState(false);
	const controller = useRef<AbortController>(new AbortController());
	const host = useRef<HTMLDivElement>(null);
	const menuButton = useRef<HTMLButtonElement>(null);
	const searchInput = useRef<HTMLInputElement>(null);
	const generation = useRef(0);
	const lock = useRef(false);
	async function refresh(name?: string) {
		const current = ++generation.current;
		try {
			const [skills, status] = await Promise.all([library.list(), library.builtinStatus()]);
			if (controller.current.signal.aborted || current !== generation.current) return;
			setRows(skills); warning(skills.filter((s) => Boolean(s.error)).length);
			setAttention(status.some((s) => s.status === 'missing' || s.status === 'modified' || s.status === 'conflict'));
			lastBudget.current = registry.budgetStatus();
			setBudget(lastBudget.current);
			if (name) setSelected((open) => open === selected ? name : open);
			setLoading(false);
		} catch (cause) {
			if (current === generation.current && !controller.current.signal.aborted) { setLoading(false); setError(errorText(cause)); }
		}
	}
	useEffect(() => {
		const active = new AbortController();
		controller.current = active;
		const win = host.current?.ownerDocument.defaultView;
		const update = () => { void refresh(); };
		update();
		const unsubscribe = registry.subscribe(() => {
			const next = registry.budgetStatus();
			if (lastBudget.current !== next) { lastBudget.current = next; setBudget(next); }
			else if (!notifying.current) update();
		});
		win?.addEventListener('focus', update);
		return () => { active.abort(); unsubscribe(); win?.removeEventListener('focus', update); };
	}, [registry]);
	async function changed(name?: string) {
		notifying.current = true;
		try { registry.notify(); } finally { notifying.current = false; }
		await refresh(name);
	}
	async function perform(operation: () => Promise<void>) {
		if (lock.current || controller.current.signal.aborted) return;
		lock.current = true; setBusy(true); setError('');
		try { await operation(); }
		catch (cause) { if (!controller.current.signal.aborted) setError(errorText(cause)); }
		finally { lock.current = false; if (!controller.current.signal.aborted) setBusy(false); }
	}
	const launch = async (skill: LibrarySkill, kind: 'use' | 'create') => {
		if (!skill.enabled) {
			if (!await confirmSkill(app, tr('启用并使用技能', 'Enable and use skill'), tr('打开聊天前启用 ', 'Enable before opening a chat: ') + skill.name + '？', tr('启用并使用', 'Enable and use'), controller.current.signal)) return;
			await library.setEnabled(skill.name, true); await changed();
		}
		const draft = kind === 'create' ? tr('请帮我创建一个技能。', 'Help me create a skill.') : skill.defaultPrompt || ('$' + skill.name + ' ');
		await plugin.openSkillChat({ kind, skillId: skill.path, draft });
		settingsClose(app);
	};
	const repair = async (skill: LibrarySkill) => {
		await plugin.openSkillChat({ kind: 'repair', skillId: skill.path, draft: tr('请修复这个技能。', 'Please repair this skill.') + '\n' + skill.path + '\n' + (skill.error ?? tr('无法打开技能文件。', 'The skill file could not be opened.')) });
		settingsClose(app);
	};
	const uninstall = async (skill: LibrarySkill) => {
		const builtin = skill.source.kind === 'builtin';
		const revision = await library.revision(skill.name);
		if (!await confirmSkill(app, tr('卸载 ', 'Uninstall ') + skill.name + '？',
			builtin ? tr('将移除此内置技能和配套文件。之后可通过“恢复内置技能”重新安装。', 'This removes the built-in skill and supporting files. Restore built-in skills can reinstall it.')
				: tr('将永久删除已安装的技能文件夹和配套文件，保留原始导入来源。', 'This permanently removes the installed folder and its supporting files. The original source is kept.'),
			tr('卸载', 'Uninstall'), controller.current.signal)) return;
		await library.remove(skill.name, revision);
		SkillEditorSession.discard(library, skill.name); setSelected(undefined); await changed(); new Notice(tr('技能已卸载', 'Skill uninstalled'));
	};
	const toggle = (skill: LibrarySkill, enabled: boolean) => perform(async () => { await library.setEnabled(skill.name, enabled); await changed(); });
	function show(which: 'restore' | 'system' | 'local') {
		setMenu(false);
		const title = which === 'restore' ? tr('恢复内置技能', 'Restore built-in skills') : which === 'system' ? tr('系统搜索', 'System search') : tr('本地导入', 'Local import');
		void openSkillDialog(app, title, (done, signal) => {
			const props = { app, library, signal, changed };
			return which === 'restore' ? <RestoreBuiltins {...props} /> : which === 'system' ? <SystemImport {...props} /> : <LocalImport signal={signal} done={done} select={(path) => {
				void perform(async () => {
					const active = controller.current.signal;
					const preview = await library.previewLocal(path, 'local', active);
					try {
						if (!active.aborted && await openPackageReview(app, preview, (_, review) => library.install(preview, review), active)) {
							await changed();
							new Notice(tr('已导入技能', 'Skill imported'));
						}
					} finally { library.discard(preview); }
				});
			}} />;
		}, controller.current.signal);
	}
	async function currentSkill(name: string) {
		const found = (await library.list()).find((item) => item.name === name);
		if (!found) throw new Error(tr('技能已变化，请刷新列表。', 'The skill has changed. Refresh the list.'));
		return found;
	}
	const current = rows.find((s) => s.name === selected);
	const term = query.trim().toLocaleLowerCase();
	const filtered = rows.filter((s) => [s.name, s.displayName, s.description, s.shortDescription, s.error].some((value) => value?.toLocaleLowerCase().includes(term)))
		.sort((a, b) => Number(Boolean(a.error)) - Number(Boolean(b.error)) || a.name.localeCompare(b.name));
	const stale = rows.filter((s) => !s.error && s.usage.lastUsedAt && Date.now() - s.usage.lastUsedAt > 90 * 86400000);
	return <div ref={host} className="scribe-skill-page">
		{error && <p role="alert" className="scribe-skill-error">{error}</p>}
		{current ? <SkillDetails app={app} library={library} skill={current} busy={busy} leave={leave} actions={{
			use: (name) => perform(async () => launch(await currentSkill(name), 'use')),
			toggle: (enabled, name) => perform(async () => { await library.setEnabled(name, enabled); await changed(); }),
			remove: (name) => perform(async () => uninstall(await currentSkill(name))),
			repair: () => perform(() => repair(current)), restore: () => show('restore'), changed, back: () => setSelected(undefined),
		}} /> : <>
			<SkillPreferences plugin={plugin} />
			<header className="scribe-skill-toolbar"><strong>{tr('技能', 'Skills')} <span className="scribe-skill-meta">{rows.length}</span></strong>
				<div className="scribe-skill-search"><input type="text" ref={searchInput} aria-label={tr('搜索技能', 'Search skills')} placeholder={tr('搜索技能…', 'Search skills…')}
					value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
					{query && <button className="scribe-skill-search-clear" aria-label={tr('清除搜索', 'Clear search')} onClick={() => { setQuery(''); searchInput.current?.focus(); }}><ChatIcon name="circle-x" /></button>}
					<ChatIcon name="search" /></div>
				<div className="scribe-skill-actions"><button type="button" disabled={busy} onClick={() => show('restore')}><ChatIcon name="rotate-ccw" />{tr('恢复内置技能', 'Restore built-in skills')}</button>
					<div className="scribe-skill-menu-anchor" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setMenu(false); }}
						onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); menuButton.current?.focus(); } }}>
						<button type="button" ref={menuButton} disabled={busy} className="mod-cta" aria-expanded={menu} onClick={() => setMenu(!menu)}><ChatIcon name="plus" />{tr('添加技能', 'Add skill')}</button>
						{menu && <div className="scribe-skill-menu"><button onClick={() => { setMenu(false); void perform(async () => {
							const creator = (await library.list()).find((item) => item.name === 'skill-creator' && item.source.kind === 'builtin' && !item.error && item.userInvocable);
							if (!creator) throw new Error(tr('请先恢复内置的 skill-creator 技能。', 'Restore the built-in skill-creator first.'));
							await launch(creator, 'create');
						}); }}>{tr('Agent 创建', 'Create with Agent')}</button>
						<button onClick={() => show('system')}>{tr('系统搜索', 'System search')}</button><button onClick={() => show('local')}>{tr('本地导入', 'Local import')}</button></div>}
					</div></div></header>
			{(busy || loading) && <p role="status">{busy ? tr('正在更新技能…', 'Updating skills…') : tr('正在读取…', 'Loading…')}</p>}
			{attention && <p className="scribe-skill-meta" role="status">{tr('部分内置技能需要处理。打开“恢复内置技能”可查看名称冲突或本地修改。', 'Some built-in skills need attention. Open Restore built-in skills to review conflicts or local changes.')}</p>}
			{(budget.shortened || budget.omitted.length > 0 || (budget.listed ?? 0) > 0) && <p className="scribe-skill-meta" role="status">{
				budget.omitted.length ? tr('模型可见目录已省略以下技能', 'Skills omitted from the model-visible catalog') + ' · ' + budget.omitted.join(', ')
					: budget.shortened ? tr('模型可见目录已缩短技能描述。', 'Descriptions in the model-visible catalog have been shortened.')
						: tr('模型可见目录正常，共 ', 'Model-visible catalog: ') + budget.listed + tr(' 项。', ' skills.')
			}</p>}
			<section className="scribe-skill-list" aria-label={tr('您的技能', 'Your skills')}>{filtered.map((skill) => <div key={skill.path} className="scribe-skill-card">
				<button type="button" className="scribe-skill-summary" onClick={() => setSelected(skill.name)}>
					<span className="scribe-skill-inline"><SkillIcon skill={skill} library={library} />
						<strong onPointerEnter={({ currentTarget }) => updateOverflowTitle(currentTarget)}>{skill.displayName || skill.name}</strong>
						<span className="scribe-skill-badge">{sourceLabel(skill.source.kind)}</span>
					</span>
					<span className="scribe-skill-description" title={skill.error || undefined}
						onPointerEnter={skill.error ? undefined : ({ currentTarget }) => updateOverflowTitle(currentTarget)}>
						{skill.error ? tr('无法加载此技能', 'Could not load this skill') : skill.shortDescription || skill.description}
					</span>
					{skill.usage.count > 0 && <small>{usageNote(skill)}</small>}</button>
				<div className="scribe-skill-inline"><IconButton label={tr('立即使用 ', 'Use now: ') + skill.name} name="play" disabled={busy || Boolean(skill.error) || !skill.userInvocable} onClick={() => void perform(() => launch(skill, 'use'))} />
					<SkillSwitch skill={skill} busy={busy} onToggle={(enabled) => void toggle(skill, enabled)} /><IconButton label={tr('卸载 ', 'Uninstall ') + skill.name} name="trash-2" disabled={busy} onClick={() => void perform(() => uninstall(skill))} /></div>
			</div>)}
			{!loading && !filtered.length && (rows.length ? <p>{tr('没有符合搜索条件的技能。', 'No skills match your search.')}</p> : <div className="scribe-skill-empty"><ChatIcon name="layout-grid" />{tr('暂无技能', 'No skills yet')}</div>)}</section>
			{stale.length > 0 && <p role="status" className="scribe-skill-meta">{tr('以下技能已超过 90 天未使用', 'Not used in over 90 days')} · {stale.map((s) => s.name).join(', ')}</p>}
		</>}
	</div>;
}
