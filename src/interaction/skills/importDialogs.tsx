import type { App } from 'obsidian';
import { useEffect, useRef, useState } from 'react';
import type { BuiltinStatus, ImportPreview, ManagedSkillLibrary, SystemCandidate } from '../../skills/library/contracts';
import ChatIcon from '../components/ChatIcon';
import { pickExternalReference } from '../externalReferencePicker';
import { confirmSkill, errorText, openSkillDialog, SaveReview, tr } from './dialog';

function previewText(preview: ImportPreview) {
	return <>
		<p><strong>{preview.name}</strong></p>
		<p>{preview.description}</p>
		<p className="scribe-skill-meta">{preview.source.displayPath ?? preview.source.origin}</p>
		<details><summary>{tr('随附文件', 'Included files')} · {preview.files.length}</summary><ul>{preview.files.map((path) => <li key={path}>{path}</li>)}</ul></details>
		{preview.repairs.length > 0 && <div><p>{tr('以下格式问题已在待导入的副本中修正。', 'These formatting issues were repaired in the import copy.')}</p>
			{preview.repairs.map((repair, index) => <pre key={index} className="scribe-skill-diff"><del>{repair.before}</del>{'\n'}<ins>{repair.after}</ins></pre>)}</div>}
		{preview.status === 'replace' && <p className="scribe-skill-warning">{tr('更新将替换已安装的副本和配套文件，包括你的本地编辑。已损坏的技能更新后仍停用。', 'Updating replaces the installed copy and its supporting files, including local edits. A damaged skill stays disabled after updating.')}</p>}
		{preview.status === 'conflict' && <p role="alert" className="scribe-skill-error">{tr('同名技能来自其他来源，无法覆盖。', 'A skill from a different source already uses this name.')}</p>}
	</>;
}

export function openPackageReview(app: App, preview: ImportPreview, install: (target?: string, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal, sharedDirectories?: readonly string[]) {
	return openSkillDialog(app, preview.status === 'replace' ? tr('更新已导入技能', 'Update imported skill') : tr('导入技能', 'Import skill'),
		(done, active) => <SaveReview done={done} signal={active} sharedDirectories={sharedDirectories} disabled={preview.status === 'conflict'}
			label={preview.status === 'replace' ? tr('更新并替换', 'Update and replace') : tr('导入', 'Import')}
			commit={(_, target) => install(target, active)}>{previewText(preview)}</SaveReview>, signal);
}

type Props = { app: App; library: ManagedSkillLibrary; signal: AbortSignal; changed: () => Promise<void> };

function droppedPath(file: File, doc: Document): string | undefined {
	type Desktop = Window & { electron?: { webUtils?: { getPathForFile(file: File): string } }; require?: (id: 'electron') => { webUtils?: { getPathForFile(file: File): string } } };
	const win = doc.defaultView as Desktop | null;
	return win?.electron?.webUtils?.getPathForFile(file) || win?.require?.('electron').webUtils?.getPathForFile(file) || (file as File & { path?: string }).path;
}

export function LocalImport({ signal, select, done }: { signal: AbortSignal; select: (source: string) => void; done: () => void }) {
	const [busy, setBusy] = useState(false);
	const lock = useRef(false);
	const [err, setErr] = useState('');
	const [dragging, setDragging] = useState(false);
	const [manual, setManual] = useState(false);
	const [path, setPath] = useState('');
	const host = useRef<HTMLDivElement>(null);
	async function importFrom(choose: () => Promise<string | undefined>) {
		if (lock.current || signal.aborted) return;
		lock.current = true;
		setBusy(true);
		setErr('');
		try {
			const source = await choose();
			if (signal.aborted) return;
			done();
			if (source) select(source);
		} catch (cause) { if (!signal.aborted) setErr(errorText(cause)); }
		finally { lock.current = false; if (!signal.aborted) setBusy(false); }
	}
	function pick(kind: 'folder' | 'zip' | 'md') {
		return importFrom(async () => {
			if (!host.current) return;
			let selected;
			try {
				selected = await pickExternalReference(host.current.ownerDocument, kind === 'folder' ? 'folder' : 'file', tr('选择要导入的技能', 'Choose a skill to import'));
			} catch (cause) { setManual(true); throw cause; }
			if (!selected) return;
			if (kind === 'md' && !/\.md$/i.test(selected.path)) throw new Error(tr('请选择 Markdown 文件。', 'Choose a Markdown file.'));
			if (kind === 'zip' && !/\.zip$/i.test(selected.path)) throw new Error(tr('请选择 ZIP 压缩包。', 'Choose a ZIP archive.'));
			return selected.path;
		});
	}
	return <div className="scribe-skill-dialog-body" ref={host}>
		<button type="button" className="scribe-skill-drop" data-dragging={dragging || undefined} disabled={busy}
			onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
			onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
			onDrop={(event) => {
				event.preventDefault();
				setDragging(false);
				const file = event.dataTransfer.files[0];
				const doc = event.currentTarget.ownerDocument;
				void importFrom(() => {
					const value = file && droppedPath(file, doc);
					if (!value) throw new Error(tr('请使用下方按钮选择本地技能文件或文件夹。', 'Choose a local skill file or folder using a button below.'));
					return Promise.resolve(value);
				});
			}} onClick={() => void pick('zip')}><ChatIcon name="file-down" /><span>{tr('将技能文件夹或 ZIP 压缩包拖到这里，或点击选择 ZIP', 'Drop a skill folder or a ZIP archive here, or click to choose a ZIP')}</span>
			<small>{tr('支持 ZIP 压缩包、包含 SKILL.md 的文件夹，以及单个技能 Markdown 文件', 'Supports .zip files, folders containing SKILL.md, and single skill .md files')}</small></button>
		{err && <p role="alert" className="scribe-skill-error">{err}</p>}
		<div className="scribe-skill-inline"><button disabled={busy} onClick={() => void pick('folder')}><ChatIcon name="folder-open" />{tr('导入文件夹', 'Import folder')}</button>
			<button disabled={busy} onClick={() => void pick('zip')}><ChatIcon name="file-down" />{tr('导入 ZIP 压缩包', 'Import ZIP archive')}</button>
			<button disabled={busy} onClick={() => void pick('md')}><ChatIcon name="file-text" />{tr('导入 Markdown 文件', 'Import Markdown file')}</button></div>
		{manual && <form onSubmit={(e) => { e.preventDefault(); void importFrom(() => Promise.resolve(path.trim())); }}>
			<label>{tr('本地完整路径', 'Full local path')} <input value={path} onChange={(e) => setPath(e.currentTarget.value)} /></label>
			<button disabled={busy || !path.trim()}>{tr('预览', 'Preview')}</button></form>}
	</div>;
}

export function SystemImport({ app, library, changed, signal }: Props) {
	const [candidates, setCandidates] = useState<SystemCandidate[]>([]);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [results, setResults] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const lock = useRef(false);
	async function search() {
		setLoading(true);
		try {
			const result = await library.searchSystem(signal);
			if (!signal.aborted) { setCandidates(result.candidates); setWarnings(result.warnings); setSelected(new Set()); setResults({}); }
		} catch (cause) { if (!signal.aborted) setWarnings([errorText(cause)]); }
		finally { if (!signal.aborted) setLoading(false); }
	}
	useEffect(() => { void search(); }, [library, signal]);
	async function add(items: SystemCandidate[]) {
		if (lock.current || signal.aborted) return;
		lock.current = true;
		setBusy(true);
		try {
			for (const candidate of items) {
				if (signal.aborted) break;
				const status = (value: string) => { if (!signal.aborted) setResults((previous) => ({ ...previous, [candidate.path]: value })); };
				try {
					status(tr('正在导入…', 'Importing…'));
					const preview = await library.previewLocal(candidate.path, 'system', signal);
					try {
						if (signal.aborted) break;
						if (preview.status === 'replace' || preview.status === 'conflict' || preview.repairs.length) {
							if (!await openPackageReview(app, preview, (_, active) => library.install(preview, active), signal)) { status(tr('已取消', 'Cancelled')); continue; }
						} else await library.install(preview, signal);
					} finally { library.discard(preview); }
					status(tr('已导入', 'Imported'));
					if (!signal.aborted) {
						setCandidates((before) => before.map((item) => item.path === candidate.path ? { ...item, status: 'installed' } : item));
						setSelected((before) => { const next = new Set(before); next.delete(candidate.path); return next; });
						await changed();
					}
				} catch (cause) { status(errorText(cause)); }
			}
		} finally { lock.current = false; if (!signal.aborted) setBusy(false); }
	}
	return <section className="scribe-skill-dialog-body"><p>{tr('从其他工具导入技能副本，原文件夹保留在原处。', 'Import a copy of skills from other tools. Their original folders are kept.')}</p>
		<div className="scribe-skill-inline"><button disabled={busy || loading} onClick={() => void search()}>{tr('刷新', 'Refresh')}</button>
			<button className="mod-cta" disabled={busy || loading || !selected.size} onClick={() => void add(candidates.filter((item) => selected.has(item.path)))}>{tr('导入所选技能', 'Import selected')}</button></div>
		{loading && <p role="status">{tr('正在搜索技能…', 'Searching for skills…')}</p>}
		{warnings.length > 0 && <div role="alert" className="scribe-skill-warning"><p>{tr('部分位置未能检查，可刷新后重试。', 'Some locations could not be checked. Refresh to retry.')}</p>{warnings.map((w, i) => <p key={i}>{w}</p>)}</div>}
		{!loading && !candidates.length && !warnings.length && <p>{tr('未在支持的位置找到技能。', 'No skills found in the supported locations.')}</p>}
		{candidates.map((item) => <div key={item.path} className="scribe-skill-card scribe-skill-import-row">
			<input type="checkbox" aria-label={item.name} checked={selected.has(item.path)} disabled={busy || loading || Boolean(item.error) || item.status === 'conflict'}
				onChange={(e) => { const checked = e.currentTarget.checked; setSelected((old) => { const next = new Set(old); if (checked) next.add(item.path); else next.delete(item.path); return next; }); }} />
			<div><strong>{item.name}</strong><p>{item.description}</p><small>{item.sources.join(', ')}</small><small>{item.path}</small>
				<p>{item.status === 'available' ? tr('可导入', 'Available to import') : item.status === 'conflict' ? tr('名称冲突', 'Name conflict') : tr('已导入', 'Already imported')}</p>
				{item.error && <p role="alert" className="scribe-skill-error">{item.error}</p>}
				{item.renamedFrom && <p className="scribe-skill-warning">{tr('名称将在导入时调整', 'Name changes on import')} · {item.renamedFrom} → {item.name}</p>}
				{Boolean(item.repair?.length) && <details><summary>{tr('查看格式修正', 'View formatting repairs')}</summary>{item.repair?.map((change, i) => <pre className="scribe-skill-diff" key={i}><del>{change.before}</del>{'\n'}<ins>{change.after}</ins></pre>)}</details>}
				{results[item.path] && <p role="status">{results[item.path]}</p>}</div>
			<button className="mod-cta" disabled={busy || loading || Boolean(item.error) || item.status === 'conflict'} onClick={() => void add([item])}>{item.status === 'installed' ? tr('重新导入', 'Reimport') : tr('导入', 'Import')}</button>
		</div>)}
	</section>;
}

const builtinLabel = (state: BuiltinStatus['status']) => ({
	installed: tr('已安装', 'Installed'), removed: tr('已卸载', 'Uninstalled'), missing: tr('文件缺失', 'Missing'),
	modified: tr('在 Scribe 外修改过', 'Modified outside Scribe'), conflict: tr('已有个人技能使用此名称', 'A personal skill already uses this name'),
})[state];

export function RestoreBuiltins({ app, library, changed, signal }: Props) {
	const [states, setStates] = useState<BuiltinStatus[]>();
	const [error, setError] = useState('');
	const [results, setResults] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const lock = useRef(false);
	useEffect(() => { void library.builtinStatus().then((value) => { if (!signal.aborted) setStates(value); }).catch((e: unknown) => { if (!signal.aborted) setError(errorText(e)); }); }, [library, signal]);
	async function restore(items: BuiltinStatus[]) {
		if (lock.current) return;
		lock.current = true;
		setBusy(true);
		setError('');
		try {
			for (const item of items) {
				if (signal.aborted) break;
				try {
					const state = (await library.builtinStatus()).find((entry) => entry.name === item.name)?.status;
					if (!state || state === 'installed' || state === 'conflict' || signal.aborted) continue;
					const revision = state === 'modified' ? await library.revision(item.name) : undefined;
					if (state === 'modified' && !await confirmSkill(app, tr('重置内置技能', 'Reset built-in skill'),
						tr('将用内置版本替换这个技能的本地修改。', 'This replaces local changes with the bundled version.') + ' ' + item.name, tr('重置', 'Reset'), signal)) continue;
					if (signal.aborted) break;
					await library.restore(item.name, state, revision);
					if (!signal.aborted) setResults((old) => ({ ...old, [item.name]: tr('已恢复', 'Restored') }));
				}
				catch (cause) { if (!signal.aborted) setResults((old) => ({ ...old, [item.name]: errorText(cause) })); }
			}
			if (!signal.aborted) { setStates(await library.builtinStatus()); await changed(); }
		} catch (cause) { if (!signal.aborted) setError(errorText(cause)); }
		finally { lock.current = false; if (!signal.aborted) setBusy(false); }
	}
	const recoverable = states?.filter((entry) => entry.status !== 'installed' && entry.status !== 'conflict') ?? [];
	return <section className="scribe-skill-dialog-body"><p>{tr('重新安装已卸载的技能，或将被修改的内置技能恢复到随插件附带的版本。', 'Restore uninstalled skills or reset modified built-ins to the version included with Scribe.')}</p>
		{!states && !error && <p role="status">{tr('正在读取…', 'Loading…')}</p>}
		{states?.every((entry) => entry.status === 'installed') && <p>{tr('所有内置技能均已安装。', 'All built-in skills are installed.')}</p>}
		{error && <p role="alert" className="scribe-skill-error">{error}</p>}
		<div><button className="mod-cta" disabled={busy || !recoverable.length} onClick={() => void restore(recoverable)}>{tr('恢复全部', 'Restore all')}</button></div>
		{states?.map((item) => <div className="scribe-skill-card" key={item.name}><div><strong>{item.name}</strong><p>{builtinLabel(item.status)}</p>
			{results[item.name] && <small role="status">{results[item.name]}</small>}</div>
			{item.status !== 'installed' && <button className="mod-cta" disabled={busy || item.status === 'conflict'} onClick={() => void restore([item])}>{item.status === 'modified' ? tr('重置', 'Reset') : tr('恢复', 'Restore')}</button>}</div>)}
	</section>;
}
