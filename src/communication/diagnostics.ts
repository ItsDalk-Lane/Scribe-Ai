import { AsyncLocalStorage } from 'node:async_hooks';
import type { CommunicationLogEntry, ConnectionPhase } from '../types';

const MAX_ENTRIES = 100;

/** 当前任务所属对话，日志据此归档到对应文件。 */
export const logScope = new AsyncLocalStorage<string>();

export type LogSink = (scope: string | undefined, entry: CommunicationLogEntry) => void;

export class CommunicationDiagnostics {
	private entries: CommunicationLogEntry[] = [];
	private listeners = new Set<(entry: CommunicationLogEntry) => void>();
	private sink?: LogSink;

	/** 接入持久化；未接入时只保留最近的内存记录。 */
	useSink(sink: LogSink | undefined): void {
		this.sink = sink;
	}

	record(entry: CommunicationLogEntry): void {
		this.entries = [...this.entries, entry].slice(-MAX_ENTRIES);
		this.sink?.(logScope.getStore(), entry);
		for (const listener of this.listeners) listener(entry);
	}

	list(): CommunicationLogEntry[] {
		return [...this.entries];
	}

	subscribe(listener: (entry: CommunicationLogEntry) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export function connectionLog(
	requestId: string,
	phase: ConnectionPhase,
	at = Date.now(),
): CommunicationLogEntry {
	return { requestId, phase, at };
}

export const diagnostics = new CommunicationDiagnostics();
