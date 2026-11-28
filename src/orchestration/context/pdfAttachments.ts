import { Buffer } from 'node:buffer';
import { basename, isAbsolute } from 'node:path';
import { MAX_PDF_BYTES } from '../../communication/modelPdf';
import { openToolFile } from '../../tools/support/fileAccess';
import { resolveToolPath } from '../../tools/support/pathUtils';
import type { NoteRef, RunContext, TaskRequest } from '../../types';

export function pdfAttachmentPath({ path, kind, lines, addedExternal }: NoteRef): boolean {
	return kind !== 'folder' && lines === undefined && (!isAbsolute(path) || addedExternal === true) && /\.pdf$/iu.test(path);
}

export function pdfSources({ refs }: Pick<TaskRequest, 'refs'>): string[] {
	return [...new Set(refs.filter(pdfAttachmentPath).map(({ path }) => path))];
}

export async function readPdfAttachment(ctx: RunContext, path: string) {
	const resolve = async () => {
		const resolved = await resolveToolPath(ctx, path, 'read');
		if (ctx.permissions.readLines?.(resolved.absolutePath)) throw new Error('此 PDF 未授权为完整附件。');
		return resolved;
	};
	const resolved = await resolve();
	const { file, size } = await openToolFile(resolved);
	try {
		if (!size || size > MAX_PDF_BYTES) throw new Error('PDF 附件必须为非空文件，单个文件不得超过 12 MiB。');
		const buffer = Buffer.alloc(size + 1);
		let read = 0;
		while (read < buffer.length) {
			ctx.signal.throwIfAborted();
			const { bytesRead } = await file.read(buffer, read, buffer.length - read, read);
			if (!bytesRead) break;
			read += bytesRead;
		}
		if (read !== size) throw new Error('PDF 附件已变化，请重新选择后发送。');
		if (!/%PDF-[12]\.\d/u.test(buffer.toString('latin1', 0, Math.min(read, 1024)))) {
			throw new Error('附件缺少有效的 PDF 文件头。');
		}
		const recheck = async () => {
			const current = await resolve();
			if (current.absolutePath !== resolved.absolutePath || current.stat?.ino !== resolved.stat?.ino
				|| current.stat?.dev !== resolved.stat?.dev || current.stat?.size !== size
				|| current.stat?.mtimeMs !== resolved.stat?.mtimeMs || current.stat?.ctimeMs !== resolved.stat?.ctimeMs) {
				throw new Error('PDF 附件已变化，请重新选择后发送。');
			}
		};
		await recheck();
		return { filename: basename(path), bytes: buffer.subarray(0, read), recheck };
	} finally {
		await file.close();
	}
}
