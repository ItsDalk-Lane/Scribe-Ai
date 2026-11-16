export interface NetworkTimeouts {
	connectMs: number;
	firstByteMs: number;
	streamIdleMs: number;
}

export const DEFAULT_TIMEOUTS: NetworkTimeouts = {
	connectMs: 15_000,
	firstByteMs: 60_000,
	streamIdleMs: 60_000,
};

export function timeoutError(kind: 'connect' | 'first-byte' | 'stream-idle', ms: number): Error {
	const labels = {
		connect: 'Connection',
		'first-byte': 'First-byte',
		'stream-idle': 'Stream idle',
	} as const;
	const error = new Error(`${labels[kind]} timeout after ${ms} ms`);
	error.name = 'TimeoutError';
	return error;
}
