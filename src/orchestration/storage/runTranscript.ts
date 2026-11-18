import { taskMessage } from '../context/contextBuilder';
import { updateTaskState } from '../taskManager';
import { latestIncompleteReply, newContinuationText } from '../../runtime/continuationText';
import type {
	ConversationEntry, ConversationStore, Message, RunCheckpoint, RunObserver, RunState, RunStep, SavedRun, Task, TerminalRunStatus,
} from '../../types';

function finalStatus(state: RunState): TerminalRunStatus {
	const { status } = state;
	return status === 'idle' || status === 'running' || status === 'awaiting-approval' ? 'failed' : status;
}

export function trackRun(store: ConversationStore, task: Task, observer: RunObserver, restored?: SavedRun) {
	const taskId = task.id;
	const conversationId = task.request.conversationId;
	let step: RunStep = restored?.step ?? { phase: 'starting', turn: 0 };
	let savedMessages = restored?.state.messages.length ?? 0;
	let partial = '';
	let failure: Error | undefined;

	async function append(entries: ConversationEntry[]) {
		if (failure) throw failure;
		if (!entries.length) return;
		try {
			await store.append(conversationId, entries);
		} catch (error) {
			failure = Object.assign(new Error('无法保存对话或操作进度。'), { cause: error });
			throw failure;
		}
	}

	async function record(event: RunCheckpoint) {
		const entries: ConversationEntry[] = [];
		const previous = step;
		switch (event.type) {
			case 'turn-start':
				step = { phase: 'model', turn: event.turn };
				partial = '';
				break;
			case 'tool-start':
				step = { phase: 'tool', turn: step.turn, call: { id: event.call.id, name: event.call.name } };
				break;
			case 'state': {
				const { state } = event;
				const messages = state.messages.slice(savedMessages);
				if (messages.some((message) => message.role === 'assistant')) partial = '';
				if (state.status === 'awaiting-approval' && step.phase !== 'approval') step = { ...step, phase: 'approval' };
				if (state.status === 'running' && messages.some((message) => message.role === 'tool')) {
					step = { ...step, phase: 'tool-result' };
				}
				if (messages.length) entries.push({ type: 'messages', taskId, messages, step: step === previous ? undefined : step });
				else if (step !== previous) entries.push({ type: 'step', taskId, step });
				await append(entries);
				savedMessages = Math.max(savedMessages, state.messages.length);
				return;
			}
		}
		if (step !== previous) entries.push({ type: 'step', taskId, step });
		await append(entries);
	}

	const observed: RunObserver = {
		retryConnection: observer.retryConnection,
		onEvent(event) {
			if (event.type === 'text-delta') partial += event.text;
			if (event.type === 'model-retry') partial = '';
			if (event.type === 'state') updateTaskState(task, event.state);
			observer.onEvent?.(event);
		},
	};
	if (observer.approve) {
		const choose = observer.approve;
		observed.approve = async (preview, signal) => {
			const approved = await choose(preview, signal);
			if (!approved || signal.aborted) return false;
			step = { ...step, phase: 'tool' };
			await append([{ type: 'step', taskId, step }]);
			return !signal.aborted;
		};
	}

	return {
		record, observed,
		async start(model: Extract<ConversationEntry, { type: 'start' }>['model']) {
			await append([
				{ type: 'start', task, model },
				{ type: 'messages', taskId, messages: [taskMessage(task.request)] },
			]);
			savedMessages = 1;
		},
		async finish(state: RunState): Promise<RunState> {
			const previous = latestIncompleteReply(state.messages);
			const remaining = previous ? newContinuationText(previous, partial) : partial;
			const entries: ConversationEntry[] = [];
			const draft: Message | undefined = remaining ? { role: 'assistant', content: remaining, incomplete: true } : undefined;
			if (draft) entries.push({ type: 'messages', taskId, messages: [draft] });
			if (state.status !== 'interrupted') entries.push({
				type: 'finish', taskId, status: finalStatus(state), turn: state.turn, error: state.error, resumed: state.resumed,
			});
			await append(entries);
			return draft ? { ...state, messages: [...state.messages, draft] } : state;
		},
	};
}
