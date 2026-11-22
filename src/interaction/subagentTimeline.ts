import type { SubagentSnapshot } from '../types';
import { subagentToolNames } from '../tools/subagentTools';
import type { TimelineRow } from './chatTimeline';
import { toolTextField } from './toolCardDetails';

export type CollaborationRow = {
	kind: 'collaboration'; id: string; action: 'started' | 'contacted' | 'completed'; agentId: string; agentName?: string;
};

type ChatRow = TimelineRow | CollaborationRow | { kind: 'to-parent'; id: string; question: boolean; content: string };

export function collaborationRows(rows: readonly TimelineRow[], submissions?: SubagentSnapshot['submissions'], parentAgentId?: string): ChatRow[] {
	return rows.flatMap((row): ChatRow[] => {
		if (row.kind === 'subagent') {
			if (parentAgentId && row.activity.kind === 'instruction') return [row];
			if (row.activity.kind !== 'result') return [];
			const { id, agentId, agentName } = row.activity;
			const note = submissions?.[id];
			if (note?.status && note.status !== 'done' && note.status !== 'file-changes-done') {
				return [{ kind: 'notice', id: row.id, code: 'collaboration', tone: 'warning', detail: agentName }];
			}
			return [{ kind: 'collaboration', id: row.id, action: 'completed', agentId, agentName }];
		}
		if (row.kind !== 'tool' || !subagentToolNames.has(row.call.name)) return [row];
		const { name, input } = row.call;
		if (row.skipped) return [];
		const error: ChatRow[] = row.result?.isError ? [{ kind: 'notice', id: `error:${row.id}`, code: 'collaboration',
			tone: 'warning', detail: row.result.content, resolved: row.resolved }] : [];
		if (parentAgentId && (name === 'ask_parent' || (name === 'send_message' && toolTextField(input, 'target') === parentAgentId))) {
			const content = toolTextField(input, 'message');
			return content ? [{ kind: 'to-parent', id: row.id, question: name === 'ask_parent', content }, ...error] : error;
		}
		if (!row.result || error.length) return error;
		if (name === 'send_message' || name === 'followup_task') {
			const agentId = toolTextField(input, 'target');
			return agentId ? [{ kind: 'collaboration', id: row.id, action: 'contacted', agentId }] : [];
		}
		if (name !== 'spawn_agent' && name !== 'answer_subagent' && name !== 'review_subagent_result') return [];
		let output: Record<string, unknown>;
		try {
			output = JSON.parse(row.result.content) as Record<string, unknown>;
		} catch {
			return [];
		}
		if (!output || typeof output !== 'object') return [];
		if (name === 'review_subagent_result' && output.status !== 'returned') return [];
		const recipient = name === 'review_subagent_result' ? output.agent : output;
		const agentId = toolTextField(recipient, name === 'answer_subagent' ? 'target' : 'id');
		return agentId ? [{ kind: 'collaboration', id: row.id, action: name === 'spawn_agent' ? 'started' : 'contacted',
			agentId, agentName: toolTextField(recipient, 'name') }] : [];
	});
}
