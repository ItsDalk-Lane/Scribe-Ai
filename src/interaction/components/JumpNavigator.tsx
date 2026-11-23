import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ChatIcon from './ChatIcon';

interface JumpEntry {
	id: string;
	label: string;
}

interface Props<Entry extends JumpEntry> {
	entries: Entry[];
	current?: string;
	label: string;
	onJump: (id: string) => void;
	renderPreview: (entry: Entry, onChoose: () => void) => ReactNode;
	renderListLabel: (entry: Entry) => ReactNode;
}

export default function JumpNavigator<Entry extends JumpEntry>({
	entries, current, label, onJump, renderPreview, renderListLabel,
}: Props<Entry>) {
	const listId = useId();
	const nav = useRef<HTMLElement>(null);
	const list = useRef<HTMLOListElement>(null);
	const toggle = useRef<HTMLButtonElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const [compact, setCompact] = useState(false);
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<string>();
	const showing = !compact && anchor !== undefined;
	const preview = showing ? entries.find(({ id }) => id === anchor) ?? entries[0] : undefined;
	const expanded = compact && open;

	function close() {
		setOpen(false);
		setAnchor(undefined);
	}
	function jump(id: string) {
		if (compact) toggle.current?.focus({ preventScroll: true });
		close();
		onJump(id);
	}

	useLayoutEffect(() => {
		const container = nav.current?.closest('.scribe-app');
		const win = container?.ownerDocument.defaultView;
		if (!container || !win) return;
		const touch = win.matchMedia('(hover: none)');
		const measure = () => setCompact(container.getBoundingClientRect().width < 600 || touch.matches);
		measure();
		const resize = new win.ResizeObserver(measure);
		resize.observe(container);
		touch.addEventListener('change', measure);
		return () => { resize.disconnect(); touch.removeEventListener('change', measure); };
	}, []);

	useLayoutEffect(close, [compact]);

	useLayoutEffect(() => {
		const panel = list.current;
		const active = panel?.querySelector('[aria-current]');
		if (!panel?.clientHeight || !active) return;
		const bounds = panel.getBoundingClientRect();
		const row = active.getBoundingClientRect();
		if (row.top < bounds.top) panel.scrollTop += row.top - bounds.top;
		if (row.bottom > bounds.bottom) panel.scrollTop += row.bottom - bounds.bottom;
	}, [current, expanded, compact]);

	useLayoutEffect(() => {
		const rail = nav.current;
		const pane = rail?.parentElement;
		const panel = card.current;
		const markers = list.current;
		const marker = markers?.querySelector<HTMLElement>('[data-previewed] > .scribe-turn-marker');
		const win = pane?.ownerDocument.defaultView;
		if (!rail || !pane || !panel || !markers || !marker || !win) return;
		const place = () => {
			const bounds = pane.getBoundingClientRect();
			panel.style.setProperty('--scribe-preview-max-height', `${bounds.height}px`);
			const row = marker.getBoundingClientRect();
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
		return () => { resize.disconnect(); markers.removeEventListener('scroll', place); };
	}, [showing, preview?.id, entries.length]);

	useEffect(() => {
		const element = nav.current;
		if ((!expanded && !showing) || !element) return;
		const dismiss = (event: PointerEvent) => {
			if (!event.composedPath().includes(element)) close();
		};
		const doc = element.ownerDocument;
		doc.addEventListener('pointerdown', dismiss);
		return () => doc.removeEventListener('pointerdown', dismiss);
	}, [expanded, showing]);

	function reveal(id: string) {
		if (!compact) setAnchor(id);
	}

	return <nav className="scribe-turn-navigator" data-compact={compact || undefined} aria-label={label} ref={nav}
		onMouseLeave={(event) => {
			if (!card.current?.contains(event.currentTarget.ownerDocument.activeElement)) setAnchor(undefined);
		}}
		onBlur={(event) => {
			if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close();
		}}
		onKeyDown={(event) => {
			if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== 'Escape' || (!expanded && !showing)) return;
			event.preventDefault();
			event.stopPropagation();
			const activeMarker = list.current?.querySelector<HTMLButtonElement>('[data-previewed] > .scribe-turn-marker');
			(expanded ? toggle.current : activeMarker)?.focus({ preventScroll: true });
			close();
		}}>
		{compact && <button type="button" className="scribe-turn-nav-toggle" ref={toggle} title={label}
			aria-label={label} aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
			onClick={() => setOpen(!expanded)}><ChatIcon name="list" /></button>}
		{(!compact || expanded) && <ol className="scribe-turn-nav-items" id={listId} ref={list}>
			{entries.map((entry) => <li key={entry.id} data-previewed={preview?.id === entry.id || undefined}>
				<button type="button" className="scribe-turn-marker"
					aria-current={current === entry.id ? 'location' : undefined} aria-label={entry.label}
					onMouseEnter={() => reveal(entry.id)} onFocus={() => reveal(entry.id)} onClick={() => jump(entry.id)}>
					<span className="scribe-turn-tick" aria-hidden="true" />
					{compact && <span className="scribe-turn-nav-label" aria-hidden="true">{renderListLabel(entry)}</span>}
				</button>
			</li>)}
		</ol>}
		{preview && <div className="scribe-turn-preview" ref={card}>
			{renderPreview(preview, () => jump(preview.id))}
		</div>}
	</nav>;
}
