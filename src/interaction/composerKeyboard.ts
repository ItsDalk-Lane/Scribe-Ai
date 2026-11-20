type ComposerKey = Pick<KeyboardEvent, 'key' | 'isComposing' | 'repeat' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>
	& { keyCode: number };

export function isImeComposing(event: Pick<ComposerKey, 'isComposing' | 'keyCode'>): boolean {
	return event.isComposing || event.keyCode === 229;
}

export function sideChatCommand(draft: string): string | null {
	const command = /^\/side(?:\s+([\s\S]+))?$/u.exec(draft.trim());
	return command ? command[1] ?? '' : null;
}

export function composerShortcut(event: ComposerKey, draft = '', start = -1, end = start) {
	if (isImeComposing(event) || event.altKey || event.ctrlKey || event.metaKey) return;
	if (event.key === 'Enter' && !event.shiftKey) return event.repeat ? 'ignore' : 'send';
	if (event.key === 'Escape' && !event.shiftKey && !event.repeat) return 'escape';
	if (event.key === '@' && !event.repeat && start >= 0 && start === end && (start === 0 || /\s/u.test(draft.charAt(start - 1)))) return 'reference';
	return undefined;
}
