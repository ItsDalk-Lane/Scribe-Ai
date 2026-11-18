import { setIcon } from 'obsidian';
import { useCallback } from 'react';

export default function ChatIcon({ name }: { name: string }) {
	const attachIcon = useCallback((element: HTMLSpanElement | null) => {
		if (element) setIcon(element, name);
	}, [name]);
	return <span ref={attachIcon} className="scribe-chat-icon" aria-hidden="true" />;
}
