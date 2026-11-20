import { randomUUID } from 'node:crypto';
import { useRef, useState } from 'react';
import type { ConversationStore, QueuedMessage, TaskRequest } from '../types';
import { uiText } from './uiText';

type QueueRow = QueuedMessage & { pending?: boolean; failed?: boolean };
type QueueView = { rows: QueueRow[]; saving: Promise<void> };
const acceptedSideQuestions = new WeakMap<ConversationStore, Set<string>>();

export function useMessageQueue(store: ConversationStore, onSaveError: () => void, saved: QueuedMessage[] = []) {
	const view = useRef<QueueView>({ rows: saved, saving: Promise.resolve() });
	const [rows, setRows] = useState<QueueRow[]>(saved);
	const [paused, setPaused] = useState(Boolean(saved.length));
	const updates = useRef(0);
	const [updating, setUpdating] = useState(false);
	function beginUpdate() {
		updates.current++;
		setUpdating(true);
	}
	function endUpdate() {
		updates.current--;
		if (!updates.current) setUpdating(false);
	}
	function update(owner: QueueView, rows: QueueRow[]) {
		owner.rows = rows;
		if (view.current === owner) setRows(rows);
	}

	function persist(owner: QueueView, row: QueueRow, conversation: Promise<string>) {
		const operation = owner.saving.then(async () => {
			const conversationId = await conversation;
			const message = { id: row.id, request: { ...row.request, conversationId } };
			await store.enqueue(conversationId, message);
			const saved = await store.getQueued(conversationId).catch(() => [message]);
			update(owner, owner.rows.flatMap((item) => item.id !== row.id ? [item]
				: saved.filter(({ id }) => id === row.id)));
		});
		owner.saving = operation;
		void operation.catch(() => {
			update(owner, owner.rows.map((item) => item.id === row.id ? { ...item, pending: false, failed: true } : item));
			if (view.current === owner) {
				setPaused(true);
				onSaveError();
			}
		});
	}

	return {
		rows,
		paused,
		updating,
		isUpdating: () => updates.current > 0,
		sentToSide: (id: string) => acceptedSideQuestions.get(store)?.has(id) === true,
		pause() { setPaused(true); },
		add(request: TaskRequest, conversation: Promise<string>) {
			const owner = view.current;
			const row = { id: randomUUID(), request, pending: true };
			update(owner, [...owner.rows, row]);
			persist(owner, row, conversation);
		},
		resume(conversation: Promise<string>) {
			const owner = view.current;
			const failed = owner.rows.filter((row) => row.failed);
			if (failed.length) {
				owner.saving = Promise.resolve();
				update(owner, owner.rows.map((row) => row.failed ? { ...row, failed: false, pending: true } : row));
				for (const row of failed) persist(owner, row, conversation);
			}
			setPaused(false);
		},
		remove(messageId: string) {
			const owner = view.current;
			update(owner, owner.rows.filter(({ id }) => id !== messageId));
		},
		async edit(message: QueuedMessage, instruction: string) {
			const owner = view.current;
			beginUpdate();
			try {
				await store.editQueued(message.request.conversationId, message.id, instruction);
				update(owner, owner.rows.map((row) => row.id === message.id
					? { ...row, request: { ...row.request, instruction } } : row));
			} finally {
				endUpdate();
			}
		},
		async delete(message: QueuedMessage, transfer?: { ask: () => Promise<void>; beforeRemove: () => void }) {
			const owner = view.current;
			beginUpdate();
			try {
				let accepted = acceptedSideQuestions.get(store);
				if (transfer && !accepted?.has(message.id)) {
					await transfer.ask();
					// 侧聊已接收时，保存队列失败后的重试只移除原消息。
					accepted = acceptedSideQuestions.get(store) ?? new Set();
					accepted.add(message.id);
					acceptedSideQuestions.set(store, accepted);
				}
				try {
					await store.deleteQueued(message.request.conversationId, message.id);
				} catch (cause) {
					if (transfer) throw new Error(uiText().saveFailed);
					throw cause;
				}
				accepted?.delete(message.id);
				if (view.current === owner) transfer?.beforeRemove();
				update(owner, owner.rows.filter(({ id }) => id !== message.id));
			} finally {
				endUpdate();
			}
		},
	};
}
