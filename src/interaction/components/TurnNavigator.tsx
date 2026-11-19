import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';

interface Entry {
	id: string;
	prompt: string;
	reply: string;
}

export default function TurnNavigator({
	entries, current, onJump,
}: { entries: Entry[]; current?: string; onJump: (id: string) => void }) {
	const text = uiText();
	const listId = useId();
	const nav = useRef<HTMLElement>(null);
	const list = useRef<HTMLOListElement>(null);
	const toggle = useRef<HTMLButtonElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<{ id: string; marker: HTMLButtonElement }>();
	const previewIndex = entries.findIndex(({ id }) => id === anchor?.id);
	const preview = entries[previewIndex];
	const turnLabel = (index: number) => text.chatJumpToTurn.replace('{n}', (index + 1).toLocaleString());

	function jump(id: string) {
		setOpen(false);
		setAnchor(undefined);
		onJump(id);
	}

	useLayoutEffect(() => {
		const panel = list.current;
		const active = panel?.querySelector('[aria-current="location"]');
		if (!panel?.clientHeight || !active) return;
		const bounds = panel.getBoundingClientRect();
		const row = active.getBoundingClientRect();
		if (row.top < bounds.top) panel.scrollTop += row.top - bounds.top;
		if (row.bottom > bounds.bottom) panel.scrollTop += row.bottom - bounds.bottom;
	}, [current, open]);

	useLayoutEffect(() => {
		const rail = nav.current;
		const pane = rail?.parentElement;
		const panel = card.current;
		const markers = list.current;
		const win = pane?.ownerDocument.defaultView;
		if (!anchor || !rail || !pane || !panel || !markers || !win) return;
		const place = () => {
			const bounds = pane.getBoundingClientRect();
			const row = anchor.marker.getBoundingClientRect();
			const height = panel.offsetHeight;
			const top = Math.max(bounds.top, Math.min(row.top + (row.height - height) / 2, bounds.bottom - height));
			panel.style.insetBlockStart = `${top - rail.getBoundingClientRect().top}px`;
		};
		place();
		const resize = new win.ResizeObserver(place);
		resize.observe(pane);
		resize.observe(rail);
		resize.observe(panel);
		markers.addEventListener('scroll', place);
		return () => {
			resize.disconnect();
			markers.removeEventListener('scroll', place);
		};
	}, [anchor]);

	useEffect(() => {
		const element = nav.current;
		if (!open || !element) return;
		const close = (event: PointerEvent) => {
			if (!event.composedPath().includes(element)) setOpen(false);
		};
		const doc = element.ownerDocument;
		doc.addEventListener('pointerdown', close);
		return () => doc.removeEventListener('pointerdown', close);
	}, [open]);

	return (
		<nav className="scribe-turn-navigator" aria-label={text.chatTurnNavigator} ref={nav}
			onMouseLeave={() => setAnchor(undefined)} onBlur={(event) => {
			if (event.currentTarget.contains(event.relatedTarget)) return;
			setOpen(false);
			if (!event.currentTarget.matches(':hover')) setAnchor(undefined);
		}} onKeyDown={(event) => {
			if (event.key !== 'Escape' || (!open && !anchor)) return;
			event.preventDefault();
			event.stopPropagation();
			if (open) toggle.current?.focus();
			setOpen(false);
			setAnchor(undefined);
		}}>
			<button type="button" className="scribe-turn-nav-toggle" ref={toggle} title={text.chatTurnNavigator}
				aria-label={text.chatTurnNavigator} aria-expanded={open} aria-controls={listId}
				onClick={() => setOpen(!open)}><ChatIcon name="list" /></button>
			<ol className="scribe-turn-nav-items" id={listId} data-open={open} ref={list}>
				{entries.map(({ id, prompt, reply }, index) => {
					const label = turnLabel(index);
					return <li key={id} data-previewed={anchor?.id === id || undefined}>
						<button type="button" className="scribe-turn-marker" aria-current={current === id ? 'location' : undefined}
							aria-label={[label, prompt].filter(Boolean).join(' · ')}
							onMouseEnter={(event) => setAnchor({ id, marker: event.currentTarget })}
							onFocus={(event) => setAnchor({ id, marker: event.currentTarget })}
							onClick={() => jump(id)}>
							<span className="scribe-turn-tick" aria-hidden="true" />
							<span className="scribe-turn-nav-label" aria-hidden="true">
								<span>{prompt || label}</span>
								{reply && <span>{reply}</span>}
							</span>
						</button>
					</li>;
				})}
			</ol>
			{preview && (preview.prompt || preview.reply) && <div className="scribe-turn-preview" ref={card}>
				<button type="button" className="scribe-turn-preview-action" tabIndex={-1} aria-label={turnLabel(previewIndex)}
					onClick={() => jump(preview.id)}>
					{preview.prompt && <span>{preview.prompt}</span>}
					{preview.reply && <span className="scribe-turn-preview-reply">{preview.reply}</span>}
				</button>
			</div>}
		</nav>
	);
}
