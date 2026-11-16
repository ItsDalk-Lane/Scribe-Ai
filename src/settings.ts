import { App, PluginSettingTab, Setting } from 'obsidian';
import type ScribeAiPlugin from './main';

export interface ScribeAiSettings {
	enabled: boolean;
}

export const DEFAULT_SETTINGS: ScribeAiSettings = {
	enabled: true,
};

export class ScribeAiSettingTab extends PluginSettingTab {
	plugin: ScribeAiPlugin;

	constructor(app: App, plugin: ScribeAiPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Enabled').addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
				this.plugin.settings.enabled = value;
				await this.plugin.saveSettings();
			}),
		);
	}
}
