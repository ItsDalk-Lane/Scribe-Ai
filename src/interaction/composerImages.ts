import { Buffer } from 'node:buffer';
import type { App, FileSystemAdapter } from 'obsidian';
import { userImageReferences } from '../orchestration/context/imageAttachments';
import { scribeDataPaths } from '../orchestration/storage/paths';
import { MAX_IMAGE_BYTES, saveCachedImage } from '../tools/support/imageData';
import type { NoteRef } from '../types';

export function clipboardImages(clipboard: Pick<DataTransfer, 'files' | 'items'>): File[] {
	const files = Array.from(clipboard.files).filter((file) => file.type.startsWith('image/'));
	return files.length ? files : Array.from(clipboard.items).flatMap((item) => {
		const file = item.kind === 'file' && item.type.startsWith('image/') ? item.getAsFile() : null;
		return file ? [file] : [];
	});
}

export function imageLinkSource(app: App, instruction: string, previous?: string): string | undefined {
	if (!userImageReferences({ instruction, refs: [] }).some(({ kind }) => kind === 'vault-link')) return undefined;
	return previous ?? app.workspace.getActiveFile()?.path;
}

export async function saveClipboardImage(app: App, conversationId: string, file: File): Promise<NoteRef> {
	if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 5 MiB。');
	const cwd = (app.vault.adapter as FileSystemAdapter).getBasePath();
	const path = await saveCachedImage(cwd, { cacheDirectory: scribeDataPaths(cwd).cache, conversationId },
		Buffer.from(await file.arrayBuffer()), 'screenshot');
	return { path, kind: 'file', pastedImage: true };
}
