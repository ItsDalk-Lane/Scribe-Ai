import { useEffect, useState } from 'react';
import type { ChatTask, ChatTaskBatch, ChatTaskStore } from '../../orchestration/storage/chatTasks';
import { taskProgress, watchChatTaskBatch } from '../chatTaskProgress';
import { tr } from '../skills/dialog';
import ChatIcon from './ChatIcon';
import MetricPopover from './MetricPopover';

function statusLabel(status: ChatTask['status']) {
	switch (status) {
		case 'pending': return tr('待办', 'Pending');
		case 'in_progress': return tr('进行中', 'In progress');
		case 'stopped': return tr('已停止', 'Stopped');
		case 'completed': return tr('已完成', 'Completed');
	}
}

function TaskMark({ status }: { status: ChatTask['status'] }) {
	const icon = { pending: 'circle', in_progress: 'loader-circle', stopped: 'square', completed: 'circle-check' }[status];
	return <span className="scribe-chat-task-mark" data-status={status} aria-hidden="true"><ChatIcon name={icon} /></span>;
}

export default function ChatTaskProgress({ conversationId, store }: { conversationId: string; store: ChatTaskStore }) {
	const [batch, setBatch] = useState<ChatTaskBatch>();
	const [failed, setFailed] = useState(false);
	useEffect(() => watchChatTaskBatch(store, conversationId, (latest) => {
		setBatch(latest);
		setFailed(false);
	}, () => setFailed(true)), [conversationId, store]);
	if (failed) return <span role="status">{tr('无法读取任务清单', 'Could not load the task list')}</span>;
	if (!batch?.tasks.length) return null;
	const { status, completed } = taskProgress(batch.tasks);
	const heading = tr('任务清单', 'Task list');
	const label = <span aria-live="polite"><span className="scribe-working-announcement">{heading} · </span>
		{statusLabel(status)} <span className="scribe-chat-task-count">{completed}/{batch.tasks.length}</span></span>;
	return <MetricPopover label={label} icon={<TaskMark status={status} />} heading={heading} showHeading={false}>
		<ul className="scribe-chat-task-list">
			{batch.tasks.map((task) => <li key={task.id} data-status={task.status}>
				<TaskMark status={task.status} />
				<span><span className="scribe-working-announcement">{statusLabel(task.status)} · </span>
					{task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject}</span>
			</li>)}
		</ul>
	</MetricPopover>;
}
