import { subagentUiText } from '../subagentUiText';
import type { CollaborationRow } from '../subagentTimeline';
import type { InspectSubagent } from './SubagentsPanel';

export default function CollaborationActivity({ action, agentId, name, inspect }: {
	action: CollaborationRow['action']; agentId: string; name: string; inspect?: InspectSubagent;
}) {
	const text = subagentUiText();
	return <div className="scribe-collab-event" data-activity={action}>
		<span aria-hidden="true">•</span><span>{text.activityLabels[action]}</span>
		{inspect ? <button type="button" className="scribe-subagent-activity-link scribe-collab-agent-name"
			data-agent-id={agentId} aria-label={`${text.inspect} · ${name}`}
			onClick={(event) => inspect(agentId, event.currentTarget)}><bdi>{name}</bdi></button> : <bdi>{name}</bdi>}
	</div>;
}
