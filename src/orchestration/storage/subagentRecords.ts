import type { ConversationEntry, SubagentNote } from '../../types';

const reservedParticipants = new Set(['root', 'user']);

/** 核对每条记录所引用的主任务、子任务和消息是否属于当前对话。 */
export function createSubagentRecordIndex(conversationId: string) {
	const roots = new Map<string, { deliveryAgents?: string[]; finished?: boolean; reported?: boolean }>();
	const agents = new Map<string, { rootTaskId: string; parentId?: string; firstRunId?: string }>();
	const runs = new Map<string, { agentId: string; finished?: boolean }>();
	const notes = new Map<string, { agentId: string; note: SubagentNote }>();
	const reviewed = new Set<string>();
	const answered = new Set<string>();
	const participant = (id: string) => agents.has(id) || reservedParticipants.has(id);

	return {
		observe(item: ConversationEntry) {
			if (item.type === 'start') {
				if (item.task.request.conversationId !== conversationId) throw new Error('任务不属于此对话。');
				if (runs.has(item.task.id)) throw new Error('主任务与子任务的编号重复。');
				roots.set(item.task.id, {});
				return;
			}
			if (item.type === 'messages') {
				const root = roots.get(item.taskId);
				for (const { deliveryAgents } of item.messages) {
					if (!deliveryAgents) continue;
					if (!root || root.deliveryAgents || root.finished !== undefined || deliveryAgents.some((id) => {
						const agent = agents.get(id);
						return agent?.rootTaskId !== item.taskId || agent.parentId !== undefined;
					})) throw new Error('收件确认关联的后台任务无效。');
					root.deliveryAgents = deliveryAgents;
				}
				return;
			}
			if (item.type === 'finish') {
				const root = roots.get(item.taskId);
				if (root) root.finished = item.status === 'done';
				return;
			}
			if (item.type === 'subagent-report') {
				const root = roots.get(item.taskId);
				if (!root?.finished || !root.deliveryAgents || root.reported || root.deliveryAgents.some((id) => {
					const runId = agents.get(id)?.firstRunId;
					return !runId || runs.get(runId)?.finished !== true;
				})) throw new Error('后台结果回传的任务或记录顺序无效。');
				root.reported = true;
				return;
			}
			if (item.type !== 'subagent') return;
			const { agentId, record } = item;
			if (record.kind === 'create') {
				const { rootTaskId, parentId, parentTaskId } = record.agent;
				if (participant(agentId) || !roots.has(rootTaskId) || (parentId !== undefined && !agents.has(parentId))
					|| (parentTaskId !== undefined && (parentId ? runs.get(parentTaskId)?.agentId !== parentId : parentTaskId !== rootTaskId))) {
					throw new Error('子 Agent 的编号或所属任务无效。');
				}
				agents.set(agentId, { rootTaskId, parentId });
				return;
			}
			const agent = agents.get(agentId);
			if (!agent) throw new Error('子 Agent 不属于此对话。');
			switch (record.kind) {
				case 'run': {
					const { entry } = record;
					if (entry.type === 'start') {
						const { id, request } = entry.task;
						const caller = request.subagentCallerTaskId;
						if (request.conversationId !== conversationId || roots.has(id) || runs.has(id)
							|| (caller && (agent.parentId ? runs.get(caller)?.agentId !== agent.parentId : !roots.has(caller)))) {
							throw new Error('子任务不属于此对话或编号重复。');
						}
						runs.set(id, { agentId });
						agent.firstRunId ??= id;
						break;
					}
					const run = runs.get(entry.taskId);
					if (run?.agentId !== agentId || run.finished) throw new Error('子任务记录顺序无效。');
					if (entry.type === 'finish') run.finished = true;
					break;
				}
				case 'note': {
					const note = record.note;
					const { id, from, to, kind, questionId } = note;
					const owner = kind === 'result' || !agents.has(to) ? from : to;
					if (!participant(from) || !participant(to) || notes.has(id) || owner !== agentId) {
						throw new Error('子 Agent 消息的编号或所属对话无效。');
					}
					if (kind === 'result' && note.path && (runs.get(id)?.agentId !== from || !runs.get(id)?.finished
						|| to !== (agent.parentId ?? 'root') || note.path !== `subagents/${from}/${id}`)) {
						throw new Error('子 Agent 回传结果不属于已完成的对应任务。');
					}
					if (kind === 'question' && ((agents.get(from)?.parentId ?? 'root') !== to || !agents.has(from))) {
						throw new Error('只能向直接派发任务的一方提问。');
					}
					if (kind === 'answer') {
						const question = questionId ? notes.get(questionId)?.note : undefined;
						if (!questionId || question?.kind !== 'question' || question.from !== to || question.to !== from || answered.has(questionId)) {
							throw new Error('此答复找不到唯一对应的提问。');
						}
						answered.add(questionId);
					}
					notes.set(id, { agentId, note });
					break;
				}
				case 'review': {
					const item = notes.get(record.noteId);
					if (item?.agentId !== agentId || item.note.kind !== 'result' || !item.note.path || reviewed.has(record.noteId)) {
						throw new Error('验收记录未关联到属于当前子 Agent 的交稿。');
					}
					reviewed.add(record.noteId);
					break;
				}
				case 'delivered':
					if (record.ids.some((id) => notes.get(id)?.agentId !== agentId)) throw new Error('找不到已送达的子 Agent 消息。');
					break;
			}
		},
	};
}
