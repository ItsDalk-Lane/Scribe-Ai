import { Plugin } from 'obsidian';
import { CHAT_VIEW_ICON, CHAT_VIEW_TYPE, SIDE_CHAT_VIEW_TYPE } from './constants';
import { ChatView } from './interaction/ChatView';
import { SideChatView } from './interaction/SideChatView';
import { ScribeAiSettingTab } from './interaction/SettingsTab';
import { uiText } from './interaction/uiText';
import { normalizeSettings } from './orchestration/settings/defaults';
import { updateChatThinking } from './orchestration/settings/thinking';
import { createServices } from './services';
import type { ScribeServices, ScribeSettings } from './types';

export default class ScribeAiPlugin extends Plugin {
	services!: ScribeServices;
	private settingsSave = Promise.resolve();
	private settingsListeners = new Set<() => void>();

	async onload() {
		const settings = normalizeSettings((await this.loadData()) as Partial<ScribeSettings> | null);
		this.services = createServices(this.app, settings, this.manifest);

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.registerView(SIDE_CHAT_VIEW_TYPE, (leaf) => new SideChatView(leaf, this));
		this.app.workspace.onLayoutReady(() => this.app.workspace.detachLeavesOfType(SIDE_CHAT_VIEW_TYPE));
		this.register(() => this.app.workspace.detachLeavesOfType(SIDE_CHAT_VIEW_TYPE));

		this.addRibbonIcon(CHAT_VIEW_ICON, uiText().openChatCommand, () => {
			void this.activateChatView();
		});

		this.addCommand({
			id: 'open-chat',
			name: uiText().openChatCommand,
			callback: () => void this.activateChatView(),
		});

		this.addSettingTab(new ScribeAiSettingTab(this.app, this));
	}

	onunload() {
		this.services?.orchestration.sessions.dispose();
	}

	async activateChatView() {
		const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}

		const location = this.services.settings.chatLocation;
		const leaf = location === 'left-sidebar'
			? this.app.workspace.getLeftLeaf(false)
			: location === 'editor-tab'
				? this.app.workspace.getLeaf('tab')
				: this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	subscribeSettings(listener: () => void): () => void {
		this.settingsListeners.add(listener);
		return () => { this.settingsListeners.delete(listener); };
	}

	async saveSettings(selection?: Pick<ScribeSettings, 'providerId' | 'model'> & { thinkingLevel?: string; keepDefault?: boolean }): Promise<void> {
		const save = this.settingsSave.then(async () => {
			const { settings, communication } = this.services;
			const target = selection ?? settings;
			const current = { providerId: settings.providerId, model: settings.model };
			const hasModel = () => settings.providerModels[target.providerId]?.includes(target.model);
			if (selection && (!hasModel() || (!selection.keepDefault && selection.thinkingLevel !== undefined
				&& (selection.providerId !== current.providerId || selection.model !== current.model)))) {
				throw new Error(uiText().chatModelChanged);
			}
			const thinkingByModel = hasModel() ? updateChatThinking(settings, target, communication.models.thinkingOptions)
				: settings.thinkingByModel;
			const selected = selection?.keepDefault ? { ...current, thinkingByModel }
				: { providerId: target.providerId, model: target.model, thinkingByModel };
			await this.saveData({ ...settings, ...selected });
			// 写入期间如有更新的设置操作，保留其选择。
			if (selection?.keepDefault && hasModel()) {
				settings.thinkingByModel = thinkingByModel;
			} else if (settings.providerId === current.providerId && settings.model === current.model && (!selection || hasModel())) {
				Object.assign(settings, selected);
			}
		});
		this.settingsSave = save.catch(() => undefined);
		try {
			await save;
		} finally {
			this.settingsListeners.forEach((listener) => listener());
		}
	}
}
