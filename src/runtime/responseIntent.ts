const openingTag = '<scribe-intent>';
const closingTag = '</scribe-intent>';

export function normalizeModelIntent(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const intent = value.trim().replace(/[.。．]+$/u, '').trimEnd();
	return intent.length <= 48 && /\p{Script=Han}/u.test(intent) && !/[\r\n<>]/u.test(intent) ? intent : undefined;
}

export function thinkingHeadingIntent(content: string, complete: boolean): string | undefined {
	const firstLine = content.slice(0, 160).trimStart().split(/\r?\n/u, 2);
	const heading = firstLine[0]?.trim();
	if (!heading) return undefined;
	const bold = heading.match(/^\*\*(.+)\*\*$/u)?.[1];
	const markdown = complete || firstLine.length > 1 ? heading.match(/^#{1,6}\s+(.+?)\s*#*$/u)?.[1] : undefined;
	return normalizeModelIntent(bold ?? markdown);
}

export function splitResponseIntent(content: string, complete: boolean): { intent?: string; content: string } | undefined {
	const lead = content.trimStart();
	const canWait = !complete && content.length < 160;
	if (canWait && openingTag.startsWith(lead)) return undefined;
	if (!lead.startsWith(openingTag)) return { content };
	const end = lead.indexOf(closingTag, openingTag.length);
	if (end < 0) return canWait ? undefined : { content };
	const rest = lead.slice(end + closingTag.length);
	if (canWait && /^[ \t]*\r?$/u.test(rest)) return undefined;
	return {
		intent: normalizeModelIntent(lead.slice(openingTag.length, end)),
		content: rest.replace(/^[ \t]*\r?\n/u, ''),
	};
}
