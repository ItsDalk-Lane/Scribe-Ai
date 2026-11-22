const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const quotePrefix = /^ {0,3}>[ \t]?/u;

export function copyableMarkdownParts(markdown: string): { snippets: string[]; quotes: string[] } {
	const snippets: string[] = [];
	const quotes: string[] = [];
	let quote = '';
	let fence: { marker: string; start: number } | undefined;

	for (const { 0: raw, 1: line = '', index } of markdown.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/gu)) {
		const opening = fenceLine.exec(line);
		const marker = opening?.[1];
		if (fence) {
			if (marker?.startsWith(fence.marker) && !opening?.[2]?.trim()) {
				snippets.push(markdown.slice(fence.start, index).trimEnd());
				fence = undefined;
			}
			continue;
		}

		const prefix = quotePrefix.exec(line)?.[0];
		if (prefix) {
			quote += raw.slice(prefix.length);
			continue;
		}
		if (quote) {
			quotes.push(quote.trimEnd());
			quote = '';
		}
		if (marker && (!marker.startsWith('`') || !opening?.[2]?.includes('`'))) {
			fence = { marker, start: index + raw.length };
		}
	}

	if (quote) quotes.push(quote.trimEnd());
	if (fence) snippets.push(markdown.slice(fence.start).trimEnd());
	return { snippets, quotes };
}
