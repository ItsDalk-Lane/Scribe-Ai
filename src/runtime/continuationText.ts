import type { Message } from '../types';

export function latestIncompleteReply(messages: Message[]): string | undefined {
	if (!messages.at(-1)?.incomplete) return undefined;
	let index = messages.length - 1;
	while (index > 0 && messages[index - 1]?.incomplete) index--;
	return messages.slice(index).map(({ content }) => content).join('');
}

export function newContinuationText(previous: string, next: string): string {
	const resumed = next.replace(/^(?:[ \t]*\r?\n)+/u, '');
	// shortcut: 仅移除最近八行中完全相同的尾部，其他改写需另有可靠的对齐依据。
	const lines = previous.split('\n').slice(-8);
	for (let index = 0; index < lines.length; index++) {
		const overlap = lines.slice(index).join('\n');
		if (overlap.trim().length >= 3 && /[\p{L}\p{N}]/u.test(overlap) && resumed.startsWith(overlap)) {
			return resumed.slice(overlap.length);
		}
	}
	return next;
}
