import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import type { ShellStatus } from '../../types';
import { JobOutputRing, renderRingRead } from './jobOutput';
import type { ShellOutputCapture, ShellOutputCursor } from './shellOutput';

type ShellJobResult = { content: string; shellStatus: ShellStatus; exitCode?: number | null };
type Reader = 'chat' | 'model';
type CursorOwner = Reader | 'subagent';

export interface ShellExecution {
	result: Promise<ShellJobResult>;
	isRunning(): boolean;
}

export interface SavedShellJob {
	id: string;
	subagentId?: string;
	name: 'Bash' | 'PowerShell';
	/** The command line; absent on records saved before labels were kept. */
	command?: string;
	status: ShellStatus;
	content: string;
	unread?: true;
	startedAt?: number;
	finishedAt?: number;
	exitCode?: number | null;
}

export interface ShellJobHistory {
	list(conversationId: string): Promise<SavedShellJob[]>;
	save(conversationId: string, job: SavedShellJob): Promise<void>;
	markRead(conversationId: string, id: string): Promise<void>;
}

export interface ShellJobView {
	id: string;
	subagentId?: string;
	name: SavedShellJob['name'];
	command?: string;
	status: 'running' | 'stopping' | ShellStatus;
	content?: string;
	saveFailed?: true;
	startedAt?: number;
	finishedAt?: number;
	exitCode?: number | null;
}

interface ShellJob {
	owner: string;
	view: ShellJobView;
	controller: AbortController;
	output: ShellOutputCapture;
	ring: JobOutputRing;
	stopObserving: () => void;
	cursors: Record<CursorOwner, ShellOutputCursor>;
	done: Promise<void>;
	unread?: ShellStatus;
}

const MAX_RUNNING = 8;
const MAX_COMPLETED = 32;
export const SAVED_SHELL_JOB_LIMIT = 32;
export const FOREGROUND_WAIT_MS = 10_000;

export class ShellJobs {
	private readonly jobs = new Map<string, ShellJob>();
	private readonly recentResults = new Map<string, Map<string, ShellStatus | undefined>>();
	private readonly loadedResults = new Set<string>();
	private readonly savedLoads = new Map<string, Promise<SavedShellJob[]>>();
	private readonly readWrites = new Map<string, Promise<void>>();
	private readonly listeners = new Map<string | undefined, Set<() => void>>();
	private revision = 0;
	private disposed = false;

	constructor(private readonly history?: ShellJobHistory) {}

	start(
		conversationId: string, name: ShellJobView['name'], output: ShellOutputCapture,
		run: (signal: AbortSignal) => Promise<ShellJobResult>, command?: string, subagentId?: string,
	): string {
		if (this.disposed) throw new Error('插件已关闭。');
		if (!this.hasCapacity()) throw new Error('后台任务已达上限，请等待任务结束或停止不再需要的任务。');
		const controller = new AbortController();
		return this.track(conversationId, name, command, output, controller, Promise.resolve().then(() => run(controller.signal)), subagentId);
	}

	async waitInForeground(
		owner: string,
		name: ShellJobView['name'],
		output: ShellOutputCapture,
		signal: AbortSignal,
		run: (signal: AbortSignal) => ShellExecution,
		command?: string,
		timeoutMs?: number,
		subagentId?: string,
	): Promise<string | ShellJobResult> {
		signal.throwIfAborted();
		const controller = new AbortController();
		const abort = () => controller.abort(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		const ring = new JobOutputRing();
		const stopObserving = output.observe((channel, chunk) => ring.appendBytes(channel, chunk));
		let promoted = false;
		let wait: ReturnType<typeof setTimeout> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			const execution = run(controller.signal);
			const moved = new Promise<string>((resolve) => {
				wait = setTimeout(() => {
					if (signal.aborted || this.disposed || !execution.isRunning() || !this.hasCapacity()) return;
					// 移交同一个进程和输出，只解除它与前台聊天的停止联动；等待时限不再跟随。
					signal.removeEventListener('abort', abort);
					clearTimeout(deadline);
					output.stopReporting();
					const id = this.track(owner, name, command, output, controller, execution.result, subagentId, { ring, stopObserving });
					promoted = true;
					resolve(id);
				}, FOREGROUND_WAIT_MS);
			});
			if (timeoutMs !== undefined) {
				deadline = setTimeout(() => {
					if (signal.aborted || this.disposed || !execution.isRunning()) return;
					controller.abort('timed-out');
				}, timeoutMs);
			}
			return await Promise.race([execution.result, moved]);
		} finally {
			clearTimeout(wait);
			clearTimeout(deadline);
			signal.removeEventListener('abort', abort);
			if (!promoted) {
				stopObserving();
				ring.end();
				ring.dispose();
			}
		}
	}

	private hasCapacity(): boolean {
		return [...this.jobs.values()].filter(({ view }) => view.content === undefined).length < MAX_RUNNING;
	}

	private track(
		owner: string, name: ShellJobView['name'], command: string | undefined, output: ShellOutputCapture,
		controller: AbortController, result: Promise<ShellJobResult>, subagentId?: string,
		prepared?: { ring: JobOutputRing; stopObserving: () => void },
	): string {
		const id = randomUUID();
		const startedAt = Date.now();
		const ring = prepared?.ring ?? new JobOutputRing();
		const stopObserving = prepared?.stopObserving
			?? output.observe((channel, chunk) => ring.appendBytes(channel, chunk));
		if (prepared === undefined) {
			const existing = output.text();
			ring.appendText('stdout', existing.stdout);
			ring.appendText('stderr', existing.stderr);
		}
		const done = result.then(
			(result) => this.finish(id, result),
			(error: unknown) => this.finish(id, controller.signal.aborted
				? { shellStatus: 'stopped', content: '命令已停止。' }
				: { shellStatus: 'start-failed', content: `命令启动失败。\n${error instanceof Error ? error.message : String(error)}` }),
		);
		this.jobs.set(id, {
			owner, controller, output, ring, stopObserving, done,
			view: { id, name, command, status: 'running', startedAt, ...(subagentId !== undefined && { subagentId }) },
			cursors: { chat: { stdout: 0, stderr: 0 }, model: { stdout: 0, stderr: 0 }, subagent: { stdout: 0, stderr: 0 } },
		});
		this.notify(owner);
		return id;
	}

	private async finish(id: string, result: ShellJobResult) {
		const job = this.jobs.get(id);
		if (!job) return;
		job.stopObserving();
		job.ring.end();
		const { subagentId } = job.view;
		job.ring.trimSettled(job.cursors[subagentId === undefined ? 'model' : 'subagent']);
		const saved: SavedShellJob = {
			id, name: job.view.name, command: job.view.command, status: result.shellStatus, content: result.content,
			startedAt: job.view.startedAt, finishedAt: Date.now(), exitCode: result.exitCode,
			...(subagentId !== undefined && { subagentId }),
		};
		try {
			if (this.history) await this.history.save(job.owner, { ...saved, unread: true });
			job.view = saved;
		} catch {
			job.view = { ...saved, saveFailed: true };
		}
		if (this.disposed || this.jobs.get(id) !== job) return;
		if (this.history && !job.view.saveFailed) {
			const recent = this.recentResults.get(job.owner) ?? new Map<string, ShellStatus | undefined>();
			recent.set(id, result.shellStatus);
			if (recent.size > SAVED_SHELL_JOB_LIMIT) recent.delete(recent.keys().next().value!);
			this.recentResults.set(job.owner, recent);
			this.savedLoads.delete(job.owner);
		} else {
			job.unread = result.shellStatus;
		}
		this.jobs.delete(id);
		this.jobs.set(id, job);
		const completed = [...this.jobs.values()].filter(({ view }) => view.content !== undefined);
		if (completed.length > MAX_COMPLETED) {
			const oldest = completed[0]!;
			this.jobs.delete(oldest.view.id);
			oldest.ring.dispose();
			if (oldest.owner !== job.owner) this.notify(oldest.owner);
		}
		this.notify(job.owner);
	}

	private owned(conversationId: string, id: string, subagentId?: string): ShellJob | undefined {
		const job = this.jobs.get(id.toLowerCase());
		return job?.owner === conversationId && (subagentId === undefined || job.view.subagentId === subagentId) ? job : undefined;
	}

	get(conversationId: string, id: string, subagentId?: string) {
		return this.owned(conversationId, id, subagentId)?.view;
	}

	/** Complete-output spill paths retained for one live job. */
	outputPaths(conversationId: string, id: string, subagentId?: string): string[] {
		return this.owned(conversationId, id, subagentId)?.ring.paths() ?? [];
	}

	async getSaved(conversationId: string, id: string, subagentId?: string) {
		return (await this.listSaved(conversationId)).find((job) => job.id === id.toLowerCase()
			&& (subagentId === undefined || job.subagentId === subagentId));
	}

	async listSaved(conversationId: string): Promise<SavedShellJob[]> {
		if (!this.history || this.disposed) return [];
		const pending = this.savedLoads.get(conversationId);
		if (pending) return pending;
		const load = this.history.list(conversationId).then((jobs) => {
			// 读盘期间若有新的完成结果或已读操作，以更新后的状态为准。
			if (this.savedLoads.get(conversationId) !== load) return jobs;
			const previous = this.recentResults.get(conversationId);
			const firstLoad = !this.loadedResults.has(conversationId);
			const recent = new Map(jobs.map(({ id, status, unread }) => [id, unread ? status : undefined]));
			this.loadedResults.add(conversationId);
			if (recent.size) this.recentResults.set(conversationId, recent);
			else this.recentResults.delete(conversationId);
			if (firstLoad || [...recent].some(([id, status]) => status && previous?.get(id) !== status)
				|| [...(previous ?? [])].some(([id, status]) => status && recent.get(id) !== status)) {
				this.notify(conversationId);
			}
			return jobs;
		}).finally(() => {
			if (this.savedLoads.get(conversationId) === load) this.savedLoads.delete(conversationId);
		});
		this.savedLoads.set(conversationId, load);
		return load;
	}

	list(conversationId: string): ShellJobView[] {
		return [...this.jobs.values()].filter(({ owner }) => owner === conversationId).map(({ view }) => view);
	}

	listUnread(conversationId: string): Pick<SavedShellJob, 'id' | 'status'>[] {
		const recent = this.recentResults.get(conversationId);
		const saved = [...(recent ?? [])].flatMap(([id, status]) => status ? [{ id, status }] : []);
		const unsaved = [...this.jobs.values()].flatMap(({ owner, view, unread }) =>
			owner === conversationId && unread ? [{ id: view.id, status: unread }] : []);
		return saved.concat(unsaved);
	}

	hasUnread(conversationId: string): boolean | undefined {
		const recent = this.recentResults.get(conversationId);
		if ([...(recent?.values() ?? [])].some(Boolean)) return true;
		for (const job of this.jobs.values()) {
			if (job.owner === conversationId && job.unread) return true;
		}
		// 未加载完整结果的聊天仍使用历史列表中的已保存状态。
		return this.loadedResults.has(conversationId) ? false : undefined;
	}

	async markRead(conversationId: string, id: string) {
		if (this.disposed) return;
		const key = id.toLowerCase();
		const job = this.owned(conversationId, key);
		if (job?.unread) {
			delete job.unread;
			this.notify(conversationId);
			return;
		}
		if (!this.history || !this.recentResults.get(conversationId)?.get(key)) return;
		const writeKey = `${conversationId}:${key}`;
		const pending = this.readWrites.get(writeKey);
		if (pending) return pending;
		const write = this.history.markRead(conversationId, key).then(() => {
			this.savedLoads.delete(conversationId);
			const recent = this.recentResults.get(conversationId);
			if (recent?.has(key)) recent.set(key, undefined);
			this.notify(conversationId);
		}).finally(() => this.readWrites.delete(writeKey));
		this.readWrites.set(writeKey, write);
		return write;
	}

	subscribe(conversationId: string | undefined, listener: () => void): () => void {
		const owner = conversationId;
		const listeners = this.listeners.get(owner) ?? new Set<() => void>();
		this.listeners.set(owner, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (!listeners.size) this.listeners.delete(owner);
		};
	}

	subscribeAll = (listener: () => void) => this.subscribe(undefined, listener);

	getRevision = () => this.revision;

	private notify(owner: string) {
		this.revision++;
		for (const key of [owner, undefined]) {
			const listeners = this.listeners.get(key);
			for (const listener of listeners ?? []) {
				try {
					listener();
				} catch {
					listeners?.delete(listener);
				}
			}
		}
	}

	read(conversationId: string, id: string, reader: Reader = 'chat', subagentId?: string) {
		const job = this.owned(conversationId, id, subagentId);
		if (!job) return;
		// 主聊天查看子 Agent 的后台输出时，保留子 Agent 自己的读取进度。
		const cursor = reader === 'model' && subagentId !== undefined ? 'subagent' : reader;
		const read = job.ring.readFrom(job.cursors[cursor]);
		job.cursors[cursor] = { stdout: read.stdout.next, stderr: read.stderr.next };
		const preview = {
			stdout: renderRingRead(read.stdout),
			stderr: renderRingRead(read.stderr),
		};
		if (cursor === (job.view.subagentId === undefined ? 'model' : 'subagent') && job.view.content !== undefined) {
			job.ring.trimSettled(job.cursors[cursor]);
		}
		return preview;
	}

	/** Full retained output without advancing either reader's cursor. */
	outputSnapshot(conversationId: string, id: string): string | undefined {
		const job = this.owned(conversationId, id);
		if (!job) return;
		const { stdout, stderr } = job.ring.text();
		return [stdout, stderr && `错误输出\n${stderr}`].filter(Boolean).join('\n');
	}

	async stop(conversationId: string, id: string, subagentId?: string): Promise<ShellJobView | undefined> {
		const job = this.owned(conversationId, id, subagentId);
		if (!job) return;
		if (job.view.status === 'running') {
			job.view = { ...job.view, status: 'stopping' };
			job.controller.abort();
			this.notify(job.owner);
		}
		await job.done;
		return job.view;
	}

	async stopConversation(conversationId: string) {
		await Promise.all(this.list(conversationId).map(({ id }) => this.stop(conversationId, id)));
	}

	async stopSubagents(conversationId: string, ids: ReadonlySet<string>) {
		await Promise.all(this.list(conversationId).flatMap(({ id, subagentId }) =>
			subagentId !== undefined && ids.has(subagentId) ? [this.stop(conversationId, id, subagentId)] : []));
	}

	forgetConversation(conversationId: string) {
		for (const job of this.jobs.values()) {
			if (job.owner !== conversationId) continue;
			job.stopObserving();
			job.ring.dispose();
			this.jobs.delete(job.view.id);
		}
		this.recentResults.delete(conversationId);
		this.loadedResults.delete(conversationId);
		this.savedLoads.delete(conversationId);
		this.notify(conversationId);
	}

	async dispose() {
		this.disposed = true;
		this.listeners.clear();
		this.savedLoads.clear();
		const jobs = [...this.jobs.values()];
		for (const { view, controller } of jobs) if (view.content === undefined) controller.abort();
		await Promise.allSettled([...jobs.map(({ done }) => done), ...this.readWrites.values()]);
		for (const { ring } of jobs) ring.dispose();
		this.jobs.clear();
		this.recentResults.clear();
		this.loadedResults.clear();
	}
}
