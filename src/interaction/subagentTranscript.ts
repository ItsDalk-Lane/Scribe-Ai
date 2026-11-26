import type { Message, SavedRun, SubagentView } from '../types';
import { subagentOperation } from '../tools/subagentTools';
import { messageTime } from './chatMetrics';
import { restoreExecution } from './context';
import { toolTextField } from './toolCardDetails';

export function questionBody(content: string, question: string, prefix: string) {
	const text = content.trimEnd();
	const raw = question.trim();
	const original = raw.startsWith(prefix) ? raw.slice(prefix.length).trimStart() : raw;
	const before = text.endsWith(original) ? text.slice(0, -original.length).trimEnd() : text;
	if (before.endsWith(prefix)) return before + original;
	return [before, prefix + original].filter(Boolean).join('\n\n');
}

// 协作工具的答复也会写入用户消息。只为显示转换发件正文，保留实际调用和交稿记录。
function childMessages(run: SavedRun, parent: string, prefix: string, outbox: { kind: string; text: string }[],
	answers: NonNullable<SubagentView['notes']>, seen: Set<string>) {
	const results = new Map(run.state.messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]));
	const hidden = new Map<string, boolean>();
	const ended = new Set<Message>();
	const source = run.state.messages;
	const messages = source.map((message, index): Message | undefined => {
		if (message.role === 'tool' && message.toolCallId && hidden.has(message.toolCallId)) {
			if (!hidden.get(message.toolCallId)) return;
			const matched = answers.findIndex((note) => note.text === message.content);
			const reply = matched < 0 ? undefined : answers.splice(matched, 1)[0];
			// 较早的记录可能只在提问的工具结果中保存了答复，保留它当时的位置。
			if (reply && seen.has(reply.id)) return;
			if (!reply && source.slice(index + 1).some((item) => item.subagentActivity?.kind === 'instruction'
				&& item.content === message.content)) return;
			if (reply) seen.add(reply.id);
			return { role: 'user', id: 'subagent:' + (reply?.id ?? message.toolCallId), content: message.content };
		}
		if (message.subagentActivity?.kind === 'instruction') return { ...message, subagentActivity: undefined };
		if (!message.toolCalls?.length || message.incomplete) return message;
		let content = message.content;
		let asked = false;
		const calls = message.toolCalls.filter((call) => {
			const operation = subagentOperation(call);
			const question = operation === 'ask_parent';
			if (!question && !(operation === 'send_message' && toolTextField(call.input, 'target') === parent)) return true;
			const text = toolTextField(call.input, 'message')?.trim();
			if (!text || results.get(call.id)?.skipped) return true;
			outbox.push({ kind: question ? 'question' : 'message', text });
			if (results.get(call.id)?.isError) return true;
			hidden.set(call.id, question);
			asked ||= question;
			content = question ? questionBody(content, text, prefix) : [content.trimEnd(), text].filter(Boolean).join('\n\n');
			return false;
		});
		if (calls.length === message.toolCalls.length) return message;
		const output: Message = { ...message, content, toolCalls: calls };
		if (!calls.length) {
			if (output.rawAssistant) output.rawAssistant = { ...output.rawAssistant, stopReason: 'stop' };
			if (asked) ended.add(output);
		}
		return output;
	});
	return { messages, ended };
}

export function subagentChatTurns(agent: SubagentView, prefix: string) {
	const parent = agent.parentId ?? 'root';
	const seen = new Set<string>();
	const outbox: { kind: string; text: string }[] = [];
	for (const run of agent.runs) {
		for (const message of run.state.messages) {
			if (message.subagentActivity) seen.add(message.subagentActivity.id);
			if (message.id?.startsWith('steer:')) seen.add(message.id.slice(6));
		}
	}
	const answers = (agent.notes ?? []).filter((note) => note.kind === 'answer' && note.to === agent.id && note.from === parent);
	const turns = agent.runs.flatMap((run) => {
		const { state } = run;
		const { messages, ended } = childMessages(run, parent, prefix, outbox, answers, seen);
		const boundaries = [0];
		for (const [index, message] of messages.entries()) {
			if (message?.role === 'user' && (index > 0 || message.id?.startsWith('subagent:') || message.id?.startsWith('steer:'))) boundaries.push(index);
		}
		let startedAt = state.createdAt;
		const skillFolders = new Set(run.request.skillScope);
		return boundaries.map((start, index) => {
			const next = boundaries[index + 1];
			const input = index ? messages[start] : undefined;
			const slice = messages.slice(start, next).filter((item): item is Message => Boolean(item));
			for (const message of slice) if (message.role === 'user') {
				for (const folder of message.skillScope ?? []) skillFolders.add(folder);
			}
			const request = input ? { conversationId: run.request.conversationId, instruction: input.content,
				refs: [], skillScope: [...skillFolders] } : run.request;
			const last = slice.at(-1);
			const outgoing = last && ended.has(last);
			const finished = next !== undefined || (outgoing && state.status === 'running');
			const finishedAt = finished ? messageTime([...slice].reverse().find((m) => m.role === 'assistant' && !m.local)) : state.finishedAt;
			const execution = restoreExecution({
				...run, request, step: next === undefined ? run.step : undefined, partial: next === undefined ? run.partial : undefined,
				state: { ...state, messages: slice, createdAt: startedAt, finishedAt, auxiliaryUsage: next === undefined ? state.auxiliaryUsage : undefined,
					...(finished && { status: 'done', error: undefined, pendingCalls: [] }) },
				retries: run.retries?.filter(({ beforeMessage }) => beforeMessage >= start && (next === undefined || beforeMessage < next))
					.map((item) => ({ ...item, beforeMessage: item.beforeMessage - start })),
			});
			// 费用与工具次数按真实消息统计，界面合并提问正文不会改变它们。
			if (execution.state) execution.state = { ...execution.state, messages: state.messages.slice(start, next) };
			startedAt = finishedAt;
			return { key: index === 0 ? state.taskId : input?.id ?? state.taskId + ':input:' + start, request, execution, model: run.model };
		});
	});
	const pending = (agent.notes ?? []).filter((note) => {
		if (seen.has(note.id)) return false;
		if (note.from !== agent.id || note.to !== parent) return note.to === agent.id && note.kind !== 'result';
		// 旧发件记录没有调用编号，按原文逐次匹配同样的问题。
		const index = outbox.findIndex(({ kind, text }) => kind === note.kind && text === note.text.trim());
		if (index < 0) return true;
		outbox.splice(index, 1);
		return false;
	});
	return { turns, pending };
}
