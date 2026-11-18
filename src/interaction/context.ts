import type { RunEvent, RunState, SavedRun, ToolApproval, ToolCall, ToolResult } from '../types';

export interface ChatApproval extends ToolApproval {
	decide(allow: boolean): void;
}

export interface ToolActivity {
	key: string;
	turn: number;
	call: ToolCall;
	result?: ToolResult;
}

export interface ChatExecution {
	state: RunState | null;
	turn: number;
	draft: string;
	activities: ToolActivity[];
	modelRetry?: 'automatic' | 'manual';
}

export const emptyExecution: ChatExecution = { state: null, turn: 0, draft: '', activities: [] };

export function restoreExecution(run: SavedRun): ChatExecution {
	const activities: ToolActivity[] = [];
	let turn = 0;
	let current = new Map<string, ToolActivity>();
	for (const message of run.state.messages) {
		if (message.role === 'assistant') {
			turn++;
			current = new Map();
			for (const call of message.toolCalls ?? []) {
				const activity = { key: `${turn}:${call.id}`, turn, call };
				current.set(call.id, activity);
				activities.push(activity);
			}
		}
		if (message.role === 'tool' && message.toolCallId) {
			const activity = current.get(message.toolCallId);
			if (activity) activity.result = {
				callId: message.toolCallId,
				content: message.content,
				isError: message.isError ?? false,
			};
		}
	}
	return {
		state: run.state.messages.some(({ role }) => role === 'user') ? run.state : {
			...run.state,
			messages: [{ role: 'user', content: run.request.instruction }, ...run.state.messages],
		},
		turn: run.state.turn,
		draft: run.partial ?? '',
		activities: activities.filter((activity) => activity.result
			|| (activity.turn === run.step?.turn && activity.call.id === run.step.call?.id)),
	};
}

export function updateExecution(previous: ChatExecution, event: RunEvent): ChatExecution {
	switch (event.type) {
		case 'turn-start':
			return { ...previous, turn: event.turn, draft: '', modelRetry: undefined };
		case 'model-retry':
			return { ...previous, draft: '', modelRetry: event.waiting ? 'manual' : 'automatic' };
		case 'text-delta':
			return { ...previous, draft: previous.draft + event.text, modelRetry: undefined };
		case 'tool-start':
			return {
				...previous,
				activities: [
					...previous.activities,
					{ key: `${previous.turn}:${event.call.id}`, turn: previous.turn, call: event.call },
				],
			};
		case 'tool-end':
			return {
				...previous,
				activities: previous.activities.map((activity) => activity.key === `${previous.turn}:${event.call.id}`
					? { ...activity, result: event.result }
					: activity),
			};
		case 'state': {
			// 回复写入历史后移除同一轮的临时文本。
			const firstNewMessage = previous.state?.messages.length ?? 0;
			const savedReply = event.state.messages.slice(firstNewMessage).some((message) => message.role === 'assistant');
			return { ...previous, state: event.state, draft: savedReply ? '' : previous.draft, modelRetry: undefined };
		}
	}
}
