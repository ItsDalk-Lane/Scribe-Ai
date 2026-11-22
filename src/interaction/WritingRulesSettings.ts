import { ButtonComponent, FuzzySuggestModal, Notice, Setting, TextAreaComponent } from 'obsidian';
import type { App } from 'obsidian';
import { readWritingRule, saveWritingRule, WRITING_RULE_FILENAME, WritingRuleChangedError } from '../orchestration/context/writingRules';
import type { UiText } from './uiText';

class WritingRuleFolderPicker extends FuzzySuggestModal<string> {
	constructor(app: App, private readonly paths: string[], private readonly select: (path: string) => void) {
		super(app);
	}

	getItems(): string[] {
		return this.paths;
	}

	getItemText(path: string): string {
		return path;
	}

	onChooseItem(path: string): void {
		this.select(path);
	}
}

export function renderWritingRulesSettings(app: App, container: HTMLElement, text: UiText, vaultOnly = false): void {
	if (!vaultOnly) new Setting(container).setName(text.writingRules).setDesc(text.writingRulesDescription).setHeading();

	const renderEditor = (parent: HTMLElement, label: string, folder?: string) => {
		const filePath = folder === undefined ? WRITING_RULE_FILENAME : `${folder}/${WRITING_RULE_FILENAME}`;
		const row = new Setting(parent).setName(label).setDesc(filePath);
		const save = new ButtonComponent(row.controlEl).setButtonText(text.save).setDisabled(true);
		const editor = new TextAreaComponent(parent).setDisabled(true);
		editor.inputEl.addClass('scribe-writing-rule-input');
		editor.inputEl.setAttribute('aria-label', label);
		editor.inputEl.rows = 4;
		let snapshot: string | undefined;
		let displayed = '';
		const setStoredValue = (value: string | undefined) => {
			snapshot = value;
			editor.setValue(value ?? '');
			displayed = editor.getValue();
		};
		const refreshSave = () => {
			const rule = editor.getValue();
			save.setDisabled(rule === displayed || (snapshot === undefined && !rule.trim()));
		};
		const loaded = readWritingRule(app.vault, folder).then((value) => {
			setStoredValue(value);
			editor.setDisabled(false).onChange(refreshSave);
		}).catch(() => { row.setDesc(`${filePath} · ${text.writingRuleReadFailed}`); });
		save.onClick(async () => {
			const rule = editor.getValue();
			editor.setDisabled(true);
			save.setDisabled(true);
			try {
				setStoredValue(await saveWritingRule(app.vault, folder, rule, snapshot));
				new Notice(text.writingRuleSaved);
			} catch (error) {
				new Notice(error instanceof WritingRuleChangedError ? text.writingRuleChanged : text.saveFailed);
			} finally {
				editor.setDisabled(false);
				refreshSave();
			}
		});
		return () => {
			void loaded.then(() => {
				const input = editor.inputEl;
				input.ownerDocument.defaultView?.requestAnimationFrame(() => input.focus());
			});
		};
	};

	renderEditor(container, text.vaultWritingRules);
	if (vaultOnly) return;

	const section = new Setting(container).setName(text.folderWritingRules);
	const list = container.createDiv();
	const editors = new Map<string, () => void>();
	const addFolder = (folder: string) => {
		const existing = editors.get(folder);
		if (existing) return existing;
		const wrapper = list.createDiv();
		const focus = renderEditor(wrapper, folder, folder);
		editors.set(folder, focus);
		return focus;
	};
	section.addButton((button) => button.setButtonText(text.chooseRuleFolder).onClick(() => {
		const paths = app.vault.getAllFolders(false).map(({ path }) => path).sort();
		const picker = new WritingRuleFolderPicker(app, paths, (path) => addFolder(path)());
		picker.setPlaceholder(text.chooseRuleFolder);
		picker.open();
	}));
	const folders = app.vault.getMarkdownFiles().flatMap(({ name, parent }) =>
		name === WRITING_RULE_FILENAME && parent && !parent.isRoot() ? [parent.path] : []);
	for (const folder of folders.sort()) addFolder(folder);
}
