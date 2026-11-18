import type { TFile, Vault } from 'obsidian';

export interface NoteCitation {
	raw: string;
	path: string;
	subpath: string;
}

function readCitation(raw: string, target: string, codeSpan: boolean): NoteCitation | null {
	const reference = target.trim();
	const anchor = reference.indexOf('#');
	const path = (anchor < 0 ? reference : reference.slice(0, anchor)).trim().normalize('NFC');
	const hasExtension = /\.md$/i.test(path);
	if ((!hasExtension && (codeSpan || !path.includes('/'))) || /[:\\\0]/u.test(path)
		|| path.split('/').some((part) => !part || part === '.' || part === '..')) {
		return null;
	}
	return {
		raw,
		path: hasExtension ? path : path + '.md',
		subpath: anchor < 0 ? '' : reference.slice(anchor),
	};
}

/** 保留原始答复，只识别能指向库内笔记的引用。 */
export function parseNoteCitations(content: string): Array<string | NoteCitation> {
	const parts: Array<string | NoteCitation> = [];
	let offset = 0;
	let openFence = '';
	for (const { 0: line, index: lineIndex } of content.matchAll(/[^\r\n]+/gu)) {
		const fence = /^ {0,3}(\x60{3,}|~{3,})(.*)$/u.exec(line);
		if (openFence) {
			const closing = fence?.[1];
			if (closing?.startsWith(openFence) && !fence?.[2]?.trim()) openFence = '';
			continue;
		}
		if (fence?.[1]) {
			openFence = fence[1];
			continue;
		}
		for (const { 0: raw, 1: ticks, 2: codeText, 3: wiki, index } of line.matchAll(/(\x60+)(.+?)\1(?!\x60)|!?\[\[([^[\]]+)\]\]/gu)) {
			const from = lineIndex + index;
			if (content[from - 1] === '\\' || raw.startsWith('!')) continue;
			const target = ticks === '\x60' ? codeText : wiki?.split('|', 1)[0];
			const citation = target ? readCitation(raw, target, Boolean(ticks)) : null;
			if (!citation) continue;
			if (from > offset) parts.push(content.slice(offset, from));
			parts.push(citation);
			offset = from + raw.length;
		}
	}
	if (content.length > offset) parts.push(content.slice(offset));
	return parts;
}

export function resolveNoteCitation(vault: Pick<Vault, 'getFileByPath'>, citation: NoteCitation): TFile | null {
	const file = vault.getFileByPath(citation.path);
	return file?.path === citation.path && file.extension.toLowerCase() === 'md' ? file : null;
}
