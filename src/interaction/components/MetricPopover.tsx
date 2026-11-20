import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import ChatIcon from './ChatIcon';

const ActiveMetric = createContext<[string | null, Dispatch<SetStateAction<string | null>>]>([null, () => {}]);

export function MetricPopoverProvider({ children }: { children: ReactNode }) {
	return <ActiveMetric.Provider value={useState<string | null>(null)}>{children}</ActiveMetric.Provider>;
}

export default function MetricPopover({ label, icon, heading, value, children, wrapValues = false }: {
	label: string; icon: string | ReactNode; heading: string; value?: string; children: ReactNode; wrapValues?: boolean;
}) {
	const id = useId();
	const [active, setActive] = useContext(ActiveMetric);
	const trigger = useRef<HTMLButtonElement>(null);
	const labelElement = useRef<HTMLSpanElement>(null);
	const panel = useRef<HTMLElement>(null);
	const closing = useRef(false);
	const open = active === id;
	const host = open ? trigger.current?.closest<HTMLElement>('.scribe-app') : undefined;
	const inside = (target: EventTarget | null) => {
		const owner = trigger.current?.ownerDocument.defaultView;
		return owner && target instanceof owner.Node && (trigger.current?.contains(target) || panel.current?.contains(target));
	};

	function close() {
		if (closing.current) return;
		closing.current = true;
		setActive((previous) => previous === id ? null : previous);
		const button = trigger.current;
		button?.ownerDocument.defaultView?.requestAnimationFrame(() => {
			if (button.isConnected && !host?.querySelector('.scribe-metric-label[aria-expanded="true"]')) {
				button.focus({ preventScroll: true });
			}
		});
	}

	useLayoutEffect(() => {
		const button = trigger.current;
		const popup = panel.current;
		const doc = button?.ownerDocument;
		const win = doc?.defaultView;
		if (!open || !host || !button || !popup || !doc || !win) return;
		closing.current = false;
		const composer = host.querySelector('.scribe-task-input');
		const inFooter = button.closest('.scribe-composer-metrics') !== null;
		const alignEnd = button.closest('.scribe-composer-context') !== null;
		const transcript = button.closest<HTMLElement>('.scribe-chat-scroll');
		const position = () => {
			const bounds = host.getBoundingClientRect();
			const anchor = button.getBoundingClientRect();
			const width = Math.max(0, Math.min(320, bounds.width - 12));
			const anchorLeft = alignEnd ? anchor.right - width : anchor.left;
			const left = Math.max(6, Math.min(anchorLeft - bounds.left, bounds.width - width - 6));
			popup.style.left = `${left}px`;
			popup.style.width = `${width}px`;
			const viewport = transcript?.getBoundingClientRect();
			if (viewport && (anchor.bottom <= viewport.top || anchor.top >= viewport.bottom)) {
				close();
				return;
			}
			const inputTop = composer?.getBoundingClientRect().top ?? bounds.bottom;
			const upperEdge = inFooter || alignEnd ? anchor.top : Math.min(anchor.top, inputTop);
			const above = Math.floor(upperEdge - bounds.top - 10);
			const below = Math.floor(inputTop - anchor.bottom - 8);
			const fullHeight = popup.scrollHeight + popup.offsetHeight - popup.clientHeight;
			const opensBelow = fullHeight > above && below > above;
			popup.style.top = opensBelow ? `${anchor.bottom - bounds.top + 4}px` : '';
			popup.style.bottom = opensBelow ? '' : `${bounds.bottom - upperEdge + 4}px`;
			popup.style.maxHeight = `${Math.max(0, opensBelow ? below : above)}px`;
		};
		const outside = (event: Event) => { if (!inside(event.target)) close(); };
		const resize = new win.ResizeObserver(position);
		resize.observe(host);
		resize.observe(button);
		if (composer) resize.observe(composer);
		resize.observe(popup);
		position();
		popup.focus({ preventScroll: true });
		doc.addEventListener('click', outside, true);
		doc.addEventListener('focusin', outside, true);
		doc.addEventListener('scroll', position, true);
		win.addEventListener('blur', close);
		return () => {
			doc.removeEventListener('click', outside, true);
			doc.removeEventListener('focusin', outside, true);
			doc.removeEventListener('scroll', position, true);
			win.removeEventListener('blur', close);
			resize.disconnect();
			setActive((previous) => previous === id ? null : previous);
		};
	}, [open, host, id, setActive]);

	function updateTooltip() {
		const span = labelElement.current;
		if (trigger.current && span) trigger.current.title = span.scrollWidth > span.clientWidth ? label : '';
	}

	return <div className="scribe-metric-anchor" onKeyDown={(event) => {
		if (open && (event.key === 'Escape' || event.key === 'Tab')) {
			event.preventDefault();
			event.stopPropagation();
			close();
		}
	}}>
		<button type="button" ref={trigger} className="scribe-metric-label" aria-haspopup="dialog"
			aria-expanded={open} aria-controls={open ? id : undefined} onPointerEnter={updateTooltip} onFocus={updateTooltip}
			onClick={() => { if (open) close(); else setActive(id); }}>
			{typeof icon === 'string' ? <ChatIcon name={icon} /> : icon}
			<span ref={labelElement}>{label}</span>
		</button>
		{host && createPortal(<section id={id} ref={panel} className="scribe-metric-panel" data-wrap-values={wrapValues || undefined}
			role="dialog" aria-label={heading} tabIndex={-1}>
			<header><strong>{typeof icon === 'string' && <ChatIcon name={icon} />}{heading}</strong>{value && <span>{value}</span>}</header>
			{children}
		</section>, host)}
	</div>;
}

export function MetricRows({ rows }: { rows: readonly (readonly [string, string | undefined])[] }) {
	return <dl>{rows.map(([label, value]) => value === undefined ? null : <div key={label} title={value}>
		<dt>{label}</dt><dd>{value}</dd>
	</div>)}</dl>;
}

export function ContextRing({ percent }: { percent: number }) {
	return <span className="scribe-context-ring" aria-hidden="true"
		style={{ '--scribe-context-progress': `${Math.min(100, percent)}%` } as CSSProperties} />;
}
