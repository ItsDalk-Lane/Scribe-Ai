import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import { credentialIdForProvider } from '../communication/credentials';
import type ScribeAiPlugin from '../main';
import { uiText } from './uiText';

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
		const text = uiText();
		let credentialComponent: SecretComponent | undefined;
		const credentialId = () => {
			const configured = settings.communication.credentialIds[settings.providerId];
			if (configured) return configured;
			return /^[a-z0-9][a-z0-9-]*$/.test(settings.providerId)
				? credentialIdForProvider(settings.providerId)
				: 'scribe-ai-provider';
		};

		new Setting(containerEl).setName(text.enableAgent).addToggle((toggle) =>
			toggle.setValue(settings.enabled).onChange(async (value) => {
				settings.enabled = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName(text.provider)
			.setDesc(text.providerDescription)
			.addText((text) =>
				text.setValue(settings.providerId).onChange(async (value) => {
					settings.providerId = value.trim();
					if (credentialComponent && /^[a-z0-9][a-z0-9-]*$/.test(settings.providerId)) {
						credentialComponent.setValue(credentialId());
					}
					await this.plugin.saveSettings();
				}),
			);

		const credentialSetting = new Setting(containerEl)
			.setName(text.credential)
			.setDesc(text.credentialDescription);
		credentialComponent = new SecretComponent(this.app, credentialSetting.controlEl);
		credentialComponent.setValue(credentialId());
		credentialComponent.onChange(async (value) => {
			if (!settings.providerId) return;
			if (value) settings.communication.credentialIds[settings.providerId] = value;
			else delete settings.communication.credentialIds[settings.providerId];
			await this.plugin.saveSettings();
		});

		new Setting(containerEl)
			.setName(text.proxyUrl)
			.setDesc(text.proxyDescription)
			.addText((text) =>
				text.setValue(settings.communication.proxyUrl).onChange(async (value) => {
					settings.communication.proxyUrl = value.trim();
					this.plugin.services.communication.transport.configure(settings.communication);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(text.model)
			.setDesc(text.modelDescription)
			.addText((text) =>
				text.setValue(settings.model).onChange(async (value) => {
					settings.model = value.trim();
					await this.plugin.saveSettings();
				}),
			);
	}
}
