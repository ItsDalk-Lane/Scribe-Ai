import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { NoteRef } from '../types';

export type ExternalReferenceMode = NonNullable<NoteRef['kind']> | 'path';
type OpenProperty = 'openFile' | 'openDirectory' | 'dontAddToRecent';

const openProperties: Record<ExternalReferenceMode, OpenProperty[]> = {
	file: ['openFile', 'dontAddToRecent'],
	folder: ['openDirectory', 'dontAddToRecent'],
	path: ['openFile', 'openDirectory', 'dontAddToRecent'],
};

interface DesktopWindow extends Window {
	electronWindow?: unknown;
	electron?: {
		remote?: {
			getCurrentWindow?: () => unknown;
			dialog?: {
				showOpenDialog(owner: unknown, options: {
					title: string;
					properties: OpenProperty[];
				}): Promise<{ canceled: boolean; filePaths: string[] }>;
			};
		};
	};
}

export async function externalReferenceAt(path: string, mode: ExternalReferenceMode): Promise<NoteRef> {
	if (!isAbsolute(path)) throw new Error('需要文件或文件夹的完整路径。');
	const info = await stat(path);
	const kind = info.isDirectory() ? 'folder' : info.isFile() ? 'file' : undefined;
	if (!kind || (mode !== 'path' && mode !== kind)) throw new Error('路径必须指向所选类型的文件或文件夹。');
	return { path, kind };
}

export async function pickExternalReference(document: Document, mode: ExternalReferenceMode, title: string): Promise<NoteRef | null> {
	const window = document.defaultView as DesktopWindow | null;
	const remote = window?.electron?.remote;
	const owner = window?.electronWindow ?? remote?.getCurrentWindow?.();
	if (!owner || !remote?.dialog) throw new Error('系统选择窗口不可用。');
	const result = await remote.dialog.showOpenDialog(owner, {
		title,
		properties: openProperties[mode],
	});
	if (result.canceled) return null;
	return externalReferenceAt(result.filePaths[0] ?? '', mode);
}
