import type { App } from 'obsidian';
import { useState } from 'react';
import type { ChatPlan } from '../chatPlan';
import { tr } from '../skills/dialog';
import ChatMarkdown from './ChatMarkdown';

export default function ChatPlanCard({ app, plan, disabled, onRevise, onSave, onExecute }: {
	app: App; plan: ChatPlan; disabled: boolean; onRevise: () => void;
	onSave: (markdown: string, revision: string) => Promise<void>;
	onExecute: (mode: 'continue' | 'fresh') => void;
}) {
	const heading = tr('查看待确认的计划', 'Review proposed plan');
	const [draft, setDraft] = useState<{ markdown: string; revision: string }>();
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	async function save() {
		if (!draft || saving || disabled) return;
		setSaving(true);
		setError('');
		try {
			await onSave(draft.markdown, draft.revision);
			setDraft(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally { setSaving(false); }
	}
	return <section className="scribe-task-card" aria-label={heading}>
		<details open={draft ? true : undefined}>
			<summary>{heading}</summary>
			<div className="scribe-task-card-plan">
				{draft ? <textarea aria-label={tr('编辑计划正文', 'Edit plan text')} rows={12}
					value={draft.markdown} disabled={saving} onChange={(event) => setDraft({ ...draft, markdown: event.target.value })} />
					: <ChatMarkdown app={app} content={plan.markdown} />}
				{plan.request.refs.length > 0 && <>
					<strong>{tr('已选资料', 'Attached material')}</strong>
					<ul>{plan.request.refs.map(({ path }, index) => <li key={`${path}:${index}`}>{path}</li>)}</ul>
				</>}
			</div>
		</details>
		{error && <p role="alert">{error}</p>}
		<div className="scribe-modal-actions">
			{draft ? <>
				<button type="button" disabled={saving} onClick={() => { setDraft(undefined); setError(''); }}>{tr('取消', 'Cancel')}</button>
				<button type="button" disabled={disabled || saving} className="mod-cta" onClick={() => void save()}>{tr('保存修改', 'Save changes')}</button>
			</> : <>
				<button type="button" disabled={disabled} onClick={() => setDraft({ markdown: plan.markdown, revision: plan.revision })}>{tr('编辑计划', 'Edit plan')}</button>
			<button type="button" disabled={disabled} onClick={onRevise}>{tr('要求修改', 'Revise')}</button>
			<button type="button" disabled={disabled} onClick={() => onExecute('fresh')}>{tr('以新上下文执行', 'Execute in a fresh context')}</button>
				<button type="button" disabled={disabled} className="mod-cta" onClick={() => onExecute('continue')}>{tr('按此执行', 'Execute plan')}</button>
			</>}
		</div>
	</section>;
}
