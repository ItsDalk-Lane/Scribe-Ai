import { App, ButtonComponent, Modal } from 'obsidian';

export function confirmAction(
	app: App,
	options: {
		title: string;
		message: string;
		confirmText: string;
		cancelText: string;
		onConfirm: () => void | Promise<void>;
	},
): void {
	const modal = new Modal(app);
	modal.titleEl.setText(options.title);
	modal.contentEl.createEl('p', { text: options.message });
	const actions = modal.contentEl.createDiv({ cls: 'scribe-modal-actions is-end' });
	new ButtonComponent(actions).setButtonText(options.cancelText).onClick(() => modal.close());
	new ButtonComponent(actions).setClass('mod-warning').setButtonText(options.confirmText).onClick(async () => {
		await options.onConfirm();
		modal.close();
	});
	modal.open();
}
