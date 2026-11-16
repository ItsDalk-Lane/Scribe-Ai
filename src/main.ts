import { Notice, Plugin } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	ScribeAiSettings,
	ScribeAiSettingTab,
} from './settings';

export default class ScribeAiPlugin extends Plugin {
	settings!: ScribeAiSettings;

	async onload() {
		await this.loadSettings();

		// shortcut: placeholder command, replace it with the first real feature
		this.addCommand({
			id: 'placeholder',
			name: 'Placeholder',
			callback: () => new Notice('Scribe AI has no feature wired up yet.'),
		});

		this.addSettingTab(new ScribeAiSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ScribeAiSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
