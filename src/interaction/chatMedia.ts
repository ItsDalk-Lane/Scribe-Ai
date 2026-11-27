import type { DataAdapter } from 'obsidian';
import { isCachedImagePath } from '../orchestration/storage/paths';
import type { NoteRef } from '../types';

const extensions = {
	image: /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/iu,
	video: /\.(?:m4v|mkv|mov|mp4|ogv|webm)$/iu,
	audio: /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav)$/iu,
};

export type ChatMediaKind = keyof typeof extensions;

export function chatMediaKind(path: string): ChatMediaKind | undefined {
	for (const kind of ['image', 'video', 'audio'] as const) {
		if (extensions[kind].test(path)) return kind;
	}
	return undefined;
}

export function remoteChatMedia(value: string) {
	const url = URL.parse(value);
	if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
	const kind = chatMediaKind(url.pathname);
	return kind && { kind, source: url.href };
}

export function pastedImagePreview(adapter: Pick<DataAdapter, 'getResourcePath'>, ref: NoteRef): string | undefined {
	if (ref.pastedImage && ref.kind !== 'folder' && !ref.lines && isCachedImagePath(ref.path)) {
		return adapter.getResourcePath(ref.path);
	}
	return undefined;
}

const literalMarkdown = [
	// Fenced blocks, including fenced examples inside quotes.
	/^ {0,3}(?:>[ \t]? {0,3})*(?<fence>`{3,}|~{3,})[^\r\n]*(?:\r\n?|\n)[\s\S]*?(?:^ {0,3}(?:>[ \t]? {0,3})*\k<fence>(?:`*|~*)[ \t]*(?=\r?$)|$(?![\s\S]))/,
	/^(?: {4}|\t)[^\r\n]*/,
	/<!--[\s\S]*?(?:-->|$(?![\s\S]))|%%[\s\S]*?(?:%%|$(?![\s\S]))/,
	/(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)|\\[\\!]/,
];
const verbatim = new RegExp(literalMarkdown.map(({ source }) => source).join('|'), 'gmu');
const imageEmbed = /!\[(?!\[)(?<label>(?:\\.|[^\]\\\r\n])*)\](?:\(\s*(?:<(?<angle>[^>\r\n]*)>|(?<url>(?:\\.|[^()\s\\]|\([^()\r\n]*\))+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?\s*\)|\[(?<reference>[^\]\r\n]*)\])?(?!\[)/gu;
const definition = /^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]*)>|([^\s]+))/gmu;

function referenceLabel(value: string) {
	return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function maskMarkdownLiterals(markdown: string): string {
	return markdown.replace(verbatim, (part) => part.replace(/[^\r\n]/gu, (character) => ' '.repeat(character.length)));
}

// 在交给宿主渲染器前转成链接，避免渲染模型内容时自动访问媒体源站。
export function deferChatMediaEmbeds(markdown: string): string {
	const protectedMarkdown = maskMarkdownLiterals(markdown);
	const references = new Map<string, string>();
	for (const [, label, angle, url] of protectedMarkdown.matchAll(definition)) {
		const key = referenceLabel(label!);
		if (!references.has(key)) references.set(key, angle ?? url ?? '');
	}
	const edits: { index: number; text: string }[] = [];
	for (const { 0: embed, index, groups } of protectedMarkdown.matchAll(imageEmbed)) {
		if (!groups) continue;
		const destination = groups.angle ?? groups.url
			?? references.get(referenceLabel(groups.reference || groups.label || ''));
		if (!destination || !embed.length) continue;
		const kind = chatMediaKind(destination.split(/[?#]/u, 1)[0] ?? '');
		if (/^(?:[a-z][a-z\d+.-]*:|\/\/)|&(?:#\d+|#x[\da-f]+|colon|sol);/iu.test(destination) || kind === 'audio' || kind === 'video') {
			edits.push({ index, text: '' });
		}
	}
	for (const { index } of protectedMarkdown.matchAll(/<\/?(?:img|picture|source|audio|video|iframe|object|embed|link|svg|image)\b/giu)) {
		edits.push({ index, text: '&lt;' });
	}
	for (const { index } of protectedMarkdown.matchAll(/!\[\[(?=(?:[a-z][a-z\d+.-]*:\/\/|\/\/))/giu)) edits.push({ index, text: '' });
	if (!edits.length) return markdown;
	let result = '';
	let start = 0;
	for (const { index, text } of edits.sort((a, b) => a.index - b.index)) {
		result += markdown.slice(start, index) + text;
		start = index + 1;
	}
	return result + markdown.slice(start);
}

export function* bareChatMedia(text: string) {
	for (const { 0: match, index } of text.matchAll(/https?:\/\/(?:\[[\da-f:.]+\])?[^\s<>"'`[\]。，、；！？）》]+/giu)) {
		let label = match.replace(/[,;!?.]+$/u, '');
		while (label.endsWith(')') && label.split(')').length > label.split('(').length) label = label.slice(0, -1);
		const media = remoteChatMedia(label);
		if (media) yield { ...media, label, index };
	}
}
