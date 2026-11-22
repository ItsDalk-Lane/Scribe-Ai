import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import { clearTimeout, setTimeout } from 'node:timers';
import type { ShellOutputPreview } from '../../types';

const STREAM_LIMIT = 14_000;
const PREVIEW_BYTES = 512;
const PREVIEW_LINES = 3;
const PREVIEW_INTERVAL_MS = 250;

function fromUtf8Boundary(bytes: Buffer): Buffer {
	let start = 0;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return bytes.subarray(start);
}

function completeUtf8End(bytes: Buffer): number {
	for (let length = 1; length <= Math.min(3, bytes.length); length++) {
		const byte = bytes[bytes.length - length]!;
		if ((byte & 0xc0) === 0x80) continue;
		const width = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte < 0xf0 ? 3 : byte >= 0xc2 && byte < 0xe0 ? 2 : 1;
		return length < width ? bytes.length - length : bytes.length;
	}
	return bytes.length;
}

function captureStream() {
	const half = STREAM_LIMIT / 2;
	const head = Buffer.alloc(half);
	let tail = Buffer.alloc(0);
	let size = 0;
	return {
		add: (chunk: Buffer) => {
			const headSpace = Math.max(0, half - size);
			if (headSpace) chunk.copy(head, size, 0, headSpace);
			const rest = chunk.subarray(headSpace);
			if (rest.length) {
				tail = rest.length >= half
					? Buffer.from(rest.subarray(-half))
					: Buffer.concat([tail.subarray(Math.max(0, tail.length + rest.length - half)), rest]);
			}
			size += chunk.length;
		},
		text() {
			if (size <= STREAM_LIMIT) return Buffer.concat([head.subarray(0, Math.min(size, half)), tail]).toString('utf8');
			// 跳过被截断的半个 UTF-8 字符，避免在保留的文字里插入乱码。
			const beginning = new StringDecoder('utf8').write(head);
			return `${beginning}\n…（命令输出中间已截断）\n${fromUtf8Boundary(tail).toString('utf8')}`;
		},
		preview() {
			const headEnd = Math.min(size, half);
			const headStart = Math.max(0, headEnd + tail.length - PREVIEW_BYTES);
			const bytes = tail.length >= PREVIEW_BYTES ? tail.subarray(-PREVIEW_BYTES)
				: Buffer.concat([head.subarray(headStart, headEnd), tail]);
			const text = new StringDecoder('utf8').write(fromUtf8Boundary(bytes));
			return text.trimEnd().split(/\r\n?|\n/u).slice(-PREVIEW_LINES).join('\n');
		},
		readSince(cursor: number, finished: boolean) {
			const headEnd = Math.min(size, half);
			const tailStart = size - tail.length;
			const headPart = head.subarray(Math.min(cursor, headEnd), headEnd);
			const tailPart = tail.subarray(Math.max(0, cursor - tailStart));
			const skipped = tailStart - Math.max(cursor, headEnd);
			const bytes = skipped > 0 ? tailPart : Buffer.concat([headPart, tailPart]);
			// 保留尚未收齐的 UTF-8 字节，下次取得完整字符后再推进读取位置。
			const end = finished ? bytes.length : completeUtf8End(bytes);
			const current = fromUtf8Boundary(bytes.subarray(0, end)).toString('utf8');
			const text = skipped > 0
				? [new StringDecoder('utf8').write(headPart), `…（已省略 ${skipped} 字节的新增输出）`, current].filter(Boolean).join('\n')
				: current;
			return { text, cursor: size - bytes.length + end };
		},
	};
}

export type ShellOutputCursor = Record<keyof ShellOutputPreview, number>;

/** Raw process chunks for a bounded observer such as the job output ring. */
export type ShellOutputObserver = (channel: keyof ShellOutputPreview, chunk: Buffer) => void;

export function captureShellOutput(report?: (preview: ShellOutputPreview) => void) {
	const stdout = captureStream();
	const stderr = captureStream();
	const observers = new Set<ShellOutputObserver>();
	let pending: ReturnType<typeof setTimeout> | undefined;
	let last = { stdout: '', stderr: '' };
	const add = (stream: ReturnType<typeof captureStream>, channel: keyof ShellOutputPreview) => (chunk: Buffer) => {
		stream.add(chunk);
		for (const observer of observers) {
			try {
				observer(channel, chunk);
			} catch {
				observers.delete(observer);
			}
		}
		if (!report || pending) return;
		pending = setTimeout(() => {
			pending = undefined;
			const preview = { stdout: stdout.preview(), stderr: stderr.preview() };
			if (preview.stdout === last.stdout && preview.stderr === last.stderr) return;
			last = preview;
			report?.(preview);
		}, PREVIEW_INTERVAL_MS);
	};
	return {
		addStdout: add(stdout, 'stdout'),
		addStderr: add(stderr, 'stderr'),
		observe(observer: ShellOutputObserver): () => void {
			observers.add(observer);
			return () => { observers.delete(observer); };
		},
		text: () => ({ stdout: stdout.text(), stderr: stderr.text() }),
		readSince(cursor: ShellOutputCursor, finished: boolean): ShellOutputPreview {
			const normal = stdout.readSince(cursor.stdout, finished);
			const errors = stderr.readSince(cursor.stderr, finished);
			cursor.stdout = normal.cursor;
			cursor.stderr = errors.cursor;
			return { stdout: normal.text, stderr: errors.text };
		},
		stopReporting() {
			clearTimeout(pending);
			report = undefined;
		},
	};
}

export type ShellOutputCapture = ReturnType<typeof captureShellOutput>;
