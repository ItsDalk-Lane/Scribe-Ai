export function chatStatusBarSpace(element: HTMLDivElement | null) {
	const bar = element?.ownerDocument.querySelector('.status-bar');
	const win = bar?.ownerDocument.defaultView;
	if (!element || !bar || !win) return;
	const update = () => element.toggleAttribute('data-status-bar-visible', !bar.hasAttribute('hidden'));
	const observer = new win.MutationObserver(update);
	observer.observe(bar, { attributes: true, attributeFilter: ['hidden'] });
	update();
	return () => observer.disconnect();
}
