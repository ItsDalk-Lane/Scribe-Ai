import { setIcon } from 'obsidian';
import { providerIcon } from './providerIcons';

/** 品牌图标优先，其次内置图标，最后退回首字母 */
export function paintProviderIcon(el: HTMLElement, providerId: string, label: string): void {
	const icon = providerIcon(providerId);
	if (icon?.svg) {
		// 品牌 SVG 内联在代码里，这里只做解析和挂载，不发起网络请求
		const parsed = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${icon.svg}</svg>`, 'image/svg+xml');
		const root = parsed.documentElement;
		if (root.nodeName === 'svg' && !root.querySelector('parsererror')) {
			const svg = el.createSvg('svg', {
				attr: { viewBox: icon.viewBox ?? '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
			});
			if (icon.color) svg.style.color = icon.color;
			for (const child of Array.from(root.childNodes)) svg.appendChild(el.ownerDocument.importNode(child, true));
			return;
		}
	}
	if (icon?.icon) {
		setIcon(el, icon.icon);
		return;
	}
	el.setText((label.trim()[0] ?? '?').toUpperCase());
}
