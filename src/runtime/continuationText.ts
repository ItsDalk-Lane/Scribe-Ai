import type { Message } from '../types';

export function isSteeringMessage(message: Message | undefined): boolean {
	return message?.role === 'user' && message.id?.startsWith('steer:') === true;
}

export function latestIncompleteReply(messages: Message[]): string | undefined {
	const fragments: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (isSteeringMessage(message)) continue;
		if (message.role !== 'assistant' || (!message.incomplete && !message.truncated)) break;
		fragments.push(message.content);
	}
	return fragments.length ? fragments.reverse().join('') : undefined;
}

export function newContinuationText(previous: string, next: string): string {
	const resumed = next.replace(/^(?:[ \t]*\r?\n)+/u, '');
	const repeats = (overlap: string) => resumed.startsWith(overlap) && overlap.trim().length >= 3 && /[\p{L}\p{N}]/u.test(overlap);
	if (repeats(previous)) return resumed.slice(previous.length);
	// shortcut: 除完整重复外，只匹配最近八行中完全相同的尾部，其他改写需可靠的对齐依据。
	const lines = previous.split('\n').slice(-8);
	for (let index = 0; index < lines.length; index++) {
		const overlap = lines.slice(index).join('\n');
		if (repeats(overlap)) {
			return resumed.slice(overlap.length);
		}
	}
	return next;
}
