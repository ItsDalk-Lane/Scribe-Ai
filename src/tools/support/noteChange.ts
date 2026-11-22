import { Buffer } from 'node:buffer';
import { win32 } from 'node:path';
import type { NoteChange } from '../../types';

const snapshotLimit = 65_536;

function fits(before: string | undefined, after: string) {
	return Buffer.byteLength(JSON.stringify([before, after])) <= snapshotLimit;
}

function notePath(path: unknown): path is string {
	return typeof path === 'string' && path.toLowerCase().endsWith('.md') && !win32.isAbsolute(path) && !path.includes('\0')
		&& path.split('/').every((part) => part && part !== '.' && part !== '..');
}

export function captureNoteChange(path: string, before: string | undefined, after: string): NoteChange | undefined {
	if (!notePath(path)) return;
	return fits(before, after) ? { path, before, after } : { path, omitted: true };
}

export function validNoteChange(value: unknown): value is NoteChange {
	if (!value || typeof value !== 'object') return false;
	const { path, before, after, omitted } = value as Record<string, unknown>;
	return notePath(path)
		&& (omitted === true ? before === undefined && after === undefined
			: omitted === undefined && typeof after === 'string' && (before === undefined || typeof before === 'string') && fits(before, after));
}
