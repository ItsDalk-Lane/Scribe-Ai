type ComposerKey = Pick<KeyboardEvent, 'key' | 'isComposing' | 'repeat' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>
	& { keyCode: number };

export function composerShortcut(event: ComposerKey, draft = '', start = -1, end = start) {
	if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
	if (event.key === 'Enter' && !event.shiftKey) return event.repeat ? 'ignore' : 'send';
	if (event.key === 'Escape' && !event.shiftKey && !event.repeat) return 'escape';
	if (event.key === '@' && !event.repeat && start >= 0 && start === end && (start === 0 || /\s/u.test(draft.charAt(start - 1)))) return 'reference';
	return undefined;
}
