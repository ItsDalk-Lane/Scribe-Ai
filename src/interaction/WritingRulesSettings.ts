import { ButtonComponent, Modal, Notice, Setting, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { readWritingRule, saveWritingRule, WRITING_RULE_FILENAME, WritingRuleChangedError } from '../orchestration/context/writingRules';
import type { UiText } from './uiText';

export function renderWritingRulesSettings(container: HTMLElement, text: UiText, edit: () => void): void {
	new Setting(container).setName(text.customInstructions).setHeading();
	new Setting(container).setName(WRITING_RULE_FILENAME)
		.addButton((button) => button.setButtonText(text.editInstructions).onClick(edit));
}

export class CustomInstructionsEditor extends Modal {
	private readonly input: HTMLTextAreaElement;
	private readonly message: HTMLElement;
	private readonly saveButton: ButtonComponent;
	private readonly sourceButton: ButtonComponent;
	private snapshot: string | undefined;
	private displayed = '';
	private loaded = false;
	private saving = false;
	private showingSource = false;
	private decision?: Modal;
	private editorWindow?: Window;
	private reopenTimer?: number;
	private finished = false;

	constructor(app: App, private readonly text: UiText, private readonly onDone: () => void) {
		super(app);
		this.containerEl.addClass('scribe-instructions-overlay');
		this.modalEl.addClass('scribe-instructions-modal');
		this.setTitle(WRITING_RULE_FILENAME);
		this.modalEl.setAttribute('aria-label', text.customInstructions);

		const toolbar = this.contentEl.createDiv({ cls: 'scribe-instructions-toolbar' });
		const heading = toolbar.createDiv({ cls: 'scribe-instructions-heading' });
		const back = new ButtonComponent(heading).setClass('scribe-instructions-back')
			.setButtonText(text.back).onClick(() => this.close());
		const arrow = back.buttonEl.createSpan({ attr: { 'aria-hidden': 'true' } });
		setIcon(arrow, 'arrow-left');
		back.buttonEl.prepend(arrow);
		heading.createEl('h2', { text: WRITING_RULE_FILENAME });

		const actions = toolbar.createDiv({ cls: 'scribe-instructions-actions' });
		this.sourceButton = new ButtonComponent(actions).setButtonText(text.viewInstructionsSource).onClick(() => {
			this.showingSource = !this.showingSource;
			this.refresh();
			this.input.focus();
		});
		new ButtonComponent(actions).setButtonText(text.cancel).onClick(() => this.close());
		this.saveButton = new ButtonComponent(actions).setButtonText(text.save).setCta().onClick(() => void this.save());

		const body = this.contentEl.createDiv({ cls: 'scribe-instructions-body' });
		this.input = body.createEl('textarea', {
			cls: 'scribe-instructions-input',
			attr: { 'aria-label': text.customInstructions, placeholder: text.instructionsPlaceholder, spellcheck: 'false' },
		});
		this.input.addEventListener('input', () => this.refresh());
		this.message = body.createEl('p', { cls: 'scribe-instructions-error', attr: { role: 'alert' } });
		this.showError();
		this.refresh();
		void this.load();
	}

	onOpen(): void {
		this.editorWindow = this.containerEl.ownerDocument.defaultView ?? undefined;
		if (this.editorWindow !== window) this.editorWindow?.addEventListener('pagehide', this.onEditorWindowHide);
		if (this.loaded) this.input.focus();
	}

	onClose(): void {
		this.editorWindow?.removeEventListener('pagehide', this.onEditorWindowHide);
		this.editorWindow = undefined;
	}

	override close(): void {
		if (this.finished || this.saving || this.decision) return;
		if (!this.dirty) {
			this.dispose();
			return;
		}

		const prompt = new Modal(this.app).setTitle(this.text.unsavedInstructions);
		this.decision = prompt;
		const actions = prompt.contentEl.createDiv({ cls: 'scribe-modal-actions is-end' });
		new ButtonComponent(actions).setButtonText(this.text.discardInstructions)
			.onClick(() => this.dispose());
		const stay = new ButtonComponent(actions).setButtonText(this.text.continueEditing)
			.onClick(() => prompt.close());
		new ButtonComponent(actions).setButtonText(this.text.save).setCta().onClick(() => {
			prompt.close();
			void this.save();
		});
		prompt.onOpen = () => stay.buttonEl.focus();
		prompt.onClose = () => {
			this.decision = undefined;
			if (!this.finished && this.input.isConnected) this.input.focus();
		};
		prompt.open();
	}

	dispose(): void {
		if (this.finished) return;
		this.finished = true;
		window.clearTimeout(this.reopenTimer);
		this.decision?.close();
		super.close();
		this.onDone();
	}

	private readonly onEditorWindowHide = () => {
		this.decision?.close();
		super.close();
		// 设置窗口关闭后，把草稿和保存提示带回主窗口。
		this.reopenTimer = window.setTimeout(() => {
			if (this.finished) return;
			if (!this.dirty) {
				this.dispose();
				return;
			}
			this.open();
			this.close();
		}, 0);
	};

	private get dirty(): boolean {
		return this.loaded && this.input.value !== this.displayed;
	}

	private async load(): Promise<void> {
		try {
			this.snapshot = await readWritingRule(this.app.vault);
			if (this.finished) return;
			this.input.value = this.snapshot ?? '';
			this.displayed = this.input.value;
			this.loaded = true;
			this.refresh();
			if (this.input.isConnected) this.input.focus();
		} catch {
			if (!this.finished) this.showError(this.text.writingRuleReadFailed);
		}
	}

	private async save(): Promise<void> {
		if (!this.dirty || this.saving || this.finished) return;
		this.saving = true;
		this.showError();
		this.refresh();
		try {
			await saveWritingRule(this.app.vault, this.input.value, this.snapshot);
			if (this.finished) return;
			this.dispose();
			new Notice(this.text.writingRuleSaved);
		} catch (error) {
			if (!this.finished) this.showError(error instanceof WritingRuleChangedError ? this.text.writingRuleChanged : this.text.saveFailed);
		} finally {
			this.saving = false;
			if (!this.finished) this.refresh();
		}
	}

	private refresh(): void {
		this.input.disabled = !this.loaded;
		this.input.readOnly = this.showingSource || this.saving;
		this.input.toggleClass('is-source', this.showingSource);
		this.sourceButton.setDisabled(!this.loaded || this.saving)
			.setButtonText(this.showingSource ? this.text.continueEditing : this.text.viewInstructionsSource);
		this.saveButton.setDisabled(!this.dirty || this.saving);
	}

	private showError(message = ''): void {
		this.message.setText(message);
		this.message.hidden = !message;
	}
}
