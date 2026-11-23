import { useCallback, useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

type Bounds = Pick<DOMRectReadOnly, 'top' | 'right' | 'bottom' | 'left'>;

export function isInPopoverGap(trigger: Bounds, panel: Bounds, x: number, y: number): boolean {
	const [upper, lower] = trigger.bottom <= panel.top ? [trigger, panel] : [panel, trigger];
	const gap = lower.top - upper.bottom;
	if (gap <= 0 || y < upper.bottom || y > lower.top) return false;
	const progress = (y - upper.bottom) / gap;
	return x >= upper.left + (lower.left - upper.left) * progress
		&& x <= upper.right + (lower.right - upper.right) * progress;
}

export function usePopoverHover(trigger: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>,
	enabled: boolean, previewing: boolean, show: () => void, dismiss: () => void) {
	const clearTimer = useRef<(() => void) | null>(null);
	const cancel = useCallback(() => {
		clearTimer.current?.();
		clearTimer.current = null;
	}, []);
	useLayoutEffect(() => cancel, [enabled, cancel]);

	useLayoutEffect(() => {
		if (!previewing) return;
		const button = trigger.current;
		const popup = panel.current;
		const doc = button?.ownerDocument;
		const win = doc?.defaultView;
		if (!button || !popup || !doc || !win) return;

		const track = (event: PointerEvent) => {
			if (event.pointerType !== 'mouse') return;
			const path = event.composedPath();
			if (path.includes(button) || path.includes(popup)) return;
			// 让鼠标在悬浮面板和按钮之间停留或斜着经过，避免慢速移动时收起。
			if (!isInPopoverGap(button.getBoundingClientRect(), popup.getBoundingClientRect(), event.clientX, event.clientY)) dismiss();
		};

		doc.addEventListener('pointermove', track, true);
		doc.documentElement.addEventListener('pointerleave', dismiss);
		win.addEventListener('blur', dismiss);
		return () => {
			doc.removeEventListener('pointermove', track, true);
			doc.documentElement.removeEventListener('pointerleave', dismiss);
			win.removeEventListener('blur', dismiss);
		};
	}, [previewing, trigger, panel, dismiss]);

	function enter(event: ReactPointerEvent<HTMLElement>) {
		if (!enabled || previewing || event.pointerType !== 'mouse') return;
		const win = event.currentTarget.ownerDocument.defaultView;
		if (!win) return;
		cancel();
		const timer = win.setTimeout(() => {
			clearTimer.current = null;
			show();
		}, 150);
		clearTimer.current = () => win.clearTimeout(timer);
	}

	return { enter, cancel };
}
