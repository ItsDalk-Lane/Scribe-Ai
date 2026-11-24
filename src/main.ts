import { Notice, Plugin } from 'obsidian';
import { CHAT_VIEW_ICON, CHAT_VIEW_TYPE, SIDE_CHAT_VIEW_TYPE, SUBAGENT_VIEW_TYPE } from './constants';
import { openGithubSkillReview, openSkillDraftReview } from './interaction/skills/skillUi';
import { skillNameTokens } from './skills/mentions';
import { ChatView } from './interaction/ChatView';
import { SideChatView } from './interaction/SideChatView';
import { SubagentView } from './interaction/SubagentView';
import { SubagentTabs } from './interaction/subagentTabs';
import { ScribeAiSettingTab } from './interaction/SettingsTab';
import { uiText } from './interaction/uiText';
import { updateChatThinking } from './orchestration/settings/thinking';
import { initializePluginStorage } from './orchestration/storage/pluginStorage';
import { createServices } from './services';
import { sweepSpillFiles } from './tools/support/spillCleanup';
import type { McpSettings } from './tools/external/mcpConfig';
import type { ScribeServices, ScribeSettings } from './types';

export default class ScribeAiPlugin extends Plugin {
	services!: ScribeServices;
	subagentTabs = new SubagentTabs(this.app.workspace);
	private settingsSave = Promise.resolve();
	private settingsListeners = new Set<() => void>();
	private writeSettings!: (settings: ScribeSettings) => Promise<void>;

	async onload() {
		const storage = await initializePluginStorage(this).catch((error: unknown) => {
			new Notice('新存储位置打不开，已保留旧数据。');
			throw error;
		});
		const { settings, conversations, localState, cache } = storage;
		this.writeSettings = storage.writeSettings;
		try {
			await storage.complete();
		} catch (error) {
			console.error('Scribe Ai 无法完成旧数据清理。', error);
			new Notice('旧数据暂时无法清理，下次启动时会重试。');
		}
		this.services = createServices(this.app, settings, this.manifest, conversations, localState, cache, () => this.saveSettings(), {
			draft: (...args) => openSkillDraftReview(this.app, ...args),
			install: (...args) => openGithubSkillReview(this.app, ...args),
		}, (next) => this.saveMcpSettings(next));
		this.app.workspace.onLayoutReady(() => this.services?.tools.mcp?.reconcile());
		queueMicrotask(() => {
			try { sweepSpillFiles({ cacheDirectory: cache, cleanupPeriodDays: settings.spillCleanupDays }); } catch { /* 清理失败时留待下次。 */ }
		});

		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.registerView(SIDE_CHAT_VIEW_TYPE, (leaf) => new SideChatView(leaf, this));
		this.registerView(SUBAGENT_VIEW_TYPE, (leaf) => new SubagentView(leaf, this));
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
		this.services?.tools.mcp?.dispose();
	}

	openSubagent(conversationId: string, agentId: string) {
		const agent = this.services.orchestration.sessions.subagents?.snapshot(conversationId).agents.find(({ id }) => id === agentId);
		const error = uiText().sideChatOpenFailed;
		void this.subagentTabs.open({ conversationId, agentId, name: agent?.name ?? agentId }, error)
			.catch(() => new Notice(error));
	}

	async openSkillChat({ kind, skillId, draft }: { kind: 'use' | 'create' | 'repair'; skillId?: string; draft: string }) {
		const skills = this.services.orchestration.skills;
		const scope = skills.scope();
		const entries = kind === 'repair' ? [] : await skills.list([], '', scope);
		const item = entries.find((s) => s.id === (skillId ?? skills.creatorPath));
		if (kind !== 'repair' && (!item || !item.enabled || !item.manual)) throw new Error('技能已变化，请刷新技能列表。');
		const token = item && '$' + item.name;
		const cleaned = item && (draft.trim() === '/' + item.name || draft.trim() === '$' + item.name) ? '' : draft;
		const existing = item && skillNameTokens(cleaned).find((t) => t.name === item.name);
		const instruction = token && !existing ? token + ' ' + cleaned : cleaned;
		const start = existing?.start ?? 0;
		await this.activateChatView();
		const view = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]?.view;
		if (!(view instanceof ChatView)) throw new Error('聊天窗口无法打开。');
		await view.openSkillDraft({ instruction, skillScope: scope, skillMentions: item && token ? [{ id: item.id, name: item.name,
			sourceLabel: item.sourceLabel, start, end: start + token.length }] : [] });
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
		await this.enqueueSettingsSave(async () => {
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
			await this.writeSettings({ ...settings, ...selected });
			// 写入期间如有更新的设置操作，保留其选择。
			if (selection?.keepDefault && hasModel()) {
				settings.thinkingByModel = thinkingByModel;
			} else if (settings.providerId === current.providerId && settings.model === current.model && (!selection || hasModel())) {
				Object.assign(settings, selected);
			}
		});
	}

	async saveSlashPresets(update: (current: NonNullable<ScribeSettings['slashPresets']>) => NonNullable<ScribeSettings['slashPresets']>): Promise<void> {
		await this.enqueueSettingsSave(async () => {
			const { settings } = this.services;
			const slashPresets = update(settings.slashPresets?.slice() ?? []);
			await this.writeSettings({ ...settings, slashPresets });
			settings.slashPresets = slashPresets;
		});
	}

	private async saveMcpSettings(mcp: McpSettings): Promise<void> {
		await this.enqueueSettingsSave(async () => {
			const { settings } = this.services;
			await this.writeSettings({ ...settings, mcp });
			settings.mcp = mcp;
		});
	}

	private async enqueueSettingsSave(write: () => Promise<void>): Promise<void> {
		const save = this.settingsSave.then(write);
		this.settingsSave = save.catch(() => undefined);
		try {
			await save;
		} finally {
			this.settingsListeners.forEach((listener) => listener());
		}
	}
}
