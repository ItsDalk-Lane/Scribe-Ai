import { App, PluginSettingTab, Setting } from 'obsidian';
import type ScribeAiPlugin from '../main';

/** 设置界面：模型认证信息归通信层，这里只放可见配置项 */
export class ScribeAiSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: ScribeAiPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings = this.plugin.services.settings;

		new Setting(containerEl).setName('Enable agent').addToggle((toggle) =>
			toggle.setValue(settings.enabled).onChange(async (value) => {
				settings.enabled = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Model service ID used for requests.')
			.addText((text) =>
				text.setValue(settings.providerId).onChange(async (value) => {
					settings.providerId = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Model name used for requests.')
			.addText((text) =>
				text.setValue(settings.model).onChange(async (value) => {
					settings.model = value.trim();
					await this.plugin.saveSettings();
				}),
			);
	}
}
