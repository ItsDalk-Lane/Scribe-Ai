type ComposerKey = Pick<KeyboardEvent, 'key' | 'isComposing' | 'repeat' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>
	& { keyCode: number };

export function isImeComposing(event: Pick<ComposerKey, 'isComposing' | 'keyCode'>): boolean {
	return event.isComposing || event.keyCode === 229;
}

export function sideChatCommand(draft: string): string | null {
	const command = /^\/side(?:\s+([\s\S]+))?$/u.exec(draft.trim());
	return command ? command[1] ?? '' : null;
}

export function composerShortcut(event: ComposerKey) {
	if (isImeComposing(event) || event.altKey || event.ctrlKey || event.metaKey) return;
	if (event.key === 'Enter' && !event.shiftKey) return event.repeat ? 'ignore' : 'send';
	if (event.key === 'Escape' && !event.shiftKey && !event.repeat) return 'escape';
	return undefined;
}

export function referenceQuery(text: string, caret: number): { start: number; end: number; term: string } | undefined {
	if (caret <= 0 || caret > text.length) return;
	const start = text.lastIndexOf('@', caret - 1);
	if (start < 0 || (start > 0 && !/\s/u.test(text.charAt(start - 1)))) return;
	const term = text.slice(start + 1, caret);
	if (/[\r\n\u2028\u2029]|\s\$(?=[\p{L}\p{N}_:.-]|$)/u.test(term)) return;
	return { start, end: caret, term };
}

export function removeReferenceQuery(text: string, { start, end }: { start: number; end: number }): { instruction: string; caret: number } {
	const prefix = text.slice(0, start);
	const skipSpace = text[end] === ' ' && (!prefix || /[ \r\n\u2028\u2029]$/u.test(prefix));
	return { instruction: prefix + text.slice(end + Number(skipSpace)), caret: start };
}
