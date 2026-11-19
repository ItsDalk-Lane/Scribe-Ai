export interface MarkdownBlock {
	text: string;
	// 字符偏移与行号都从 0 开始，换行保持原样。
	offset: number;
	line: number;
}

const blankLine = /^[ \t]*$/u;
const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const mathStart = /^ {0,3}\$\$(?!\$)/u;
const mathEnd = /(?<!\\)\$\$/u;
const frontMatter = /^---[ \t]*$/u;
const continuation = /^(?:[ \t]|>|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/u;
const sharedMarkdown = /(?<![\\[])(?:\[[^[\]]+\](?![\](])|\^\[|<!--|%%)|^ {0,3}<\/?[a-z][a-z0-9-]*(?=[ \t/>]|$)/iu;

export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	let start = -1;
	let end = 0;
	let line = -1;
	let startLine = 0;
	let separator = false;
	let fence: string | undefined;
	let math = false;
	let shared = false;

	for (const { 0: raw, 1: value = '', index } of text.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/gu)) {
		line++;
		if (blankLine.test(value)) {
			if (fence || math) end = index + raw.length;
			else separator = start >= 0;
			continue;
		}

		if (start < 0 && frontMatter.test(value)) {
			return [{ text, offset: 0, line: 0 }];
		}

		if (start < 0) {
			start = index;
			startLine = line;
		} else if (separator && !shared && !continuation.test(value) && !value.includes('|') && !frontMatter.test(value)) {
			blocks.push({ text: text.slice(start, end), offset: start, line: startLine });
			start = index;
			startLine = line;
		}
		separator = false;

		const marker = fenceLine.exec(value);
		if (fence) {
			if (marker?.[1]?.startsWith(fence) && blankLine.test(marker[2] ?? '')) fence = undefined;
		} else if (math) {
			math = !mathEnd.test(value);
		} else if (marker?.[1] && (!marker[1].startsWith('`') || !marker[2]?.includes('`'))) {
			fence = marker[1];
		} else {
			const opening = mathStart.exec(value);
			math = Boolean(opening && !mathEnd.test(value.slice(opening[0].length)));
			// 从第一条引用、脚注或 HTML 起保留上下文，前面已经完成的块仍可复用。
			shared ||= !opening && sharedMarkdown.test(value);
		}
		end = index + (fence || math ? raw.length : value.length);
	}

	if (start >= 0) blocks.push({ text: text.slice(start, end), offset: start, line: startLine });
	return blocks;
}
