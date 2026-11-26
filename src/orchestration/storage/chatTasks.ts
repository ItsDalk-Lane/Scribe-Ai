import { randomUUID } from 'node:crypto';
import type { ConversationEntry, TaskRequest } from '../../types';

export interface ChatTask {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	owner?: string;
	runId?: string;
	planRunId?: string;
	status: 'pending' | 'in_progress' | 'completed' | 'stopped';
	blockedBy: string[];
	blocks: string[];
}

export interface ChatTaskBatch { id: number; tasks: ChatTask[] }
export interface ChatTaskActor { owner: string; runId: string; planRunId?: string }
export type ChatTaskCreate = Pick<ChatTask, 'subject' | 'description' | 'activeForm'> & Partial<Pick<ChatTask, 'blocks' | 'blockedBy'>>;
export type ChatTaskUpdate = Partial<Pick<ChatTask, 'subject' | 'description' | 'activeForm'>> & {
	id: string;
	status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
	addBlocks?: string[];
	addBlockedBy?: string[];
};

export interface ChatTaskStore {
	list(id: string): Promise<ChatTaskBatch[]>;
	get(id: string, itemId: string): Promise<ChatTask>;
	create(id: string, actor: ChatTaskActor, input: ChatTaskCreate): Promise<ChatTask>;
	update(id: string, actor: ChatTaskActor, input: ChatTaskUpdate): Promise<ChatTask>;
	release(id: string, runId: string): Promise<void>;
	approvePlan(id: string, planRunId: string): Promise<void>;
	subscribe(id: string, listener: () => void): () => void;
}

export interface ChatTaskEvent {
	type: 'chat-tasks';
	batchId: number;
	writer: string;
	tasks: ChatTask[];
	removed?: string;
}

const instance = randomUUID();
const itemId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value));
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(itemId) && new Set(value).size === value.length;
const str = (value: unknown, limit: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;

function validTask(value: unknown): value is ChatTask {
	if (!value || typeof value !== 'object') return false;
	const t = value as Partial<ChatTask>;
	return itemId(t.id) && str(t.subject, 300) && typeof t.description === 'string' && t.description.length <= 16000
		&& (t.activeForm === undefined || str(t.activeForm, 300)) && (t.planRunId === undefined || str(t.planRunId, 256))
		&& (t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed' || t.status === 'stopped')
		&& (t.status === 'in_progress' ? str(t.owner, 256) && str(t.runId, 256) : t.owner === undefined && t.runId === undefined)
		&& (!t.planRunId || t.status === 'pending') && ids(t.blockedBy) && ids(t.blocks);
}

export function isChatTaskEvent(value: unknown): value is ChatTaskEvent {
	if (!value || typeof value !== 'object') return false;
	const e = value as Partial<ChatTaskEvent>;
	return e.type === 'chat-tasks' && typeof e.batchId === 'number' && Number.isSafeInteger(e.batchId) && e.batchId > 0
		&& str(e.writer, 256) && Array.isArray(e.tasks) && e.tasks.every(validTask)
		&& (e.removed === undefined || itemId(e.removed));
}

type Run = { owner: string; request: Pick<TaskRequest, 'intent' | 'revisesPlanTaskId' | 'approvedPlanTaskId'>; finished: boolean; readOnly: boolean };

export class ChatTaskBoard {
	readonly batches: ChatTaskBatch[] = [];
	readonly writer: string;
	private readonly runs = new Map<string, Run>();
	private readonly readers = new Set<string>();
	private latestRoot?: string;
	private highestId = 0;

	constructor(private readonly conversationId: string) { this.writer = `${instance}/${conversationId.toLowerCase()}`; }

	copy() {
		const board = new ChatTaskBoard(this.conversationId);
		board.batches.push(...structuredClone(this.batches));
		for (const [id, run] of this.runs) board.runs.set(id, { ...run });
		for (const reader of this.readers) board.readers.add(reader);
		board.latestRoot = this.latestRoot;
		board.highestId = this.highestId;
		return board;
	}

	observe(entry: ConversationEntry) {
		if (entry.type === 'chat-tasks') {
			let batch = this.batches.find(({ id }) => id === entry.batchId);
			if (!batch) { batch = { id: entry.batchId, tasks: [] }; this.batches.push(batch); }
			if (entry.removed) batch.tasks = batch.tasks.filter(({ id }) => id !== entry.removed);
			for (const saved of entry.tasks) {
				this.highestId = Math.max(this.highestId, Number(saved.id));
				const item = { ...saved };
				// 新进程或聊天分支没有原执行者，保留停下的位置并允许再次认领。
				if (item.status === 'in_progress' && entry.writer !== this.writer) this.stop(item);
				const pos = batch.tasks.findIndex(({ id }) => id === item.id);
				if (pos === -1) batch.tasks.push(item);
				else batch.tasks[pos] = item;
			}
			return;
		}
		if (entry.type === 'subagent' && entry.record.kind === 'create' && entry.record.readOnly) this.readers.add(entry.agentId);
		const owner = entry.type === 'subagent' ? entry.agentId : 'root';
		const run = entry.type === 'subagent' && entry.record.kind === 'run' ? entry.record.entry : entry;
		if (run.type === 'start') {
			const { intent, revisesPlanTaskId, approvedPlanTaskId } = run.task.request;
			const request = { intent, revisesPlanTaskId, approvedPlanTaskId };
			if (request.revisesPlanTaskId && (owner !== 'root' || request.intent !== 'plan' || request.revisesPlanTaskId !== this.latestRoot
				|| this.runs.get(request.revisesPlanTaskId)?.request.intent !== 'plan')) {
				throw new Error('计划修订必须关联上一轮计划。');
			}
			if (request.approvedPlanTaskId && (owner !== 'root' || request.intent || request.approvedPlanTaskId !== this.latestRoot
				|| this.runs.get(request.approvedPlanTaskId)?.request.intent !== 'plan')) {
				throw new Error('执行确认必须关联上一轮计划。');
			}
			if (owner === 'root') this.latestRoot = run.task.id;
			this.runs.set(run.task.id, { owner, request, finished: false, readOnly: this.readers.has(owner) });
		}
		if (run.type === 'finish') {
			const existing = this.runs.get(run.taskId);
			if (existing) existing.finished = true;
		}
	}

	private planChain(id: string) {
		const chain = new Set<string>();
		let next: string | undefined = id;
		while (next && !chain.has(next)) {
			const run: Run | undefined = this.runs.get(next);
			if (run?.request.intent !== 'plan' || run.owner !== 'root') throw new Error('找不到当前对话的计划。');
			chain.add(next);
			next = run.request.revisesPlanTaskId;
		}
		return chain;
	}

	private checkActor(actor: ChatTaskActor) {
		const run = this.runs.get(actor.runId);
		if (!run || run.owner !== actor.owner || run.finished || run.readOnly || run.request.intent === 'review'
			|| (run.request.intent === 'plan' ? actor.planRunId !== actor.runId : actor.planRunId !== undefined)) {
			throw new Error('当前任务无权修改这个聊天的任务清单。');
		}
	}

	get(id: string) {
		for (const batch of this.batches) {
			const item = batch.tasks.find((task) => task.id === id);
			if (item) return { batch, item };
		}
		throw new Error(`找不到清单任务 #${id}。`);
	}

	private editable(task: ChatTask, actor: ChatTaskActor) {
		if (actor.planRunId ? !task.planRunId || !this.planChain(actor.planRunId).has(task.planRunId) : task.planRunId) {
			throw new Error('此操作超出当前计划草案，执行计划前需要用户确认。');
		}
		if (task.status === 'in_progress' && (task.owner !== actor.owner || task.runId !== actor.runId)) {
			throw new Error('该任务已由其他执行者认领。');
		}
	}

	private stop(task: ChatTask) {
		task.status = 'stopped';
		delete task.owner;
		delete task.runId;
	}

	create(actor: ChatTaskActor, input: ChatTaskCreate) {
		this.checkActor(actor);
		let batch = this.batches.at(-1);
		const draft = batch?.tasks.find((task) => task.planRunId)?.planRunId;
		const samePlan = actor.planRunId ? Boolean(draft && this.planChain(actor.planRunId).has(draft)) : !draft;
		if (!batch || !samePlan || batch.tasks.every((task) => task.status === 'completed')) {
			batch = { id: (batch?.id ?? 0) + 1, tasks: [] };
			this.batches.push(batch);
		}
		const task: ChatTask = { id: String(++this.highestId), subject: input.subject, description: input.description,
			...(input.activeForm !== undefined && { activeForm: input.activeForm }), ...(actor.planRunId && { planRunId: actor.planRunId }),
			status: 'pending', blocks: [], blockedBy: [] };
		batch.tasks.push(task);
		const changed = new Set([task]);
		this.link(batch, task, actor, input.blocks ?? [], input.blockedBy ?? [], changed);
		return { item: task, event: this.event(batch, changed) };
	}

	update(actor: ChatTaskActor, input: ChatTaskUpdate) {
		this.checkActor(actor);
		const { item, batch } = this.get(input.id);
		this.editable(item, actor);
		if (actor.planRunId && input.status && input.status !== 'pending' && input.status !== 'deleted') {
			throw new Error('计划模式只能整理待办，执行需要用户确认。');
		}
		const changed = new Set<ChatTask>();
		if (input.status === 'deleted') {
			if (item.status === 'in_progress') throw new Error('删除前需先释放正在执行的任务。');
			for (const other of batch.tasks) {
				if (!other.blocks.includes(item.id) && !other.blockedBy.includes(item.id)) continue;
				this.editable(other, actor);
				other.blocks = other.blocks.filter((id) => id !== item.id);
				other.blockedBy = other.blockedBy.filter((id) => id !== item.id);
				changed.add(other);
			}
			return { item, event: { ...this.event(batch, changed), removed: item.id } };
		}
		for (const key of ['subject', 'description', 'activeForm'] as const) {
			if (input[key] !== undefined) item[key] = input[key];
		}
		changed.add(item);
		this.link(batch, item, actor, input.addBlocks ?? [], input.addBlockedBy ?? [], changed);
		if (input.status && input.status !== item.status) {
			if (item.status === 'completed') throw new Error('已完成任务不可重新执行。');
			if (input.status === 'in_progress' || input.status === 'completed') {
				if (item.blockedBy.some((id) => this.get(id).item.status !== 'completed')) throw new Error('依赖任务尚未完成。');
				if (input.status === 'completed' && item.status !== 'in_progress') throw new Error('请先认领并执行任务，再标记完成。');
			}
			if (input.status === 'in_progress' && this.batches.some((group) => group.tasks.some((task) =>
				task.id !== item.id && task.status === 'in_progress' && task.owner === actor.owner))) {
				throw new Error('该执行者已有进行中的任务。');
			}
			item.status = input.status;
			if (input.status === 'in_progress') Object.assign(item, { owner: actor.owner, runId: actor.runId });
			else { delete item.owner; delete item.runId; }
		}
		return { item, event: this.event(batch, changed) };
	}

	private link(batch: ChatTaskBatch, item: ChatTask, actor: ChatTaskActor, blocks: string[], blockedBy: string[], changed: Set<ChatTask>) {
		for (const [direction, values] of [['blocks', blocks], ['blockedBy', blockedBy]] as const) {
			if (!ids(values)) throw new Error('任务依赖编号无效。');
			for (const id of values) {
				const other = batch.tasks.find((task) => task.id === id);
				if (!other) throw new Error('依赖需要属于同一批任务。');
				if (item[direction].includes(id)) continue;
				this.editable(other, actor);
				const [from, to] = direction === 'blocks' ? [item, other] : [other, item];
				if ((to.status === 'in_progress' || to.status === 'completed') && from.status !== 'completed') {
					throw new Error('进行中或已完成的任务不能增加未完成依赖。');
				}
				const visited = new Set<string>();
				const pending = [to.id];
				while (pending.length) {
					const next = pending.pop()!;
					if (next === from.id) throw new Error('任务依赖不能形成循环。');
					if (visited.has(next)) continue;
					visited.add(next);
					pending.push(...this.get(next).item.blocks);
				}
				from.blocks.push(to.id);
				to.blockedBy.push(from.id);
				changed.add(other);
			}
		}
	}

	release(runId: string) {
		return this.batches.flatMap((batch) => {
			const items = batch.tasks.filter((task) => task.status === 'in_progress' && task.runId === runId);
			for (const task of items) this.stop(task);
			return items.length ? [this.event(batch, items)] : [];
		});
	}

	approve(planId: string) {
		const execution = this.latestRoot && this.runs.get(this.latestRoot);
		if (!execution || execution.finished || execution.request.approvedPlanTaskId !== planId) {
			throw new Error('当前任务缺少该计划的执行确认。');
		}
		const chain = this.planChain(planId);
		return this.batches.flatMap((batch) => {
			const items = batch.tasks.filter((task) => task.planRunId && chain.has(task.planRunId));
			for (const task of items) delete task.planRunId;
			return items.length ? [this.event(batch, items)] : [];
		});
	}

	private event(batch: ChatTaskBatch, tasks: Iterable<ChatTask>): ChatTaskEvent {
		const result: ChatTaskEvent = { type: 'chat-tasks', batchId: batch.id, writer: this.writer, tasks: [...tasks] };
		if (!isChatTaskEvent(result)) throw new Error('清单任务内容或依赖格式无效。');
		return result;
	}
}
