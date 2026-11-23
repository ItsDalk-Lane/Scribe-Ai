import { randomUUID } from 'node:crypto';
import type { RunState, Task, TaskRequest } from '../types';

export function createTask(request: TaskRequest): Task {
	const now = Date.now();
	if (request.selection) throw new Error('选区问答已停用，请新建普通提问。');
	return {
		id: randomUUID(),
		request: {
			...request,
			...(request.skillScope && { skillScope: [...request.skillScope] }),
			...(request.skillNotePaths && { skillNotePaths: [...request.skillNotePaths] }),
			...(request.skillMentions && { skillMentions: request.skillMentions.map((mention) => ({ ...mention })) }),
			refs: request.refs.map((ref) => ({ ...ref, lines: ref.lines && [...ref.lines] })),
			chatQuotes: request.chatQuotes?.slice(),
		},
		status: 'pending',
		createdAt: now,
		updatedAt: now,
	};
}

export function updateTaskState(task: Task, state: RunState): void {
	const { status } = state;
	task.status = status === 'awaiting-approval' ? 'awaiting-user' : status === 'idle' ? 'pending' : status;
	task.updatedAt = Date.now();
}
