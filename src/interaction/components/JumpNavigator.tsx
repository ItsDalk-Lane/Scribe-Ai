import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ChatIcon from './ChatIcon';

export interface JumpEntry {
	id: string;
	label: string;
	detail?: string;
}

interface Props<Entry extends JumpEntry> {
	entries: Entry[];
	current?: string;
	label: string;
	side?: 'left' | 'right';
	icon: string;
	disabled?: boolean;
	emptyLabel?: string;
	onJump: (id: string) => void;
	onInteract?: () => void;
	renderPreview: (entry: Entry, onChoose: () => void) => ReactNode;
	renderListLabel?: (entry: Entry) => ReactNode;
	renderCompactEntry?: (entry: Entry, onChoose: () => void) => ReactNode;
	renderEmpty?: () => ReactNode;
}

export default function JumpNavigator<Entry extends JumpEntry>({
	entries, current, label, side = 'left', icon, disabled, emptyLabel, onJump, onInteract,
	renderPreview, renderListLabel, renderCompactEntry, renderEmpty,
}: Props<Entry>) {
	const listId = useId();
	const nav = useRef<HTMLElement>(null);
	const list = useRef<HTMLOListElement>(null);
	const toggle = useRef<HTMLButtonElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const [compact, setCompact] = useState(false);
	const [open, setOpen] = useState(false);
	// undefined 收起预览；null 显示空列表提示。
	const [anchor, setAnchor] = useState<string | null>();
	const showing = !compact && anchor !== undefined;
	const preview = showing ? entries.find(({ id }) => id === anchor) ?? entries[0] : undefined;
	const expanded = compact && open;

	function close() {
		setOpen(false);
		setAnchor(undefined);
	}
	function jump(id: string) {
		if (disabled) return;
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
			if (!event.composedPath().includes(element) && !(event.target as Element | null)?.closest?.('.modal-container')) close();
		};
		const doc = element.ownerDocument;
		doc.addEventListener('pointerdown', dismiss);
		return () => doc.removeEventListener('pointerdown', dismiss);
	}, [expanded, showing]);

	function reveal(id: string | null, hovering: boolean) {
		if (compact || disabled) return;
		if (hovering && card.current?.querySelector('input[type="text"]:focus')) return;
		setAnchor(id);
	}

	function marker(entry?: Entry) {
		const id = entry?.id ?? null;
		return <button type="button" className="scribe-turn-marker" disabled={disabled}
			aria-current={entry && current === id ? 'location' : undefined}
			aria-label={entry?.label ?? emptyLabel ?? label}
			onMouseEnter={() => reveal(id, true)} onFocus={() => reveal(id, false)}
			onClick={() => entry ? jump(entry.id) : reveal(null, false)}>
			<span className="scribe-turn-tick" aria-hidden="true" />
			{compact && entry && <span className="scribe-turn-nav-label" aria-hidden="true">
				{renderListLabel ? renderListLabel(entry) : <><span>{entry.label}</span>{entry.detail && <span>{entry.detail}</span>}</>}
			</span>}
		</button>;
	}

	return <nav className="scribe-turn-navigator" data-side={side} data-compact={compact || undefined} aria-label={label} ref={nav}
		onMouseEnter={(event) => {
			if (!compact && !event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement)) onInteract?.();
		}}
		onMouseLeave={(event) => {
			const active = event.currentTarget.ownerDocument.activeElement;
			if (!disabled && !card.current?.contains(active) && !active?.closest('.modal-container')) setAnchor(undefined);
		}}
		onFocus={(event) => {
			if (!compact && !event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) onInteract?.();
		}}
		onBlur={(event) => {
			const target = event.relatedTarget;
			if (!disabled && target && !event.currentTarget.contains(target) && !target.closest('.modal-container')) close();
		}}
		onKeyDown={(event) => {
			if (event.defaultPrevented || event.nativeEvent.isComposing) return;
			const activeMarker = list.current?.querySelector<HTMLButtonElement>('[data-previewed] > .scribe-turn-marker');
			if (event.key === 'Escape' && (expanded || showing)) {
				event.preventDefault();
				event.stopPropagation();
				(expanded ? toggle.current : activeMarker)?.focus({ preventScroll: true });
				close();
			} else if (event.key === 'Tab' && showing && activeMarker && card.current) {
				// 预览卡在滚动列表外绘制，但键盘应先经过当前短线的操作。
				const controls = Array.from(card.current.querySelectorAll<HTMLElement>('button, input, [tabindex]'))
					.filter((item) => item.tabIndex >= 0 && !item.matches(':disabled') && item.getClientRects().length);
				const first = controls[0];
				const nextMarker = activeMarker.parentElement?.nextElementSibling?.querySelector<HTMLButtonElement>('.scribe-turn-marker');
				const target = !event.shiftKey && event.target === activeMarker ? first
					: event.shiftKey && event.target === first ? activeMarker
					: !event.shiftKey && event.target === controls.at(-1) ? nextMarker : undefined;
				if (target) { event.preventDefault(); target.focus(); }
			}
		}}>
		{compact && <button type="button" className="scribe-turn-nav-toggle" ref={toggle} title={label}
			disabled={disabled} aria-label={label} aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
			onClick={() => { if (!expanded) onInteract?.(); setOpen(!expanded); }}><ChatIcon name={icon} /></button>}
		{(!compact || expanded) && <ol className="scribe-turn-nav-items" id={listId} ref={list}>
			{entries.map((entry) => <li key={entry.id} data-previewed={preview?.id === entry.id || undefined}>
				{compact && renderCompactEntry ? renderCompactEntry(entry, () => jump(entry.id)) : marker(entry)}
			</li>)}
			{!entries.length && emptyLabel && <li data-previewed={showing || undefined}>
				{compact ? <p className="scribe-chat-loading" role="status">{emptyLabel}</p> : marker()}
			</li>}
		</ol>}
		{showing && <div className="scribe-turn-preview" ref={card}>
			{preview ? renderPreview(preview, () => jump(preview.id)) : renderEmpty?.()}
		</div>}
	</nav>;
}
