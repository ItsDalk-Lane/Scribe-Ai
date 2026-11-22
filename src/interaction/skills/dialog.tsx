import { getLanguage, Modal } from 'obsidian';
import type { App } from 'obsidian';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import ChatIcon from '../components/ChatIcon';

export const tr = (zh: string, en: string): string => getLanguage().toLowerCase().startsWith('zh') ? zh : en;
export const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export function IconButton({ name, label, disabled, onClick }: {
	name: string; label: string; disabled?: boolean; onClick: () => void;
}) {
	return <button type="button" className="clickable-icon" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
		<ChatIcon name={name} />
	</button>;
}

export function openSkillDialog(app: App, title: string, render: (done: (result?: boolean) => void, signal: AbortSignal) => ReactNode, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const modal = new Modal(app);
		modal.titleEl.setText(title);
		modal.modalEl.addClass('scribe-skill-modal');
		const root = createRoot(modal.contentEl);
		const controller = new AbortController();
		let confirmed = false;
		const finish = modal.close.bind(modal);
		const close = () => finish();
		modal.close = () => {
			if (!modal.contentEl.querySelector('[data-skill-saving="true"]')) finish();
		};
		const done = (result = false) => { confirmed = result; close(); };
		modal.onOpen = () => root.render(render(done, controller.signal));
		modal.onClose = () => {
			controller.abort();
			signal?.removeEventListener('abort', close);
			// 父设置页也可能正在卸载，下一次微任务再清理弹窗的 React 根。
			queueMicrotask(() => root.unmount());
			resolve(confirmed);
		};
		signal?.addEventListener('abort', close, { once: true });
		modal.open();
	});
}

export function confirmSkill(app: App, title: string, content: ReactNode, label: string, signal?: AbortSignal): Promise<boolean> {
	return openSkillDialog(app, title, (done) => <div className="scribe-skill-dialog-body">
		<div>{content}</div>
		<div className="scribe-skill-dialog-actions"><button type="button" onClick={() => done()}>{tr('取消', 'Cancel')}</button>
			<button type="button" className="mod-cta" onClick={() => done(true)}>{label}</button></div>
	</div>, signal);
}

export function SaveReview({ initialContent, sharedDirectories, children, label, commit, done, signal, disabled }: {
	initialContent?: string; sharedDirectories?: readonly string[]; children?: ReactNode; label: string; disabled?: boolean;
	commit: (content: string, target?: string) => Promise<void>; done: (result?: boolean) => void; signal: AbortSignal;
}) {
	const [content, setContent] = useState(initialContent ?? '');
	const [target, setTarget] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const pending = useRef(false);
	async function save() {
		if (pending.current || signal.aborted) return;
		pending.current = true;
		setBusy(true);
		setError('');
		try {
			await commit(content, target || undefined);
			if (!signal.aborted) done(true);
		} catch (cause) { if (!signal.aborted) setError(errorText(cause)); }
		finally { pending.current = false; if (!signal.aborted) setBusy(false); }
	}
	return <div className="scribe-skill-dialog-body" data-skill-saving={busy || undefined}>
		{children}
		{initialContent !== undefined && <div className="scribe-skill-draft"><div className="scribe-skill-draft-name">SKILL.md</div><textarea className="scribe-skill-draft-editor" aria-label={tr('完整技能草稿', 'Complete skill draft')}
			spellCheck={false} value={content} disabled={busy} onChange={(event) => setContent(event.currentTarget.value)} /></div>}
		{Boolean(sharedDirectories?.length) && <label className="scribe-skill-field">{tr('保存位置', 'Save in')}
			<select disabled={busy} value={target} onChange={(event) => setTarget(event.currentTarget.value)}>
				<option value="">{tr('当前库', 'Current vault')}</option>
				{sharedDirectories?.map((path) => <option key={path} value={path}>{path}</option>)}
			</select></label>}
		{error && <p role="alert" className="scribe-skill-error">{error}</p>}
		<div className="scribe-skill-dialog-actions"><button type="button" disabled={busy} onClick={() => done()}>{tr('取消', 'Cancel')}</button>
			<button type="button" className="mod-cta" disabled={busy || (disabled && !target) || (initialContent !== undefined && !content.trim())} onClick={() => void save()}>
				{busy ? tr('正在保存…', 'Saving…') : label}
			</button></div>
	</div>;
}
