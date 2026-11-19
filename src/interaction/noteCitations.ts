import type { Vault } from 'obsidian';

export function resolveInlineNote(vault: Pick<Vault, 'getFileByPath'>, code: string) {
	const reference = code.trim();
	const anchor = reference.indexOf('#');
	const path = (anchor < 0 ? reference : reference.slice(0, anchor)).trim().normalize('NFC');
	if (!/\.md$/iu.test(path) || /[:\\\0\r\n]/u.test(path)
		|| path.split('/').some((part) => !part || part === '.' || part === '..')) return;
	const file = vault.getFileByPath(path);
	if (file?.path !== path || file.extension.toLowerCase() !== 'md') return;
	return { file, subpath: anchor < 0 ? '' : reference.slice(anchor) };
}
