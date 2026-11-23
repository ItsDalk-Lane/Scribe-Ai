import type { App } from 'obsidian';
import type { ChatPlan } from '../chatPlan';
import { tr } from '../skills/dialog';
import ChatMarkdown from './ChatMarkdown';

export default function ChatPlanCard({ app, plan, disabled, onRevise, onExecute }: {
	app: App; plan: ChatPlan; disabled: boolean; onRevise: () => void; onExecute: () => void;
}) {
	const heading = tr('查看待确认的计划', 'Review proposed plan');
	return <section className="scribe-task-card" aria-label={heading}>
		<details>
			<summary>{heading}</summary>
			<div className="scribe-task-card-plan">
				<ChatMarkdown app={app} content={plan.markdown} />
				{plan.request.refs.length > 0 && <>
					<strong>{tr('已选资料', 'Attached material')}</strong>
					<ul>{plan.request.refs.map(({ path }, index) => <li key={`${path}:${index}`}>{path}</li>)}</ul>
				</>}
			</div>
		</details>
		<div className="scribe-modal-actions">
			<button type="button" disabled={disabled} onClick={onRevise}>{tr('继续修改', 'Revise')}</button>
			<button type="button" disabled={disabled} className="mod-cta" onClick={onExecute}>{tr('按此执行', 'Execute plan')}</button>
		</div>
	</section>;
}
