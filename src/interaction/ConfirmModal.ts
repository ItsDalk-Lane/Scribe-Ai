import { App, ButtonComponent, Modal } from 'obsidian';

export function confirmAction(
	app: App,
	options: {
		title: string;
		message: string;
		confirmText: string;
		cancelText: string;
		onConfirm: () => void | Promise<void>;
		onClose?: () => void;
		/** 可选勾选框；何时生效由调用方决定。 */
		checkbox?: { label: string; checked: boolean; onChange: (checked: boolean) => void | Promise<void> };
	},
) {
	const modal = new Modal(app);
	modal.titleEl.setText(options.title);
	modal.contentEl.createEl('p', { text: options.message });
	if (options.checkbox) {
		const label = modal.contentEl.createEl('label', { cls: 'scribe-confirm-checkbox' });
		const box = label.createEl('input', { type: 'checkbox' });
		box.checked = options.checkbox.checked;
		label.createSpan({ text: options.checkbox.label });
		const { onChange } = options.checkbox;
		box.addEventListener('change', () => void onChange(box.checked));
	}
	const actions = modal.contentEl.createDiv({ cls: 'scribe-modal-actions is-end' });
	const cancel = new ButtonComponent(actions).setButtonText(options.cancelText).onClick(() => modal.close());
	const confirm = new ButtonComponent(actions).setClass('mod-warning').setButtonText(options.confirmText).onClick(async () => {
		confirm.setDisabled(true);
		try {
			await options.onConfirm();
			modal.close();
		} finally {
			confirm.setDisabled(false);
		}
	});
	modal.onOpen = () => cancel.buttonEl.focus({ preventScroll: true });
	if (options.onClose) modal.onClose = options.onClose;
	modal.open();
	return () => modal.close();
}
