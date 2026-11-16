import { Plugin, WorkspaceLeaf } from 'obsidian';
import { CHAT_VIEW_TYPE } from './constants';
import { ChatView } from './interaction/ChatView';
import { ScribeAiSettingTab } from './interaction/SettingsTab';
import { uiText } from './interaction/uiText';
import { normalizeSettings } from './orchestration/settings/defaults';
import { createServices } from './services';
import type { ScribeServices, ScribeSettings } from './types';

export default class ScribeAiPlugin extends Plugin {
	services!: ScribeServices;

	async onload() {
		const settings = normalizeSettings((await this.loadData()) as Partial<ScribeSettings> | null);
		this.services = createServices(this.app, settings);

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

		this.addCommand({
			id: 'open-chat',
			name: uiText().openChatCommand,
			callback: () => void this.activateChatView(),
		});

		this.addSettingTab(new ScribeAiSettingTab(this.app, this));
	}

	onunload() {}

	async activateChatView() {
		const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	async saveSettings() {
		await this.saveData(this.services.settings);
	}
}
