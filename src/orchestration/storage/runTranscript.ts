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

type DraftThinking = NonNullable<Message['thinkingBlocks']>[number] & { started: number };
type DraftBlock = { type: 'text'; contentIndex: number; text: string } | DraftThinking;

function savedThinking({ started, durationMs, ...block }: DraftThinking) {
	return { ...block, durationMs: durationMs ?? Math.round(performance.now() - started) };
}

function visibleThinking(blocks: Iterable<DraftBlock>, completedOnly = false): NonNullable<Message['thinkingBlocks']> {
	return Array.from(blocks).flatMap((block) => block.type === 'thinking' && block.thinking.trim()
		&& (!completedOnly || block.durationMs !== undefined) ? [savedThinking(block)] : []);
}

export function trackRun(store: Pick<ConversationStore, 'append'> | undefined, task: Task, observer: RunObserver, restored?: SavedRun) {
	const taskId = task.id;
	const conversationId = task.request.conversationId;
	let step: RunStep = restored?.step ?? { phase: 'starting', turn: 0 };
	let savedMessages = restored?.state.messages.length ?? 0;
	let canCheckpointThinking = false;
	let draft: { id: string; blocks: Map<string, DraftBlock> } | undefined;
	let checkpoints = Promise.resolve();
	let failure: Error | undefined;

	async function append(entries: ConversationEntry[]) {
		if (failure) throw failure;
		if (!entries.length) return;
		try {
			await store?.append(conversationId, entries);
		} catch (error) {
			failure = Object.assign(new Error('无法保存对话或操作进度。'), { cause: error });
			throw failure;
		}
	}

	async function record(event: RunCheckpoint) {
		await checkpoints;
		const entries: ConversationEntry[] = [];
		const previous = step;
		switch (event.type) {
			case 'turn-start':
				step = { phase: 'model', turn: event.turn };
				draft = undefined;
				// 续做时，这个检查点在发送确认之后才会写入。
				canCheckpointThinking = true;
				break;
			case 'tool-start':
				step = { phase: 'tool', turn: step.turn, call: { id: event.call.id, name: event.call.name } };
				break;
			case 'state': {
				const { state } = event;
				const messages = state.messages.slice(savedMessages);
				if (messages.some((message) => message.role === 'assistant')) draft = undefined;
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
			if (event.type === 'model-retry') {
				if (canCheckpointThinking) {
					const blocks = draft?.id === event.messageId ? Array.from(draft.blocks.values(), (block) =>
						block.type === 'text' ? { ...block } : savedThinking(block)) : undefined;
					const retry = { beforeMessage: savedMessages, event, blocks };
					checkpoints = checkpoints.then(() => append([{ type: 'retry', taskId, retry }])).catch(() => {});
				}
				draft = undefined;
			}
			if (event.type === 'text-delta' || event.type === 'thinking-delta' || event.type === 'thinking-end') {
				const { messageId, contentIndex } = event;
				if (draft?.id !== messageId) draft = { id: messageId, blocks: new Map() };
				const key = `${event.type === 'text-delta' ? 'text' : 'thinking'}:${contentIndex}`;
				const block = draft.blocks.get(key);
				if (event.type === 'text-delta' && event.text) {
					if (block?.type === 'text') block.text += event.text;
					else draft.blocks.set(key, { type: 'text', text: event.text, contentIndex });
				} else if (event.type === 'thinking-delta' && event.text) {
					if (block?.type === 'thinking') block.thinking += event.text;
					else draft.blocks.set(key, { type: 'thinking', thinking: event.text, contentIndex, started: performance.now() });
				} else if (event.type === 'thinking-end' && block?.type === 'thinking') {
					block.durationMs = event.durationMs;
					const thinkingBlocks = visibleThinking(draft.blocks.values(), true);
					if (canCheckpointThinking && thinkingBlocks.length) {
						const message: Message = { role: 'assistant', id: messageId, content: '', incomplete: true, thinkingBlocks };
						// 按顺序保存，写入失败由下一次正式保存统一报告。
						checkpoints = checkpoints.then(() => append([{ type: 'messages', taskId, messages: [message] }])).catch(() => {});
					}
				}
			}
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
			const finishedAt = Date.now();
			await checkpoints;
			const previous = latestIncompleteReply(state.messages);
			const text = Array.from(draft?.blocks.values() ?? []).filter((block) => block.type === 'text');
			const partial = text.map((block) => block.text).join('');
			const remaining = previous ? newContinuationText(previous, partial) : partial;
			const thinkingBlocks = visibleThinking(draft?.blocks.values() ?? []);
			const entries: ConversationEntry[] = [];
			const message: Message | undefined = draft && (remaining || thinkingBlocks.length) ? {
				role: 'assistant', id: draft.id, content: remaining, incomplete: true,
				...(text[0]?.contentIndex ? { textIndex: text[0].contentIndex } : {}),
				...(thinkingBlocks.length ? { thinkingBlocks } : {}),
			} : undefined;
			if (message) entries.push({ type: 'messages', taskId, messages: [message] });
			if (state.status !== 'interrupted') entries.push({
				type: 'finish', taskId, status: finalStatus(state), turn: state.turn, error: state.error, resumed: state.resumed, finishedAt,
			});
			await append(entries);
			return { ...state, createdAt: state.createdAt ?? task.createdAt, finishedAt,
				messages: message ? [...state.messages, message] : state.messages };
		},
	};
}
