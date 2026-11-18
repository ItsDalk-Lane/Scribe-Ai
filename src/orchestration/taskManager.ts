import { randomUUID } from 'node:crypto';
import type { RunState, Task, TaskRequest } from '../types';

export function createTask(request: TaskRequest): Task {
	const now = Date.now();
	const { selection } = request;
	if (selection && (!selection.text.trim() || !selection.path.trim() || !selection.title.trim()
		|| selection.lines.length !== 2 || !selection.lines.every(Number.isSafeInteger)
		|| selection.lines[0] < 1 || selection.lines[0] > selection.lines[1])) {
		throw new Error('选区内容无效，请重新附上选区。');
	}
	return {
		id: randomUUID(),
		request: {
			...request,
			instruction: request.instruction.trim(),
			refs: selection ? [] : request.refs.map((ref) => ({ ...ref, lines: ref.lines && [...ref.lines] })),
			selection: selection && { path: selection.path, title: selection.title, text: selection.text, lines: [...selection.lines] },
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
