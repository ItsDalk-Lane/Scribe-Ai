import type { CommunicationLogEntry, ConnectionPhase } from '../types';

const MAX_ENTRIES = 100;

export class CommunicationDiagnostics {
	private entries: CommunicationLogEntry[] = [];
	private listeners = new Set<(entry: CommunicationLogEntry) => void>();

	record(entry: CommunicationLogEntry): void {
		this.entries = [...this.entries, entry].slice(-MAX_ENTRIES);
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
