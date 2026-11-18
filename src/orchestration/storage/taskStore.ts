import type { ConversationEntry, ConversationSnapshot, SavedRun, TaskRequest } from '../../types';

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
	return typeof value === 'string';
}

function count(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function call(value: unknown): boolean {
	return record(value) && text(value.id) && text(value.name);
}

function rawAssistant(value: unknown): boolean {
	return record(value) && value.role === 'assistant' && text(value.api) && text(value.provider) && text(value.model)
		&& text(value.stopReason) && count(value.timestamp) && record(value.usage) && Array.isArray(value.content)
		&& value.content.every((block: unknown) => record(block) && (
			(block.type === 'text' && text(block.text))
			|| (block.type === 'thinking' && text(block.thinking))
			|| (block.type === 'toolCall' && call(block) && record(block.arguments))
		));
}

const roles = new Set<unknown>(['system', 'user', 'assistant', 'tool']);
const terminalStates = new Set<unknown>(['done', 'file-changes-done', 'partial', 'failed', 'cancelled', 'limit', 'interrupted']);
const phases = new Set<unknown>(['starting', 'model', 'tool', 'approval', 'tool-result']);

function message(value: unknown): boolean {
	return record(value) && roles.has(value.role) && text(value.content)
		&& (value.role !== 'tool' || text(value.toolCallId))
		&& (value.toolName === undefined || text(value.toolName))
		&& (value.isError === undefined || typeof value.isError === 'boolean')
		&& (value.skipped === undefined || (value.role === 'tool' && value.skipped === true))
		&& (value.incomplete === undefined || (value.role === 'assistant' && value.incomplete === true
			&& value.toolCalls === undefined && value.rawAssistant === undefined))
		&& (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(call)))
		&& (value.rawAssistant === undefined || (value.role === 'assistant' && rawAssistant(value.rawAssistant)));
}

function request(value: unknown): value is TaskRequest {
	return record(value) && text(value.conversationId) && text(value.instruction) && Array.isArray(value.refs)
		&& value.refs.every((ref: unknown) => record(ref) && text(ref.path)
			&& (ref.kind === undefined || ref.kind === 'file' || ref.kind === 'folder')
			&& (ref.addedExternal === undefined || ref.addedExternal === true)
			&& (ref.lines === undefined || (Array.isArray(ref.lines) && ref.lines.length === 2 && ref.lines.every(count))))
		&& (value.selection === undefined || validSelection(value.selection));
}

function validSelection(value: unknown): boolean {
	if (!record(value) || !text(value.path) || !text(value.title) || !text(value.text) || !value.text.trim()
		|| !Array.isArray(value.lines) || value.lines.length !== 2) return false;
	const [first, last] = value.lines as unknown[];
	return count(first) && count(last) && first > 0 && last >= first;
}

function step(value: unknown): boolean {
	return record(value) && phases.has(value.phase) && count(value.turn)
		&& (value.call === undefined || call(value.call));
}

function entry(value: unknown): value is ConversationEntry {
	if (!record(value)) return false;
	if (value.type === 'start') {
		return record(value.task) && text(value.task.id) && request(value.task.request)
			&& record(value.model) && text(value.model.providerId) && text(value.model.model);
	}
	if (!text(value.taskId)) return false;
	switch (value.type) {
		case 'messages':
			return Array.isArray(value.messages) && value.messages.every(message)
				&& (value.step === undefined || step(value.step));
		case 'step':
			return step(value.step);
		case 'finish':
			return terminalStates.has(value.status) && count(value.turn)
				&& (value.resumed === undefined || typeof value.resumed === 'boolean')
				&& (value.error === undefined || text(value.error)) && (value.partial === undefined || text(value.partial));
		default:
			return false;
	}
}

export function parseConversationEntry(line: string, number: number): ConversationEntry {
	try {
		const value: unknown = JSON.parse(line);
		if (!entry(value)) throw new Error('对话记录格式无效。');
		return value;
	} catch (error) {
		throw Object.assign(new ConversationRecordError(`无法读取对话记录的第 ${number} 行。`), { cause: error });
	}
}

export class ConversationRecordError extends Error {}

/** 恢复历史和停留位置。未写入结束状态的任务显示为中断。 */
export async function replayConversation(id: string, entries: AsyncIterable<ConversationEntry>): Promise<ConversationSnapshot> {
	const runs = new Map<string, SavedRun>();
	const finished = new Set<string>();
	for await (const item of entries) {
		if (item.type === 'start') {
			const { task, model } = item;
			if (task.request.conversationId !== id || runs.has(task.id)) throw new Error('对话中的任务编号无效或重复。');
			runs.set(task.id, {
				request: task.request,
				model,
				state: { taskId: task.id, turn: 0, messages: [], pendingCalls: [], status: 'interrupted' },
				step: { phase: 'starting', turn: 0 },
			});
			continue;
		}
		const run = runs.get(item.taskId);
		if (!run || finished.has(item.taskId)) throw new Error('对话中的任务记录顺序无效。');
		const { state } = run;
		switch (item.type) {
			case 'messages':
				for (const message of item.messages) {
					state.messages.push(message);
					if (message.role === 'assistant' && !message.incomplete) state.pendingCalls = message.toolCalls ?? [];
					if (message.role === 'tool') {
						state.pendingCalls = state.pendingCalls.filter((tool) => tool.id !== message.toolCallId);
					}
				}
				if (item.step) {
					run.step = item.step;
					state.turn = item.step.turn;
				}
				break;
			case 'step':
				run.step = item.step;
				state.turn = item.step.turn;
				break;
			case 'finish':
				state.status = item.status;
				state.turn = item.turn;
				state.error = item.error;
				if (item.resumed) state.resumed = true;
				run.partial = item.partial;
				run.finalized = true;
				finished.add(item.taskId);
				break;
		}
	}
	return { id, runs: [...runs.values()] };
}
