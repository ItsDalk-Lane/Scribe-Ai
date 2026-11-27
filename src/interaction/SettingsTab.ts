import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ScribeAiPlugin from '../main';
import type { ChatLocation } from '../types';
import { renderDataDirectorySettings } from './dataDirectorySettings';
import { renderModelSettings } from './ModelSettings';
import { renderMcpSettings } from './McpSettings';
import { renderServiceSettings } from './ServiceSettings';
import { renderSubagentSettings } from './SubagentSettings';
import { CustomInstructionsEditor, renderWritingRulesSettings } from './WritingRulesSettings';
import { renderContextPreferences } from './ContextPreferences';
import { subagentSettingsText } from './subagentSettingsText';
import { uiText } from './uiText';
import { tr } from './skills/dialog';
import { renderSkillSettings } from './skills/skillUi';
import type { SkillPageHandle } from './skills/skillUi';
import { watchSettingDescriptions } from './settingsHelp';

type SettingsSection = 'general' | 'personalization' | 'models' | 'services' | 'skills' | 'subagents' | 'mcp' | 'advanced';
const SECTIONS: readonly SettingsSection[] = ['general', 'personalization', 'models', 'services', 'skills', 'subagents', 'mcp', 'advanced'];

/** 设置界面：通用、模型配置与高级网络/诊断分开，避免主配置页过载 */
export class ScribeAiSettingTab extends PluginSettingTab {
	private activeSection: SettingsSection = 'general';
	private skillPage?: SkillPageHandle;
	private instructionsEditor?: CustomInstructionsEditor;
	private mcpDispose?: () => void;
	private servicesDispose?: () => void;
	private settingDescriptionsDispose?: () => void;

	constructor(
		app: App,
		private plugin: ScribeAiPlugin,
	) {
		super(app, plugin);
		plugin.register(() => this.instructionsEditor?.dispose());
	}

	display(): void {
		const { containerEl } = this;
		this.skillPage?.dispose();
		this.skillPage = undefined;
		this.mcpDispose?.();
		this.mcpDispose = undefined;
		this.servicesDispose?.();
		this.servicesDispose = undefined;
		this.settingDescriptionsDispose?.();
		containerEl.empty();
		this.settingDescriptionsDispose = watchSettingDescriptions(containerEl);

		const settings = this.plugin.services.settings;
		const text = uiText();
		const skillsTab = tr('技能', 'Skills');
		const servicesTab = tr('服务', 'Services');
		const subagentsTab = subagentSettingsText().tab;
		const rendered = new Set<SettingsSection>();
		const tabList = containerEl.createDiv({
			cls: 'scribe-settings-tabs',
			attr: { role: 'tablist', 'aria-label': `${text.generalTab} / ${text.personalizationTab} / ${text.modelsTab} / ${servicesTab} / ${skillsTab} / ${subagentsTab} / MCP / ${text.advancedTab}` },
		});
		const panels: Record<SettingsSection, HTMLDivElement> = {
			general: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-general' },
			}),
			personalization: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-personalization', 'aria-labelledby': 'scribe-ai-settings-tab-personalization' },
			}),
			models: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-models' },
			}),
			services: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-services', 'aria-labelledby': 'scribe-ai-settings-tab-services' },
			}),
			skills: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-skills' },
			}),
			subagents: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-subagents' },
			}),
			mcp: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-mcp', 'aria-labelledby': 'scribe-ai-settings-tab-mcp' },
			}),
			advanced: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-advanced' },
			}),
		};
		const buttons: Record<SettingsSection, HTMLDivElement> = {
			general: tabList.createDiv({
				cls: 'scribe-settings-tab',
				text: text.generalTab,
				attr: { role: 'tab', id: 'scribe-ai-settings-tab-general', 'aria-controls': 'scribe-ai-settings-general' },
			}),
			personalization: tabList.createDiv({
				cls: 'scribe-settings-tab',
				text: text.personalizationTab,
				attr: { role: 'tab', id: 'scribe-ai-settings-tab-personalization', 'aria-controls': 'scribe-ai-settings-personalization' },
			}),
			models: tabList.createDiv({
				cls: 'scribe-settings-tab',
				text: text.modelsTab,
				attr: { role: 'tab', id: 'scribe-ai-settings-tab-models', 'aria-controls': 'scribe-ai-settings-models' },
			}),
			services: tabList.createDiv({
				cls: 'scribe-settings-tab',
				text: servicesTab,
				attr: { role: 'tab', id: 'scribe-ai-settings-tab-services', 'aria-controls': 'scribe-ai-settings-services' },
			}),
			skills: tabList.createDiv({
				cls: 'scribe-settings-tab',
				text: skillsTab,
				attr: { role: 'tab', id: 'scribe-ai-settings-tab-skills', 'aria-controls': 'scribe-ai-settings-skills' },
			}),
			subagents: tabList.createDiv({
				cls: 'scribe-settings-tab',
				text: subagentsTab,
				attr: { role: 'tab', id: 'scribe-ai-settings-tab-subagents', 'aria-controls': 'scribe-ai-settings-subagents' },
			}),
			mcp: tabList.createDiv({
				cls: 'scribe-settings-tab',
				text: 'MCP',
				attr: { role: 'tab', id: 'scribe-ai-settings-tab-mcp', 'aria-controls': 'scribe-ai-settings-mcp' },
			}),
			advanced: tabList.createDiv({
				cls: 'scribe-settings-tab',
				text: text.advancedTab,
				attr: { role: 'tab', id: 'scribe-ai-settings-tab-advanced', 'aria-controls': 'scribe-ai-settings-advanced' },
			}),
		};

		const renderGeneral = () => {
			const generalGroup = panels.general.createDiv({ cls: 'scribe-settings-group' });
			generalGroup.createDiv({ cls: 'scribe-settings-group-title', text: text.generalTab });
			new Setting(generalGroup)
				.setName(text.chatLocation)
				.setDesc(text.chatLocationDescription)
				.addDropdown((dropdown) =>
					dropdown
						.addOption('right-sidebar', text.rightSidebar)
						.addOption('left-sidebar', text.leftSidebar)
						.addOption('editor-tab', text.editorTab)
						.setValue(settings.chatLocation)
						.onChange(async (value) => {
							settings.chatLocation = value as ChatLocation;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(generalGroup)
				.setName(text.confirmChatRemoval)
				.setDesc(text.confirmChatRemovalDescription)
				.addToggle((toggle) =>
					toggle.setValue(settings.confirmChatRemoval).onChange(async (value) => {
						settings.confirmChatRemoval = value;
						await this.plugin.saveSettings();
					}),
				);
		};

		const renderModels = () => {
			renderModelSettings(this.app, panels.models, this.plugin, text);
		};
		const editInstructions = () => {
			if (this.instructionsEditor) return;
			this.instructionsEditor = new CustomInstructionsEditor(this.app, text, () => { this.instructionsEditor = undefined; });
			this.instructionsEditor.open();
		};

		const renderAdvanced = () => {
			const panel = panels.advanced;
			const network = panel.createDiv({ cls: 'scribe-settings-group' });
			network.createDiv({ cls: 'scribe-settings-group-title', text: tr('网络连接', 'Network') });
			let proxyInput: HTMLInputElement;
			const saveProxy = async (forget = false) => {
				try {
					await this.plugin.saveProxy(forget ? settings.communication.proxyUrl : proxyInput.value, forget);
					proxyInput.value = settings.communication.proxyUrl;
					new Notice(tr('代理设置已保存。', 'Proxy settings saved.'));
				} catch {
					new Notice(tr('无法保存代理设置，请检查地址或 Obsidian 密钥库。', 'Could not save the proxy. Check the address or Obsidian Secret Storage.'));
				}
			};
			new Setting(network)
				.setName(text.proxyUrl)
				.setDesc(text.proxyDescription)
				.addText((input) => { proxyInput = input.setValue(settings.communication.proxyUrl).inputEl; })
				.addButton((button) => button.setButtonText(tr('保存代理', 'Save proxy')).onClick(() => saveProxy()))
				.addButton((button) => button.setButtonText(tr('解除代理认证关联', 'Unlink proxy credentials')).onClick(() => saveProxy(true)));

			const data = panel.createDiv({ cls: 'scribe-settings-group' });
			renderDataDirectorySettings(data, this.plugin);
			new Setting(data)
				.setName(tr('当前插件版本', 'Current plugin version'))
				.controlEl.createSpan({ text: this.plugin.manifest.version });
		};

		const updateSkillWarning = (count: number) => {
			if (!buttons.skills.isConnected) return;
			buttons.skills.toggleClass('has-skill-warning', count > 0);
			buttons.skills.setAttribute('aria-label', count ? skillsTab + ' · ' + tr('部分技能加载失败', 'Some skills failed to load') : skillsTab);
			buttons.skills.title = count ? tr('部分技能加载失败', 'Some skills failed to load') : '';
		};
		void this.plugin.services.orchestration.skills.library.list().then((skills) => updateSkillWarning(skills.filter((s) => s.error).length)).catch(() => {});
		const activate = (section: SettingsSection, focus = false) => {
			if (this.activeSection === 'services' && section !== 'services') {
				this.servicesDispose?.();
				this.servicesDispose = undefined;
				panels.services.empty();
				rendered.delete('services');
			}
			this.activeSection = section;
			if (!rendered.has(section)) {
				if (section === 'general') renderGeneral();
				else if (section === 'personalization') {
					renderWritingRulesSettings(panels.personalization, text, editInstructions);
					renderContextPreferences(panels.personalization, this.plugin);
				}
				else if (section === 'models') renderModels();
				else if (section === 'services') this.servicesDispose = renderServiceSettings(panels.services, this.plugin);
				else if (section === 'skills') this.skillPage = renderSkillSettings(this.plugin, panels.skills, updateSkillWarning);
				else if (section === 'subagents') renderSubagentSettings(panels.subagents, this.plugin, text);
				else if (section === 'mcp') this.mcpDispose = renderMcpSettings(panels.mcp, this.plugin);
				else renderAdvanced();
				rendered.add(section);
			}
			for (const key of SECTIONS) {
				const selected = key === section;
				buttons[key].toggleClass('is-active', selected);
				buttons[key].setAttribute('aria-selected', String(selected));
				buttons[key].tabIndex = selected ? 0 : -1;
				panels[key].hidden = !selected;
			}
			if (focus) buttons[section].focus();
		};

		const navigate = (section: SettingsSection, focus = false) => {
			if (this.activeSection !== 'skills' || section === 'skills' || !this.skillPage) { activate(section, focus); return; }
			void this.skillPage.beforeLeave().then(() => { if (containerEl.isConnected) activate(section, focus); }).catch(() => {});
		};
		for (const section of SECTIONS) {
			buttons[section].addEventListener('click', () => navigate(section));
			buttons[section].addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					navigate(section, true);
					return;
				}
				if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
				event.preventDefault();
				const index = SECTIONS.indexOf(section);
				const next = event.key === 'Home'
					? SECTIONS[0] ?? 'general'
					: event.key === 'End'
						? SECTIONS[SECTIONS.length - 1] ?? 'advanced'
						: SECTIONS[(index + (event.key === 'ArrowRight' ? 1 : SECTIONS.length - 1)) % SECTIONS.length] ?? 'general';
				navigate(next, true);
			});
		}

		activate(this.activeSection);
	}

	hide(): void {
		this.skillPage?.dispose();
		this.skillPage = undefined;
		this.mcpDispose?.();
		this.mcpDispose = undefined;
		this.servicesDispose?.();
		this.servicesDispose = undefined;
		this.settingDescriptionsDispose?.();
		this.settingDescriptionsDispose = undefined;
		super.hide();
	}
}
