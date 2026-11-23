import { App, PluginSettingTab, Setting } from 'obsidian';
import type ScribeAiPlugin from '../main';
import type { ChatLocation } from '../types';
import { renderModelSettings } from './ModelSettings';
import { renderMcpSettings } from './McpSettings';
import { renderSubagentSettings } from './SubagentSettings';
import { CustomInstructionsEditor, renderWritingRulesSettings } from './WritingRulesSettings';
import { subagentSettingsText } from './subagentSettingsText';
import { uiText } from './uiText';
import { tr } from './skills/dialog';
import { renderSkillSettings } from './skills/skillUi';
import type { SkillPageHandle } from './skills/skillUi';

type SettingsSection = 'general' | 'personalization' | 'models' | 'skills' | 'subagents' | 'mcp' | 'advanced';
const SECTIONS: readonly SettingsSection[] = ['general', 'personalization', 'models', 'skills', 'subagents', 'mcp', 'advanced'];

/** 设置界面：通用、模型配置与高级网络/诊断分开，避免主配置页过载 */
export class ScribeAiSettingTab extends PluginSettingTab {
	private activeSection: SettingsSection = 'general';
	private skillPage?: SkillPageHandle;
	private instructionsEditor?: CustomInstructionsEditor;
	private mcpDispose?: () => void;
	private diagnosticsDispose?: () => void;

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
		this.diagnosticsDispose?.();
		this.diagnosticsDispose = undefined;
		containerEl.empty();

		const settings = this.plugin.services.settings;
		const transport = this.plugin.services.communication.transport;
		const text = uiText();
		const skillsTab = tr('技能', 'Skills');
		const subagentsTab = subagentSettingsText().tab;
		const phaseLabels = {
			connecting: text.phaseConnecting,
			streaming: text.phaseStreaming,
			done: text.phaseDone,
			error: text.phaseError,
		} as const;
		const rendered = new Set<SettingsSection>();
		let diagnosticsList: HTMLDivElement | undefined;

		const tabList = containerEl.createDiv({
			cls: 'scribe-settings-tabs',
			attr: { role: 'tablist', 'aria-label': `${text.generalTab} / ${text.personalizationTab} / ${text.modelsTab} / ${skillsTab} / ${subagentsTab} / MCP / ${text.advancedTab}` },
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

		const renderDiagnostics = () => {
			if (!diagnosticsList) return;
			diagnosticsList.empty();
			const entries = transport.logs().slice(-30).reverse();
			if (!entries.length) {
				diagnosticsList.createEl('p', { text: text.noDiagnostics });
				return;
			}
			for (const entry of entries) {
				const row = diagnosticsList.createDiv({ cls: 'scribe-diagnostic-entry' });
				const meta = row.createDiv({ cls: 'scribe-diagnostic-meta' });
				meta.createSpan({ text: new Date(entry.at).toLocaleTimeString() });
				meta.createSpan({ cls: `scribe-diagnostic-phase is-${entry.phase}`, text: phaseLabels[entry.phase] });
				if (entry.status) meta.createSpan({ text: String(entry.status) });
				if (entry.proxy) meta.createSpan({ text: `${text.proxy}: ${entry.proxy}` });
				const endpoint = [entry.method, `${entry.origin ?? ''}${entry.path ?? ''}`].filter(Boolean).join(' ');
				if (endpoint) row.createDiv({ cls: 'scribe-diagnostic-endpoint', text: endpoint });
				if (entry.error) row.createDiv({ cls: 'scribe-diagnostic-error', text: entry.error });
			}
		};

		const renderGeneral = () => {
			new Setting(panels.general)
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
			new Setting(panel)
				.setName(text.proxyUrl)
				.setDesc(text.proxyDescription)
				.addText((input) =>
					input.setValue(settings.communication.proxyUrl).onChange(async (value) => {
						settings.communication.proxyUrl = value.trim();
						transport.configure(settings.communication);
						await this.plugin.saveSettings();
					}),
				);

			new Setting(panel)
				.setName(text.spillCleanupDays)
				.setDesc(text.spillCleanupDaysDescription)
				.addText((input) => {
					input.inputEl.type = 'number';
					input.inputEl.min = '0';
					input.inputEl.step = '1';
					input.setValue(String(settings.spillCleanupDays));
					input.onChange(async (value) => {
						const days = Number(value);
						if (!Number.isSafeInteger(days) || days < 0) return;
						settings.spillCleanupDays = days;
						await this.plugin.saveSettings();
					});
					input.inputEl.addEventListener('blur', () => {
						const days = Number(input.inputEl.value);
						if (!Number.isSafeInteger(days) || days < 0) input.setValue(String(settings.spillCleanupDays));
					});
				});

			new Setting(panel)
				.setName(text.diagnostics)
				.setHeading()
				.addButton((button) => button.onClick(renderDiagnostics).setButtonText(text.refresh));
			panel.createEl('p', { cls: 'scribe-settings-description', text: text.diagnosticsDescription });
			diagnosticsList = panel.createDiv({ cls: 'scribe-diagnostic-list' });
			renderDiagnostics();
		};

		const updateSkillWarning = (count: number) => {
			if (!buttons.skills.isConnected) return;
			buttons.skills.toggleClass('has-skill-warning', count > 0);
			buttons.skills.setAttribute('aria-label', count ? skillsTab + ' · ' + tr('部分技能加载失败', 'Some skills failed to load') : skillsTab);
			buttons.skills.title = count ? tr('部分技能加载失败', 'Some skills failed to load') : '';
		};
		void this.plugin.services.orchestration.skills.library.list().then((skills) => updateSkillWarning(skills.filter((s) => s.error).length)).catch(() => {});
		const activate = (section: SettingsSection, focus = false) => {
			this.activeSection = section;
			if (!rendered.has(section)) {
				if (section === 'general') renderGeneral();
				else if (section === 'personalization') renderWritingRulesSettings(panels.personalization, text, editInstructions);
				else if (section === 'models') renderModels();
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
			if (section === 'advanced') {
				renderDiagnostics();
				if (!this.diagnosticsDispose) this.diagnosticsDispose = transport.onStatus(renderDiagnostics);
			} else {
				this.diagnosticsDispose?.();
				this.diagnosticsDispose = undefined;
			}
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
		this.diagnosticsDispose?.();
		this.diagnosticsDispose = undefined;
		super.hide();
	}
}
