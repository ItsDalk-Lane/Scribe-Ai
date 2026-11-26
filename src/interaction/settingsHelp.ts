import { setIcon, setTooltip } from 'obsidian';

// Obsidian 把 0 当作未指定延迟，从而使用约 1 秒的默认值。
export const HELP_TOOLTIP = { placement: 'top', delay: 1 } as const;

export function createHelpIcon(parent: HTMLElement, text: string): void {
	const help = parent.createSpan({ cls: 'scribe-setting-help', attr: { tabindex: '0', role: 'img' } });
	setIcon(help, 'circle-help');
	setTooltip(help, text, HELP_TOOLTIP);
}

/** 说明文字保留在隐藏的原节点里作为内容来源，标题旁的图标跟随它的最新文字。 */
function syncHelp(setting: HTMLElement): void {
	const info = setting.querySelector(':scope > .setting-item-info');
	const name = info?.querySelector<HTMLElement>(':scope > .setting-item-name');
	if (!name) return;
	const text = info?.querySelector(':scope > .setting-item-description')?.textContent?.trim() ?? '';
	const help = name.querySelector<HTMLElement>(':scope > .scribe-setting-help');
	if (!text) help?.remove();
	else if (!help) createHelpIcon(name, text);
	else if (help.getAttribute('aria-label') !== text) setTooltip(help, text, HELP_TOOLTIP);
}

/** 动态生成的设置项统一在标题旁显示说明图标，设置页卸载时停止监听。 */
export function watchSettingDescriptions(container: HTMLElement): () => void {
	const scan = () => container.querySelectorAll<HTMLElement>('.setting-item').forEach(syncHelp);
	scan();
	const observer = new MutationObserver(scan);
	observer.observe(container, { subtree: true, childList: true, characterData: true });
	return () => observer.disconnect();
}
