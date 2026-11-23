import { Component, MarkdownRenderer, Notice } from 'obsidian';
import type { App } from 'obsidian';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { SKILL_LIBRARY } from '../../skills/library/SkillLibrary';
import type { LibrarySkill, ManagedSkillLibrary } from '../../skills/library/contracts';
import ChatIcon from '../components/ChatIcon';
import { IconButton, errorText, tr } from './dialog';
import { SkillEditorSession } from './editorDraft';

export interface DetailActions {
	use: (name: string) => Promise<void>; remove: (name: string) => Promise<void>; toggle: (enabled: boolean, name: string) => Promise<void>;
	restore: () => void; repair: () => Promise<void>; back: () => void; changed: (name?: string) => Promise<void>;
}
export function sourceLabel(kind: LibrarySkill['source']['kind']) {
	return { builtin: tr('内置', 'Built-in'), agent: tr('Agent 创建', 'Agent created'), local: tr('本地', 'Local'),
		system: tr('系统导入', 'System imported'), github: 'GitHub' }[kind];
}
export function SkillIcon({ library, skill }: { library: ManagedSkillLibrary; skill: LibrarySkill }) {
	const [src, setSrc] = useState<string>();
	useEffect(() => {
		let live = true;
		setSrc(undefined);
		if (skill.icon) void library.readIcon(skill.name).then((value) => { if (live) setSrc(value); }).catch(() => {});
		return () => { live = false; };
	}, [skill.name, skill.icon, library]);
	return src ? <img className="scribe-skill-icon" src={src} alt="" /> : null;
}
export function SkillSwitch({ skill, busy, onToggle }: { skill: LibrarySkill; busy: boolean; onToggle: (enabled: boolean) => void }) {
	return <button type="button" role="switch" aria-checked={skill.enabled && !skill.error} className="scribe-skill-switch"
		aria-label={tr('启用', 'Enable') + ' ' + skill.name} disabled={busy || Boolean(skill.error)} onClick={() => onToggle(!skill.enabled)}><span aria-hidden="true" /></button>;
}
function Preview({ app, file, text, sourcePath }: { app: App; file: string; text: string; sourcePath: string }) {
	const host = useRef<HTMLDivElement>(null);
	const markdown = /\.(md|mdx|markdown)$/i.test(file);
	useEffect(() => {
		const slot = host.current;
		if (!slot || !markdown) return;
		const el = slot.createDiv({ cls: 'markdown-rendered' });
		const owner = new Component();
		owner.load();
		const content = file === 'SKILL.md' ? text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '') : text;
		void MarkdownRenderer.render(app, content, el, sourcePath, owner).catch(() => { el.textContent = content; });
		return () => { owner.unload(); el.remove(); };
	}, [app, file, text, sourcePath, markdown]);
	return markdown ? <div ref={host} className="scribe-skill-preview" /> : <pre className="scribe-skill-preview">{text}</pre>;
}
function FileTree({ files, selected, busy, choose, prefix = '' }: { files: string[]; selected: string; busy: boolean; choose: (path: string) => void; prefix?: string }) {
	const names = [...new Set(files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split('/')[0]).filter((name): name is string => Boolean(name)))];
	return <ul role={prefix ? 'group' : 'tree'} aria-label={prefix ? undefined : tr('源文件', 'Source files')}>{names.map((name) => {
		const file = prefix + name;
		const folder = files.some((path) => path.startsWith(file + '/'));
		return <li role="none" key={file}>{folder ? <details><summary><ChatIcon name="folder" />{name}</summary>
			<FileTree files={files} selected={selected} busy={busy} choose={choose} prefix={file + '/'} /></details>
			: <button type="button" role="treeitem" aria-label={prefix ? file : undefined} aria-selected={selected === file} disabled={busy} onClick={() => choose(file)}><ChatIcon name="file-text" />{name}</button>}</li>;
	})}</ul>;
}
const fields = {
	displayName: () => tr('显示名', 'Display name'), shortDescription: () => tr('短描述', 'Short description'),
	icon: () => tr('图标文件（技能文件夹内）', 'Icon file (inside the skill folder)'), brandColor: () => tr('品牌色（#RRGGBB）', 'Brand color (#RRGGBB)'),
	defaultPrompt: () => tr('“立即使用”的默认提示语', 'Default prompt for Use now'),
};
const fieldKeys = Object.keys(fields) as (keyof typeof fields)[];
function Metadata({ skill, library, disabled, refresh, flush }: { skill: LibrarySkill; library: ManagedSkillLibrary; disabled: boolean; refresh: () => Promise<void>; flush: () => Promise<void> }) {
	const [edit, setEdit] = useState<LibrarySkill>(skill);
	const [original, setOriginal] = useState<LibrarySkill>(skill);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');
	const pathsHelp = useId();
	const paths = edit.paths?.join('\n') ?? '';
	const pathsChanged = paths !== (original.paths?.join('\n') ?? '');
	const editedFields = fieldKeys.filter((key) => edit[key] !== original[key]);
	const dirty = pathsChanged || editedFields.length > 0;
	useEffect(() => { if (!dirty) { setEdit(skill); setOriginal(skill); } }, [skill, dirty]);
	return <details className="scribe-skill-metadata"><summary><ChatIcon name="chevron-down" />{tr('技能设置', 'Skill settings')}</summary>
		<form onSubmit={(event) => {
			event.preventDefault();
			setBusy(true); setMessage('');
			const patch: Parameters<ManagedSkillLibrary['saveMetadata']>[1] = {};
			for (const key of editedFields) patch[key] = edit[key]?.trim() || undefined;
			if (pathsChanged) patch.paths = edit.paths;
			void flush().then(() => library.saveMetadata(skill.name, patch, original))
				.then(async () => { setOriginal(edit); await refresh(); }).catch((cause: unknown) => setMessage(errorText(cause))).finally(() => setBusy(false));
		}}>{fieldKeys.map((key) => <label key={key} className="scribe-skill-field">{fields[key]()}
			<input value={edit[key] ?? ''} disabled={busy || disabled} onChange={(event) => setEdit({ ...edit, [key]: event.currentTarget.value })} /></label>)}
			<label className="scribe-skill-field">{tr('自动推荐范围', 'Automatic recommendation scope')}
				<textarea rows={3} cols={28} value={paths} spellCheck={false} aria-describedby={pathsHelp} disabled={busy || disabled}
					onChange={(event) => setEdit({ ...edit, paths: event.currentTarget.value.split('\n') })} />
			</label>
			<small id={pathsHelp}>{tr('每行一项。可填笔记（会议/本周.md）、文件夹（会议/）或匹配规则（项目/**/*.md）。只影响自动推荐，留空表示不限范围。',
				'One vault-relative path per line. Use a note (Meetings/Weekly.md), a folder (Meetings/), or a pattern (Projects/**/*.md). Affects automatic recommendations only. Leave blank for any note.')}</small>
			{message && <p className="scribe-skill-error" role="alert">{message}</p>}
			<div><button disabled={busy || disabled || !dirty}>{tr('保存设置', 'Save settings')}</button></div></form>
	</details>;
}
function Dependencies({ skill, library }: { skill: LibrarySkill; library: ManagedSkillLibrary }) {
	const [result, setResult] = useState<Awaited<ReturnType<ManagedSkillLibrary['checkDependencies']>>>();
	const [error, setError] = useState('');
	const [version, setVersion] = useState(0);
	useEffect(() => {
		let live = true;
		setResult(undefined); setError('');
		void library.checkDependencies(skill.name).then((next) => { if (live) setResult(next); }).catch((e: unknown) => { if (live) setError(errorText(e)); });
		return () => { live = false; };
	}, [skill.name, library, version]);
	return <section aria-label={tr('技能依赖', 'Skill dependencies')}><div className="scribe-skill-dependency-head"><strong>{tr('技能依赖', 'Skill dependencies')}</strong>
		<button onClick={() => setVersion(version + 1)}><ChatIcon name="refresh-cw" />{tr('重新检测依赖', 'Recheck dependencies')}</button></div>
		{!result && !error && <p role="status">{tr('正在检测依赖…', 'Checking dependencies…')}</p>}
		{error && <p role="alert">{error}</p>}
		{result?.map((item, i) => <p key={i} className="scribe-skill-dependency"><span aria-label={item.ready ? tr('就绪', 'Ready') : tr('未就绪', 'Not ready')} className={item.ready ? 'is-ready' : 'is-missing'} />
			<strong>{item.name}</strong> <small>({item.detail}) {!item.ready && ({
				command: tr('请先自行安装该命令行工具，再使用此技能。', 'Install this command-line tool yourself before using the skill.'),
				'obsidian-plugin': tr('请自行从 Obsidian 设置安装该社区插件。', 'Install this community plugin from Obsidian settings yourself.'),
				'python-package': tr('请先自行安装该 Python 包，再使用此技能。', 'Install this Python package yourself before using the skill.'),
				mcp: tr('此技能需要连接相应的工具服务。', 'This skill needs the corresponding tool service.'),
			})[skill.dependencies[i]?.type ?? 'command']}</small></p>)}</section>;
}
export function SkillDetails({ app, library, skill, busy, actions, leave }: {
	app: App; library: ManagedSkillLibrary; skill: LibrarySkill; busy: boolean; actions: DetailActions; leave: { current: (() => Promise<void>) | null };
}) {
	const [session] = useState(() => SkillEditorSession.open(library, skill.name));
	const [recovered] = useState(() => session.dirty);
	const [file, setFile] = useState(session.doc?.file ?? 'SKILL.md');
	const [files, setFiles] = useState<string[]>([]);
	const [loadError, setLoadError] = useState('');
	const [fileError, setFileError] = useState('');
	const [saveError, setSaveError] = useState('');
	const [editing, setEditing] = useState(recovered);
	const [saving, setSaving] = useState(false);
	const [loading, setLoading] = useState(true);
	const [, redraw] = useState(0);
	const mounted = useRef(false);
	const loadId = useRef(0);
	const timer = useRef<number | undefined>(undefined);
	const host = useRef<HTMLDivElement>(null);
	const state = useRef({ actions, skill });
	state.current = { actions, skill };
	const builtin = skill.source.kind === 'builtin';
	const valid = !skill.error;
	async function flush() {
		host.current?.ownerDocument.defaultView?.clearTimeout(timer.current);
		const changed = session.dirty;
		if (changed && mounted.current) setSaving(true);
		try {
			await session.flush();
			if (mounted.current && changed) {
				setSaveError('');
				await state.current.actions.changed(session.name !== state.current.skill.name ? session.name : undefined);
				redraw((n) => n + 1);
			}
		} catch (cause) { if (mounted.current) setSaveError(errorText(cause)); throw cause; }
		finally { if (mounted.current) setSaving(false); }
	}
	const latestFlush = useRef(flush);
	latestFlush.current = flush;
	useLayoutEffect(() => {
		mounted.current = true;
		const win = host.current?.ownerDocument.defaultView;
		host.current?.querySelector<HTMLButtonElement>('header button')?.focus({ preventScroll: true });
		// 从列表下方打开详情时，设置窗口应从详情页标题开始显示。
		for (let pane = host.current?.parentElement; pane; pane = pane.parentElement) {
			if (pane.scrollTop && win && /auto|scroll/u.test(win.getComputedStyle(pane).overflowY)) pane.scrollTop = 0;
			if (pane.classList.contains('modal')) break;
		}
		leave.current = () => latestFlush.current();
		if (session.dirty) timer.current = win?.setTimeout(() => void latestFlush.current().catch(() => {}), 600);
		return () => {
			mounted.current = false;
			loadId.current++;
			win?.clearTimeout(timer.current);
			leave.current = null;
			if (session.dirty) void session.flush().catch((e: unknown) => new Notice(errorText(e)));
		};
	}, [session, leave]);
	useEffect(() => {
		let live = true;
		if (valid) void library.listFiles(session.name).then((list) => { if (live) setFiles(list); }).catch((e: unknown) => { if (live) setLoadError(errorText(e)); });
		return () => { live = false; };
	}, [library, session, valid]);
	useEffect(() => {
		const id = ++loadId.current;
		if (!valid) { setLoading(false); return; }
		setFileError(''); setLoading(true);
		if (session.doc?.file === file) { setLoading(false); return; }
		void library.readFile(session.name, file).then((content) => {
			if (loadId.current === id) { session.doc = { file, original: content, text: content }; redraw((n) => n + 1); setLoading(false); }
		}).catch((e: unknown) => { if (loadId.current === id) { setFileError(errorText(e)); setLoading(false); } });
	}, [library, session, file, valid]);
	const afterFlush = (fn: () => void | Promise<void>) => { void flush().then(fn).catch((cause: unknown) => setSaveError(errorText(cause))); };
	const switchFile = (next: string) => { if (next !== file) afterFlush(() => { setFile(next); setEditing(false); setSaveError(''); }); };
	const reload = async () => {
		const read = ++loadId.current;
		setLoading(true);
		try {
			const content = await library.readFile(session.name, file);
			if (loadId.current !== read) return;
			session.doc = { file, original: content, text: content };
			SkillEditorSession.discard(library, session.name);
			redraw((n) => n + 1);
			setFileError(''); setSaveError('');
		} catch (cause) { if (loadId.current === read) setFileError(errorText(cause)); }
		finally { if (loadId.current === read) setLoading(false); }
	};
	const doc = session.doc?.file === file ? session.doc : undefined;
	return <div className="scribe-skill-page scribe-skill-detail" ref={host}>
		<header className="scribe-skill-detail-head"><IconButton name="arrow-left" label={tr('返回技能列表', 'Back to skills')} disabled={busy} onClick={() => afterFlush(actions.back)} />
			<div><div className="scribe-skill-inline"><SkillIcon skill={skill} library={library} /><h3>{skill.displayName || skill.name}</h3>
				<span className="scribe-skill-badge">{sourceLabel(skill.source.kind)}</span>
				{builtin && <span className="scribe-skill-badge">{tr('只读', 'Read only')}</span>}
				<span className="scribe-skill-meta">{tr('全局启用', 'Global enabled')}</span>
				<SkillSwitch skill={skill} busy={busy} onToggle={(enabled) => afterFlush(async () => {
					await actions.toggle(enabled, session.name);
					if (session.doc?.file === 'SKILL.md' && !session.dirty) await reload();
				})} /></div>
				{valid && <p className="scribe-skill-detail-description">{skill.shortDescription || skill.description}</p>}{(skill.author || skill.tags?.length) && <small>{[skill.author, skill.tags?.join(', ')].filter(Boolean).join(' · ')}</small>}
				{(skill.source.displayPath || skill.source.origin) && <p className="scribe-skill-meta">{tr('导入来源', 'Imported from')} · {skill.source.displayPath || skill.source.origin}</p>}
			</div>
			<div className="scribe-skill-inline"><button className="mod-cta" disabled={busy || saving || !valid || !skill.userInvocable} onClick={() => afterFlush(() => actions.use(session.name))}><ChatIcon name="play" />{tr('立即使用', 'Use now')}</button>
				<IconButton name="trash-2" label={tr('卸载', 'Uninstall') + ' ' + skill.name} disabled={busy} onClick={() => afterFlush(() => actions.remove(session.name))} /></div>
		</header>
		{valid && skill.dependencies.length > 0 && <Dependencies skill={skill} library={library} />}
		{!builtin && valid && <Metadata skill={skill} library={library} disabled={busy} flush={flush} refresh={async () => {
			await actions.changed();
			if (session.doc?.file === 'SKILL.md' && !session.dirty) await reload();
		}} />}
		{recovered && session.dirty && <p role="status">{tr('已恢复尚未保存的修改。', 'Restored your unsaved edits.')}</p>}
		{(!valid || loadError) ? <div><p role="alert" className="scribe-skill-error">{skill.error || loadError}</p>
			<button onClick={() => builtin ? actions.restore() : void actions.repair()}>{builtin ? tr('恢复内置技能', 'Restore built-in skills') : tr('让 Agent 修复', 'Ask Agent to repair')}</button></div>
			: <div className="scribe-skill-workspace"><aside><strong>{tr('源文件', 'Source files')}</strong><FileTree files={files} selected={file} busy={busy} choose={switchFile} /></aside>
				<section className="scribe-skill-document"><div className="scribe-skill-doc-head"><ChatIcon name="file-text" /><strong>{file.split('/').pop()}</strong>
					{!builtin && doc && <><small role="status">{saveError ? tr('保存失败', 'Save failed') : saving || session.dirty ? tr('正在保存…', 'Saving…') : tr('已保存', 'Saved')}</small>
						<div className="scribe-skill-segments" role="radiogroup" aria-label={tr('技能视图', 'Skill view')}
							onKeyDown={(event) => {
								if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
								event.preventDefault();
								event.currentTarget.querySelectorAll('button')[editing ? 0 : 1]?.focus();
								setEditing(!editing);
							}}>
							<button type="button" role="radio" aria-checked={!editing} tabIndex={editing ? -1 : 0} onClick={() => setEditing(false)}>{tr('预览', 'Preview')}</button>
							<button type="button" role="radio" aria-checked={editing} tabIndex={editing ? 0 : -1} onClick={() => setEditing(true)}>{tr('编辑', 'Edit')}</button>
						</div></>}</div>
					{loading ? <p role="status">{tr('正在读取…', 'Loading…')}</p> : fileError ? <p className="scribe-skill-error" role="alert">{fileError}</p>
						: doc && (editing && !builtin ? <textarea spellCheck={false} className="scribe-skill-file-editor" value={doc.text} disabled={busy}
							aria-label={tr('文件内容', 'File contents')} onChange={(e) => { session.edit(e.currentTarget.value); redraw((n) => n + 1); setSaveError('');
								const win = host.current?.ownerDocument.defaultView; win?.clearTimeout(timer.current); timer.current = win?.setTimeout(() => void flush().catch(() => {}), 600); }} />
							: <Preview app={app} file={file} text={doc.text} sourcePath={SKILL_LIBRARY + '/' + skill.name + '/' + file} />)}
				</section></div>}
		{saveError && <div className="scribe-skill-inline" role="alert"><span className="scribe-skill-error">{saveError}</span>
			<button disabled={saving} onClick={() => void reload()}>{tr('重新读取文件', 'Reload from disk')}</button>
			<button disabled={saving} onClick={() => afterFlush(() => {})}>{tr('重试保存', 'Retry save')}</button></div>}
	</div>;
}
