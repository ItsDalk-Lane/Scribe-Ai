import type { ChatTask, ChatTaskBatch, ChatTaskStore } from '../orchestration/storage/chatTasks';

export function taskProgress(tasks: ChatTask[]) {
	const completed = tasks.filter(({ status }) => status === 'completed').length;
	const status: ChatTask['status'] = completed === tasks.length ? 'completed'
		: tasks.some((task) => task.status === 'in_progress') ? 'in_progress'
			: tasks.some((task) => task.status === 'stopped') ? 'stopped' : 'pending';
	return { status, completed };
}

/** 读盘期间可能再次收到状态更新，只让最近一次读取更新当前窗口。 */
export function watchChatTaskBatch(store: Pick<ChatTaskStore, 'list' | 'subscribe'>, conversationId: string,
	show: (batch?: ChatTaskBatch) => void, failed: () => void) {
	let revision = 0;
	const refresh = () => {
		const requested = ++revision;
		void store.list(conversationId).then((batches) => {
			if (requested === revision) show(batches.at(-1));
		}, () => { if (requested === revision) failed(); });
	};
	const unsubscribe = store.subscribe(conversationId, refresh);
	refresh();
	return () => { ++revision; unsubscribe(); };
}
