import type { CommunicationLogEntry, ConnectionPhase } from '../types';

export interface NodeFetchEvent {
	requestId: string;
	method: string;
	origin: string;
	path: string;
	phase: ConnectionPhase;
	at: number;
	status?: number;
	error?: string;
	proxy?: 'direct' | 'configured' | 'environment' | 'system';
}

export type NodeFetchObserver = (event: NodeFetchEvent) => void;

export function toLogEntry(event: NodeFetchEvent): CommunicationLogEntry {
	const { error, path: _path, ...entry } = event;
	return { ...entry, ...(error !== undefined && { error: 'Network request failed' }) };
}
