import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { uiText } from '../uiText';

interface SelectedPassage {
	quote: string;
	center: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
}

export default function TranscriptSelection({ scroll, content, onQuote }: {
	scroll: RefObject<HTMLDivElement | null>;
	content: RefObject<HTMLDivElement | null>;
	onQuote: (quote: string) => void;
}) {
	const text = uiText();
	const toolbar = useRef<HTMLDivElement>(null);
	const [passage, setPassage] = useState<SelectedPassage | null>(null);

	useEffect(() => {
		const region = scroll.current;
		const column = content.current;
		const doc = region?.ownerDocument;
		const win = doc?.defaultView;
		if (!doc || !win || !region || !column) return;
		let frame = 0;
		let pointer: number | undefined;

		const update = () => {
			if (pointer !== undefined) return;
			const selection = doc.getSelection();
			const inside = selection && !selection.isCollapsed && column.contains(selection.anchorNode) && column.contains(selection.focusNode);
			if (!inside) {
				if (!toolbar.current?.contains(doc.activeElement)) setPassage(null);
				return;
			}
			const quote = selection.toString().trim();
			const bounds = region.getBoundingClientRect();
			const right = bounds.left + region.clientWidth;
			const rect = quote && Array.from(selection.getRangeAt(0).getClientRects()).find((line) =>
				line.width > 0 && line.height > 0 && line.bottom > bounds.top && line.top < bounds.bottom
				&& line.right > bounds.left && line.left < right);
			setPassage(rect ? {
				quote, center: (Math.max(rect.left, bounds.left) + Math.min(rect.right, right)) / 2 - bounds.left,
				top: rect.top - bounds.top, bottom: rect.bottom - bounds.top, width: region.clientWidth, height: region.clientHeight,
			} : null);
		};
		const updateSoon = () => {
			win.cancelAnimationFrame(frame);
			frame = win.requestAnimationFrame(update);
		};
		const dismiss = () => {
			win.cancelAnimationFrame(frame);
			pointer = undefined;
			setPassage(null);
		};
		const start = (event: PointerEvent) => {
			if (!(event.target instanceof win.Node) || toolbar.current?.contains(event.target)) return;
			dismiss();
			if (event.button === 0 && column.contains(event.target)) pointer = event.pointerId;
		};
		const finish = (event: PointerEvent) => {
			if (pointer !== event.pointerId) return;
			pointer = undefined;
			updateSoon();
		};
		const focusActions = (event: KeyboardEvent) => {
			const first = toolbar.current?.querySelector('button');
			if (!first) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				doc.getSelection()?.removeAllRanges();
				dismiss();
				return;
			}
			if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
			event.preventDefault();
			first.focus({ preventScroll: true });
		};
		const resize = new win.ResizeObserver(updateSoon);
		resize.observe(region);
		resize.observe(column);
		doc.addEventListener('selectionchange', updateSoon);
		doc.addEventListener('pointerdown', start, true);
		doc.addEventListener('pointerup', finish, true);
		doc.addEventListener('pointercancel', finish, true);
		region.addEventListener('scroll', updateSoon);
		region.addEventListener('keydown', focusActions);
		win.addEventListener('blur', dismiss);
		return () => {
			win.cancelAnimationFrame(frame);
			resize.disconnect();
			doc.removeEventListener('selectionchange', updateSoon);
			doc.removeEventListener('pointerdown', start, true);
			doc.removeEventListener('pointerup', finish, true);
			doc.removeEventListener('pointercancel', finish, true);
			region.removeEventListener('scroll', updateSoon);
			region.removeEventListener('keydown', focusActions);
			win.removeEventListener('blur', dismiss);
		};
	}, [content, scroll]);

	useLayoutEffect(() => {
		const actions = toolbar.current;
		if (!passage || !actions) return;
		const gap = 6;
		const left = Math.max(gap, Math.min(passage.center - actions.offsetWidth / 2, passage.width - actions.offsetWidth - gap));
		const above = passage.top - actions.offsetHeight - gap;
		const top = above >= gap ? above : Math.max(gap, Math.min(passage.bottom + gap, passage.height - actions.offsetHeight - gap));
		actions.style.left = `${left}px`;
		actions.style.top = `${top}px`;
	}, [passage]);

	if (!passage) return null;
	function clear() {
		content.current?.ownerDocument.getSelection()?.removeAllRanges();
		setPassage(null);
	}
	return <div ref={toolbar} className="scribe-selection-actions" role="group" aria-label={text.chatSelectionPreview}
		style={{ maxWidth: Math.max(0, passage.width - 12) }} onPointerDown={(event) => event.preventDefault()}
		onKeyDown={(event) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			clear();
			scroll.current?.focus({ preventScroll: true });
		}}>
		<button type="button" onClick={() => { clear(); onQuote(passage.quote); }}>{text.chatAddSelection}</button>
	</div>;
}
