import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatTask, ChatTaskBatch } from '../../orchestration/storage/chatTasks';
import { taskProgress, watchChatTaskBatch } from '../chatTaskProgress';

function tasks(...states: ChatTask['status'][]): ChatTask[] {
	return states.map((status, index) => ({ id: String(index + 1), subject: `第 ${index + 1} 项`, description: '', status, blocks: [], blockedBy: [] }));
}

void test('the task capsule counts completed items and keeps later pending items in the total after a stop', () => {
	const batch = tasks('completed', 'completed', 'completed', 'in_progress', 'pending', 'pending', 'pending');
	assert.deepEqual(taskProgress(batch), { status: 'in_progress', completed: 3 });
	batch[3]!.status = 'stopped';
	assert.deepEqual(taskProgress(batch), { status: 'stopped', completed: 3 });
	assert.deepEqual(taskProgress(tasks('pending')), { status: 'pending', completed: 0 });
	assert.deepEqual(taskProgress(batch.map((task) => ({ ...task, status: 'completed' }))), { status: 'completed', completed: 7 });
});

void test('the task capsule opens the latest batch and ignores stale or closed-view reads', async () => {
	const loads: ((batches: ChatTaskBatch[]) => void)[] = [];
	let notify: (() => void) | undefined;
	const shown: (number | undefined)[] = [];
	const close = watchChatTaskBatch({
		list(id) {
			assert.equal(id, 'chat-a');
			return new Promise((resolve) => loads.push(resolve));
		},
		subscribe(id, listener) {
			assert.equal(id, 'chat-a');
			notify = listener;
			return () => { notify = undefined; };
		},
	}, 'chat-a', (batch) => shown.push(batch?.id), () => assert.fail('unexpected read failure'));
	const saved = [{ id: 1, tasks: tasks('completed') }, { id: 2, tasks: tasks('pending') }];
	notify?.();
	loads[1]!(saved);
	loads[0]!([]);
	await Promise.resolve();
	assert.deepEqual(shown, [2]);
	notify?.();
	close();
	loads[2]!([]);
	await Promise.resolve();
	assert.equal(notify, undefined);
	assert.deepEqual(shown, [2]);
});
