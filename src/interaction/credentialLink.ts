import { SecretComponent, setIcon, type App } from 'obsidian';
import type { UiText } from './uiText';

export function renderCredentialLink(app: App, parent: HTMLElement, name: HTMLElement | null, options: {
	text: Pick<UiText, 'credentialLink' | 'credentialLinked' | 'credentialUnlink'>;
	read: () => string;
	change: (id: string) => void | Promise<void>;
	isLinked?: () => boolean;
}): void {
	const { text, read, change, isLinked } = options;
	const dot = name?.createSpan({ cls: 'scribe-secret-dot', attr: { 'aria-hidden': 'true' } });
	const row = parent.createDiv({ cls: 'scribe-secret-row' });
	const host = row.createDiv({ cls: 'scribe-secret-host' });
	const picker = new SecretComponent(app, host);
	const link = row.createEl('button', { cls: 'scribe-secret-button', attr: { type: 'button' } });
	const unlink = row.createEl('button', {
		cls: 'scribe-secret-unlink', attr: { type: 'button', 'aria-label': text.credentialUnlink },
	});
	setIcon(unlink, 'trash-2');

	const paint = () => {
		const id = read();
		picker.setValue(id);
		const linked = isLinked?.() ?? Boolean(id && app.secretStorage.getSecret(id));
		link.setText(linked ? text.credentialLinked : text.credentialLink);
		link.toggleClass('is-linked', linked);
		unlink.toggleClass('scribe-hidden', !linked);
		dot?.toggleClass('scribe-hidden', !linked);
	};
	const update = async (id: string) => {
		link.disabled = unlink.disabled = true;
		try {
			await change(id);
		} finally {
			paint();
			link.disabled = unlink.disabled = false;
		}
	};
	link.addEventListener('click', () => host.querySelector('button')?.click());
	picker.onChange((id) => update(id ?? ''));
	unlink.addEventListener('click', () => {
		void update('').then(() => link.focus());
	});
	paint();
}
