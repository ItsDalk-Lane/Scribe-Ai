import { App, PluginSettingTab, Setting } from 'obsidian';
import type ScribeAiPlugin from '../main';
import type { ChatLocation } from '../types';
import { renderModelSettings } from './ModelSettings';
import { uiText } from './uiText';

type SettingsSection = 'general' | 'models' | 'advanced';
const SECTIONS: readonly SettingsSection[] = ['general', 'models', 'advanced'];

/** 设置界面：通用、模型配置与高级网络/诊断分开，避免主配置页过载 */
export class ScribeAiSettingTab extends PluginSettingTab {
	private activeSection: SettingsSection = 'general';
	private diagnosticsDispose?: () => void;

	constructor(
		app: App,
		private plugin: ScribeAiPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		this.diagnosticsDispose?.();
		this.diagnosticsDispose = undefined;
		containerEl.empty();

		const settings = this.plugin.services.settings;
		const transport = this.plugin.services.communication.transport;
		const text = uiText();
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
			attr: { role: 'tablist', 'aria-label': `${text.generalTab} / ${text.modelsTab} / ${text.advancedTab}` },
		});
		const panels: Record<SettingsSection, HTMLDivElement> = {
			general: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-general' },
			}),
			models: containerEl.createDiv({
				cls: 'scribe-settings-panel',
				attr: { role: 'tabpanel', id: 'scribe-ai-settings-models' },
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
			models: tabList.createDiv({
				cls: 'scribe-settings-tab',
				text: text.modelsTab,
				attr: { role: 'tab', id: 'scribe-ai-settings-tab-models', 'aria-controls': 'scribe-ai-settings-models' },
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
				.setName(text.diagnostics)
				.setHeading()
				.addButton((button) => button.onClick(renderDiagnostics).setButtonText(text.refresh));
			panel.createEl('p', { cls: 'scribe-settings-description', text: text.diagnosticsDescription });
			diagnosticsList = panel.createDiv({ cls: 'scribe-diagnostic-list' });
			renderDiagnostics();
		};

		const activate = (section: SettingsSection, focus = false) => {
			this.activeSection = section;
			if (!rendered.has(section)) {
				if (section === 'general') renderGeneral();
				else if (section === 'models') renderModels();
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

		for (const section of SECTIONS) {
			buttons[section].addEventListener('click', () => activate(section));
			buttons[section].addEventListener('keydown', (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					activate(section, true);
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
				activate(next, true);
			});
		}

		activate(this.activeSection);
	}

	hide(): void {
		this.diagnosticsDispose?.();
		this.diagnosticsDispose = undefined;
		super.hide();
	}
}
