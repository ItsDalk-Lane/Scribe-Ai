import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { tr } from './skills/dialog';

export const imagePreviewLabel = () => tr('放大图片', 'Enlarge image');

export function openImagePreview(app: App, source: string, label: string, trigger: HTMLElement, remote = false): () => void {
	const modal = new Modal(app).setTitle(label || tr('图片预览', 'Image preview'));
	modal.modalEl.addClass('scribe-image-preview-modal');
	let opened = true;
	modal.onOpen = () => {
		const image = modal.contentEl.createEl('img', { attr: { alt: label, referrerpolicy: 'no-referrer' } });
		image.addEventListener('error', () => {
			image.remove();
			modal.contentEl.createEl('p', {
				text: tr('图片无法加载，文件可能已移除或链接已失效。', 'Could not load the image. The file or link may no longer be available.'),
				attr: { role: 'status' },
			});
			if (remote) modal.contentEl.createEl('a', {
				text: tr('打开原链接', 'Open original link'), href: source,
				attr: { target: '_blank', rel: 'noopener noreferrer' },
			});
		}, { once: true });
		image.src = source;
	};
	modal.onClose = () => {
		opened = false;
		modal.contentEl.empty();
		queueMicrotask(() => {
			if (trigger.isConnected) trigger.focus({ preventScroll: true });
		});
	};
	modal.open();
	return () => { if (opened) modal.close(); };
}
