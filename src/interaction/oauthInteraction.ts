import type { App } from 'obsidian';
import { ButtonComponent, DropdownComponent, Modal, Notice } from 'obsidian';
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import type { UiText } from './uiText';

export interface OAuthInteraction extends AuthInteraction {
	close(): void;
}

class AuthPromptModal extends Modal {
	private settled = false;
	private failure: Error;
	private select: DropdownComponent | null = null;
	private input: HTMLInputElement | null = null;
	private readonly onAbort: () => void;

	constructor(
		app: App,
		private prompt: AuthPrompt,
		private text: UiText,
		private resolve: (value: string) => void,
		private reject: (error: Error) => void,
	) {
		super(app);
		this.failure = new Error(text.oauthLoginCancelled);
		this.onAbort = () => {
			const reason = prompt.signal?.reason as unknown;
			this.failure = reason instanceof Error ? reason : new Error(text.oauthLoginCancelled);
			this.close();
		};
	}

	onOpen(): void {
		this.titleEl.setText(this.text.oauthLogin);
		this.contentEl.createEl('p', { text: this.prompt.message });
		if (this.prompt.type === 'select') {
			this.select = new DropdownComponent(this.contentEl);
			for (const option of this.prompt.options) this.select.addOption(option.id, option.label);
		} else {
			this.input = this.contentEl.createEl('input', {
				cls: 'scribe-full-input',
				attr: {
					type: this.prompt.type === 'secret' ? 'password' : 'text',
					placeholder: this.prompt.placeholder ?? '',
				},
			});
			this.input.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter') return;
				event.preventDefault();
				this.submit();
			});
			this.input.focus();
		}
		const actions = this.contentEl.createDiv({ cls: 'scribe-modal-actions is-end' });
		new ButtonComponent(actions).setButtonText(this.text.cancel).onClick(() => this.close());
		new ButtonComponent(actions).setCta().setButtonText(this.text.submit).onClick(() => this.submit());
		this.prompt.signal?.addEventListener('abort', this.onAbort, { once: true });
		if (this.prompt.signal?.aborted) this.onAbort();
	}

	private submit(): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(this.select?.getValue() ?? this.input?.value ?? '');
		this.close();
	}

	onClose(): void {
		this.prompt.signal?.removeEventListener('abort', this.onAbort);
		if (!this.settled) {
			this.settled = true;
			this.reject(this.failure);
		}
		this.contentEl.empty();
	}
}

/** Obsidian adapter for pi-ai's provider-neutral login prompts and notifications. */
export function createOAuthInteraction(app: App, text: UiText, signal: AbortSignal): OAuthInteraction {
	const notices = new Set<Notice>();
	let progress: Notice | null = null;
	const notify = (message: string | DocumentFragment, persistent = false): void => {
		if (persistent) {
			const notice = new Notice(message, 0);
			notices.add(notice);
		} else if (progress) {
			progress.setMessage(message);
		} else {
			progress = new Notice(message);
			notices.add(progress);
		}
	};
	return {
		signal,
		prompt: (prompt) => new Promise<string>((resolve, reject) => {
			const signals = [signal, prompt.signal].filter((value): value is AbortSignal => Boolean(value));
			const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
			new AuthPromptModal(app, { ...prompt, signal: combined }, text, resolve, reject).open();
		}),
		notify: (event: AuthEvent) => {
			if (event.type === 'auth_url') {
				window.open(event.url);
				notify(`${event.instructions ?? text.oauthOpenPage}\n${event.url}`, true);
			} else if (event.type === 'device_code') {
				const win = app.workspace.containerEl.ownerDocument.defaultView ?? window;
				win.open(event.verificationUri);
				const notice = win.createFragment();
				const label = notice.createEl('label', { text: text.oauthDeviceCode });
				const code = label.createEl('input', { type: 'text', value: event.userCode });
				code.readOnly = true;
				code.addEventListener('focus', () => code.select());
				label.addEventListener('click', (event) => event.stopPropagation());
				notice.createEl('p', { text: event.verificationUri });
				notify(notice, true);
			} else {
				notify(event.message);
			}
		},
		close: () => {
			for (const notice of notices) notice.hide();
			notices.clear();
		},
	};
}
