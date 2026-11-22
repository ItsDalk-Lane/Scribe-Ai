import { Buffer } from 'node:buffer';
import { chmodSync, closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ShellOutputCursor } from './shellOutput';

type Channel = keyof ShellOutputCursor;

/** Live retention per job, shared by stdout and stderr. */
const LIVE_JOB_BYTES = 262_144;
/** Settled retention per job, shared by stdout and stderr. */
const SETTLED_JOB_BYTES = 16_384;
/** DSH executor memory cap per stream; a full spill starts once this is exceeded. */
const SPILL_TRIGGER_BYTES = 64_000;
/** Complete spill file cap per stream, matching the DSH executor. */
const SPILL_STREAM_BYTES = 67_108_864;
const GAP = '…（较早的输出已丢弃）\n';

interface RingChunk {
	at: number;
	text: string;
	bytes: number;
}

export interface RingRead {
	text: string;
	next: number;
	lossy: boolean;
	dropped: number;
}

/** UTF-8-safe text after `skipBytes`, never starting inside a code point. */
function textAfter(text: string, skipBytes: number): string {
	const raw = Buffer.from(text, 'utf8');
	let start = Math.min(Math.max(0, skipBytes), raw.length);
	while (start < raw.length && (raw[start]! & 0xc0) === 0x80) start += 1;
	return raw.subarray(start).toString('utf8');
}

/** Whole chunks with absolute offsets, head eviction, and a byte-bounded read. */
class StreamRing {
	private readonly chunks: RingChunk[] = [];
	private readonly decoder = new StringDecoder('utf8');
	private retained = 0;
	private total = 0;
	private earliest = 0;

	appendBytes(buffer: Buffer): void {
		const text = this.decoder.write(buffer);
		if (text) this.append(text);
	}

	appendText(text: string): void {
		this.append(text);
	}

	retainedBytes(): number {
		return this.retained;
	}

	totalBytes(): number {
		return this.total;
	}

	end(): void {
		const text = this.decoder.end();
		if (text) this.append(text);
	}

	readFrom(from: number): RingRead {
		const lossy = from < this.earliest;
		const start = lossy ? this.earliest : from;
		let text = '';
		for (const chunk of this.chunks) {
			if (chunk.at + chunk.bytes <= start) continue;
			text += chunk.at < start ? textAfter(chunk.text, start - chunk.at) : chunk.text;
		}
		return {
			text,
			next: this.total,
			lossy,
			dropped: lossy ? this.earliest - from : 0,
		};
	}

	text(): string {
		const body = this.chunks.map(({ text }) => text).join('');
		return this.earliest > 0 ? `${GAP}${body}` : body;
	}

	trim(cap: number, preserveFrom?: number): void {
		const keep = preserveFrom === undefined
			? cap
			: Math.max(cap, this.total - Math.max(0, preserveFrom));
		while (this.retained > keep && this.chunks.length > 1) {
			const dropped = this.chunks.shift();
			/* v8 ignore next -- the length guard proves shift() returns a chunk; this check only satisfies noUncheckedIndexedAccess. */
			if (dropped === undefined) break;
			this.retained -= dropped.bytes;
		}
		const single = this.chunks.length === 1 ? this.chunks[0] : undefined;
		if (single !== undefined && single.bytes > keep) {
			const raw = Buffer.from(single.text, 'utf8');
			let start = raw.length - keep;
			while (start < raw.length && (raw[start]! & 0xc0) === 0x80) start += 1;
			single.at += start;
			single.text = raw.subarray(start).toString('utf8');
			single.bytes = raw.length - start;
			this.retained = single.bytes;
		}
		this.earliest = this.chunks[0]?.at ?? this.total;
	}

	private append(text: string): void {
		const bytes = Buffer.byteLength(text, 'utf8');
		if (bytes === 0) return;
		this.chunks.push({ at: this.total, text, bytes });
		this.total += bytes;
		this.retained += bytes;
		this.trim(LIVE_JOB_BYTES);
	}
}

interface SpillFile {
	path: string | undefined;
	fd: number | undefined;
	pending: Buffer[];
	pendingBytes: number;
	written: number;
	broken: boolean;
}

/** Private per-job files holding the complete stream until the DSH 64 MiB cap. */
class JobSpill {
	private directory: string | undefined;
	private readonly files: Record<Channel, SpillFile> = {
		stdout: { path: undefined, fd: undefined, pending: [], pendingBytes: 0, written: 0, broken: false },
		stderr: { path: undefined, fd: undefined, pending: [], pendingBytes: 0, written: 0, broken: false },
	};

	write(channel: Channel, buffer: Buffer): void {
		const file = this.files[channel];
		if (file.broken || buffer.length === 0) return;
		if (file.written + file.pendingBytes + buffer.length > SPILL_STREAM_BYTES) {
			this.breakFile(channel);
			return;
		}
		if (file.fd === undefined) {
			file.pending.push(buffer);
			file.pendingBytes += buffer.length;
			if (file.pendingBytes <= SPILL_TRIGGER_BYTES) return;
			try {
				this.ensureDirectory();
				file.path = join(this.directory!, `${channel}.log`);
				file.fd = openSync(file.path, 'wx', 0o600);
				for (const pending of file.pending) writeSync(file.fd, pending);
				file.written = file.pendingBytes;
				file.pending = [];
				file.pendingBytes = 0;
			} catch {
				this.breakFile(channel);
			}
			return;
		}
		try {
			writeSync(file.fd, buffer);
			file.written += buffer.length;
		} catch {
			this.breakFile(channel);
		}
	}

	close(): void {
		for (const file of Object.values(this.files)) {
			if (file.fd !== undefined) closeSync(file.fd);
			file.fd = undefined;
			file.pending = [];
			file.pendingBytes = 0;
		}
	}

	/** Release handles only; the age-based startup sweep owns removal. */
	dispose(): void {
		this.close();
	}

	paths(): string[] {
		return [this.files.stdout.path, this.files.stderr.path].filter((path): path is string => path !== undefined);
	}

	private ensureDirectory(): void {
		if (this.directory !== undefined) return;
		this.directory = mkdtempSync(join(tmpdir(), 'scribe-ai-shell-'));
		chmodSync(this.directory, 0o700);
	}

	private breakFile(channel: Channel): void {
		const file = this.files[channel];
		if (file.fd !== undefined) {
			try { closeSync(file.fd); } catch { /* The file is already unavailable. */ }
			file.fd = undefined;
		}
		if (file.path !== undefined) {
			try { unlinkSync(file.path); } catch { /* The file is already gone. */ }
			file.path = undefined;
		}
		file.written = 0;
		file.pending = [];
		file.pendingBytes = 0;
		file.broken = true;
	}
}

/** Per-job output retention: 256 KiB while live, 16 KiB after settlement, unread model bytes kept. */
export class JobOutputRing {
	private readonly stdout = new StreamRing();
	private readonly stderr = new StreamRing();
	private readonly spill = new JobSpill();

	appendBytes(channel: Channel, chunk: Buffer): void {
		this.spill.write(channel, chunk);
		(channel === 'stdout' ? this.stdout : this.stderr).appendBytes(chunk);
		this.balanceLive();
	}

	appendText(channel: Channel, text: string): void {
		if (!text) return;
		this.spill.write(channel, Buffer.from(text, 'utf8'));
		(channel === 'stdout' ? this.stdout : this.stderr).appendText(text);
		this.balanceLive();
	}

	end(): void {
		this.stdout.end();
		this.stderr.end();
		this.spill.close();
	}

	dispose(): void {
		this.spill.dispose();
	}

	paths(): string[] {
		return this.spill.paths();
	}

	readFrom(cursor: ShellOutputCursor): { stdout: RingRead; stderr: RingRead } {
		return { stdout: this.stdout.readFrom(cursor.stdout), stderr: this.stderr.readFrom(cursor.stderr) };
	}

	text(): { stdout: string; stderr: string } {
		return { stdout: this.stdout.text(), stderr: this.stderr.text() };
	}

	trimSettled(cursor: ShellOutputCursor): void {
		const unreadStdout = Math.max(0, this.stdout.totalBytes() - cursor.stdout);
		const unreadStderr = Math.max(0, this.stderr.totalBytes() - cursor.stderr);
		const retained = this.stdout.retainedBytes() + this.stderr.retainedBytes();
		const stdoutExtra = retained === 0
			? 0
			: Math.round(SETTLED_JOB_BYTES * this.stdout.retainedBytes() / retained);
		this.stdout.trim(unreadStdout + stdoutExtra);
		this.stderr.trim(unreadStderr + SETTLED_JOB_BYTES - stdoutExtra);
	}

	private balanceLive(): void {
		const total = this.stdout.retainedBytes() + this.stderr.retainedBytes();
		if (total <= LIVE_JOB_BYTES) return;
		let overflow = total - LIVE_JOB_BYTES;
		const first = this.stdout.retainedBytes() >= this.stderr.retainedBytes() ? this.stdout : this.stderr;
		first.trim(Math.max(0, first.retainedBytes() - overflow));
		overflow = this.stdout.retainedBytes() + this.stderr.retainedBytes() - LIVE_JOB_BYTES;
		if (overflow <= 0) return;
		const second = first === this.stdout ? this.stderr : this.stdout;
		second.trim(Math.max(0, second.retainedBytes() - overflow));
	}
}

/** Prefix a read whose cursor fell behind the retained window. */
export function renderRingRead(read: RingRead): string {
	return read.dropped > 0 ? `…（已省略 ${read.dropped} 字节的新增输出）\n${read.text}` : read.text;
}
