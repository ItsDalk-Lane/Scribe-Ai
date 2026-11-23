import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

export function useComposerPopoverPosition(popover: RefObject<HTMLDivElement | null>, visible: boolean, aboveOnly = false) {
	useLayoutEffect(() => {
		if (!visible) return;
		const menu = popover.current;
		const field = menu?.parentElement;
		const win = field?.ownerDocument.defaultView;
		if (!menu || !field || !win) return;
		const pane = field.closest('.scribe-app') ?? field.ownerDocument.documentElement;
		const measure = () => {
			const rect = field.getBoundingClientRect();
			const bounds = pane.getBoundingClientRect();
			const above = rect.top - Math.max(0, bounds.top) - 12;
			const below = Math.min(win.innerHeight, bounds.bottom) - rect.bottom - 12;
			const placement = aboveOnly || above >= 200 || above >= below ? 'above' : 'below';
			menu.dataset.placement = placement;
			menu.style.setProperty('--scribe-composer-popover-height',
				`${Math.max(aboveOnly ? 48 : 120, Math.floor(placement === 'above' ? above : below))}px`);
		};
		measure();
		const observer = new win.ResizeObserver(measure);
		observer.observe(pane);
		observer.observe(field);
		win.addEventListener('resize', measure);
		return () => {
			observer.disconnect();
			win.removeEventListener('resize', measure);
		};
	}, [aboveOnly, popover, visible]);
}
