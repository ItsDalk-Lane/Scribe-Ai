import { App, ButtonComponent, DropdownComponent, Modal, Notice, setIcon } from 'obsidian';
import { createCredentialStore } from '../communication/credentials';
import { createModelService } from '../communication/providers';
import type ScribeAiPlugin from '../main';
import { isThinkingLevel, THINKING_LEVEL_PRESETS } from '../orchestration/settings/thinking';
import type { ModelOverride, ModelProviderInfo } from '../types';
import { applyModelDraft, type ModelDraftChange } from './modelDraft';
import type { UiText } from './uiText';

const CONTEXT_PRESETS = [64000, 128000, 200000, 256000, 512000, 1000000];
const OUTPUT_PRESETS = [8000, 16000, 32000, 64000, 128000, 256000];
const DEFAULT_THINKING = ['minimal', 'low', 'medium', 'high'];
const DEFAULT_CONTEXT = 128000;
const DEFAULT_OUTPUT = 8000;
type Caps = { reasoning: boolean; tools: boolean };
type ModelConfigOptions = {
	onSaved: () => void;
	/** 从服务商弹窗打开时，模型修改随服务商一并保存或取消 */
	draft?: {
		models: string[];
		overrides: Record<string, ModelOverride>;
		save: (change: ModelDraftChange) => void;
	};
	providerBaseUrl?: string;
	providerProtocol?: string;
	providerCredentialId?: string;
	customProvider?: { label: string; baseUrl: string; protocol: string };
};

function formatTokens(tokens: number): string {
	if (!tokens) return '—';
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
	return `${Math.round(tokens / 1000)}K`;
}

function formField(container: HTMLElement, label: string): HTMLDivElement {
	const field = container.createDiv({ cls: 'scribe-form-field' });
	field.createEl('label', { text: label });
	return field.createDiv({ cls: 'scribe-form-control' });
}

export class ScribeModelConfigModal extends Modal {
	private draftModel: string;
	private draftBaseUrl: string;
	private draftProtocol: string;
	private draftContext: number;
	private draftMaxTokens: number;
	private caps: Caps;
	private draftThinking: string[];
	private initialThinking: string[];
	private defaultThinking: string[];
	private availableThinking: readonly string[];
	private catalog?: ModelProviderInfo['models'][number];
	private defaultBaseUrl: string;
	private defaultProtocol: string;
	private defaultContext: number;
	private defaultMaxTokens: number;
	private defaultCaps: Caps;
	private savedOverride?: ModelOverride;
	private testController: AbortController | null = null;

	constructor(
		app: App,
		private plugin: ScribeAiPlugin,
		private provider: ModelProviderInfo,
		private model: string,
		private text: UiText,
		private options: ModelConfigOptions,
	) {
		super(app);
		const settings = plugin.services.settings;
		this.catalog = provider.models.find((entry) => entry.id === model);
		const overrides = this.options.draft?.overrides ?? settings.modelOverrides[provider.id];
		const override = this.savedOverride = overrides?.[model];
		this.defaultBaseUrl = this.options.providerBaseUrl ?? (settings.communication.baseUrls[provider.id] || this.catalog?.baseUrl || provider.baseUrl);
		this.defaultProtocol = this.options.providerProtocol ?? (settings.communication.protocols[provider.id] || this.catalog?.api || provider.protocol);
		this.defaultContext = this.catalog?.contextWindow || DEFAULT_CONTEXT;
		this.defaultMaxTokens = this.catalog?.maxTokens || DEFAULT_OUTPUT;
		this.defaultCaps = { reasoning: Boolean(this.catalog?.requiresReasoning || this.catalog?.reasoning), tools: true };
		this.draftModel = model;
		this.draftBaseUrl = override?.baseUrl ?? this.defaultBaseUrl;
		this.draftProtocol = override?.protocol ?? this.defaultProtocol;
		this.draftContext = override?.contextWindow ?? this.defaultContext;
		this.draftMaxTokens = override?.maxTokens ?? this.defaultMaxTokens;
		this.caps = {
			reasoning: this.catalog?.requiresReasoning || (override?.capabilities?.reasoning ?? this.defaultCaps.reasoning),
			tools: override?.capabilities?.tools ?? true,
		};
		const levels = this.catalog?.thinkingLevels;
		this.defaultThinking = levels?.length ? levels : DEFAULT_THINKING;
		const supported = this.catalog?.requiresReasoning ? this.defaultThinking : ['off', ...this.defaultThinking];
		this.availableThinking = THINKING_LEVEL_PRESETS.filter((level) => (level !== 'off' && level !== 'minimal') || supported.includes(level));
		const saved = Array.isArray(override?.thinkingLevels) ? override.thinkingLevels : override?.thinkingLevel ? [override.thinkingLevel] : this.defaultThinking;
		this.initialThinking = this.draftThinking = [...new Set(saved.filter((level) => isThinkingLevel(level) && (
			supported.includes(level) || (override?.literalThinkingLevels && level !== 'off' && level !== 'minimal')
		)))];
	}

	onOpen(): void {
		this.modalEl.addClass('scribe-model-config-modal');
		this.contentEl.addClass('scribe-dialog-content');
		this.render();
	}

	onClose(): void {
		this.testController?.abort();
		this.contentEl.empty();
	}

	/** 与目录/服务商默认值的差异才是覆盖项；相同则不落盘 */
	private currentOverride(): ModelOverride {
		const override: ModelOverride = {};
		const baseUrl = this.draftBaseUrl.trim();
		if (baseUrl && baseUrl !== this.defaultBaseUrl) override.baseUrl = baseUrl;
		if (this.draftProtocol && this.draftProtocol !== this.defaultProtocol) override.protocol = this.draftProtocol;
		if (this.draftContext > 0 && this.draftContext !== this.defaultContext) override.contextWindow = this.draftContext;
		if (this.draftMaxTokens > 0 && this.draftMaxTokens !== this.defaultMaxTokens) override.maxTokens = this.draftMaxTokens;
		// 旧配置保留此前保存但尚未接入的输入、输出选项。
		if (this.savedOverride?.input) override.input = this.savedOverride.input;
		if (this.savedOverride?.output) override.output = this.savedOverride.output;
		const caps = { ...this.savedOverride?.capabilities };
		if (this.caps.reasoning !== this.defaultCaps.reasoning) caps.reasoning = this.caps.reasoning;
		else delete caps.reasoning;
		if (!this.caps.tools) caps.tools = false;
		else delete caps.tools;
		if (Object.keys(caps).length) override.capabilities = caps;
		if (this.caps.reasoning && (this.savedOverride?.literalThinkingLevels || this.draftThinking.join() !== this.defaultThinking.join())) {
			override.thinkingLevels = [...this.draftThinking];
			if (this.savedOverride?.literalThinkingLevels || this.draftThinking.join() !== this.initialThinking.join()) override.literalThinkingLevels = true;
		}
		return override;
	}

	private render(): void {
		this.contentEl.empty();
		const header = this.contentEl.createDiv({ cls: 'scribe-model-config-header' });
		const heading = header.createDiv({ cls: 'scribe-dialog-heading' });
		heading.createDiv({ cls: 'scribe-dialog-title', text: `${this.text.modelConfiguration} · ${this.draftModel}` });
		const label = this.plugin.services.settings.communication.providerNames[this.provider.id] ?? this.provider.label;
		heading.createDiv({ cls: 'scribe-dialog-muted', text: label });
		const status = header.createSpan({ cls: 'scribe-connection-status' });
		const testButton = new ButtonComponent(header).setButtonText(this.text.testConnection);
		testButton.onClick(() => void this.testConnection(testButton, status));

		const scroll = this.contentEl.createDiv({ cls: 'scribe-dialog-scroll scribe-model-config-body' });
		const fields = scroll.createDiv({ cls: 'scribe-dialog-fields' });

		const modelControl = formField(fields, this.text.modelId);
		const modelInput = modelControl.createEl('input', {
			cls: 'scribe-full-input',
			attr: { type: 'text', value: this.draftModel, placeholder: this.text.enterModelId },
		});
		modelInput.addEventListener('input', () => {
			this.draftModel = modelInput.value.trim();
		});

		const baseUrlControl = formField(fields, this.text.baseUrl);
		const baseUrlInput = baseUrlControl.createEl('input', {
			cls: 'scribe-full-input',
			attr: { type: 'text', value: this.draftBaseUrl, placeholder: this.defaultBaseUrl || this.text.baseUrlNone },
		});
		baseUrlInput.addEventListener('input', () => {
			this.draftBaseUrl = baseUrlInput.value;
		});

		const protocols = [...this.provider.protocols];
		if (this.draftProtocol && !protocols.includes(this.draftProtocol)) protocols.push(this.draftProtocol);
		const protocolControl = formField(fields, this.text.protocol);
		const protocolDropdown = new DropdownComponent(protocolControl);
		for (const option of protocols) protocolDropdown.addOption(option, option);
		protocolDropdown.setValue(this.draftProtocol);
		protocolDropdown.onChange((value) => {
			this.draftProtocol = value;
		});

		this.numberControl(formField(fields, this.text.contextWindow), CONTEXT_PRESETS, this.draftContext, (value) => {
			this.draftContext = value;
		});
		this.numberControl(formField(fields, this.text.maxOutputTokens), OUTPUT_PRESETS, this.draftMaxTokens, (value) => {
			this.draftMaxTokens = value;
		});

		const capsControl = formField(fields, this.text.capabilities);
		const capsGroup = capsControl.createDiv({ cls: 'scribe-choice-group' });
		const capItems: Array<{ key: keyof Caps; label: string }> = [
			{ key: 'reasoning', label: this.text.capabilityReasoning },
			{ key: 'tools', label: this.text.capabilityTools },
		];
		for (const item of capItems) {
			const button = capsGroup.createEl('button', { cls: 'scribe-choice-button', attr: { type: 'button' } });
			button.setText(item.label);
			button.toggleClass('is-selected', this.caps[item.key]);
			button.setAttribute('aria-pressed', String(this.caps[item.key]));
			button.disabled = item.key === 'reasoning' && Boolean(this.catalog?.requiresReasoning);
			button.addEventListener('click', () => {
				this.caps[item.key] = !this.caps[item.key];
				button.toggleClass('is-selected', this.caps[item.key]);
				button.setAttribute('aria-pressed', String(this.caps[item.key]));
				thinkingRow.toggleClass('scribe-hidden', !this.caps.reasoning || !this.defaultThinking.length);
			});
		}

		const thinkingRow = formField(fields, this.text.thinkingLevel);
		thinkingRow.toggleClass('scribe-hidden', !this.caps.reasoning || !this.defaultThinking.length);
		this.renderThinkingPicker(thinkingRow);

		const footer = this.contentEl.createDiv({ cls: 'scribe-model-config-footer' });
		const actions = footer.createDiv({ cls: 'scribe-modal-action-group' });
		new ButtonComponent(actions).setButtonText(this.text.cancel).onClick(() => this.close());
		new ButtonComponent(actions).setCta().setButtonText(this.text.save).onClick(() => void this.save());
	}

	private renderThinkingPicker(container: HTMLElement): void {
		const chips = container.createDiv({ cls: 'scribe-thinking-chips' });
		const trigger = chips.createEl('button', { cls: 'scribe-thinking-add', attr: {
			type: 'button', 'aria-label': this.text.addThinkingLevel, 'aria-expanded': 'false', title: this.text.addThinkingLevel,
		} });
		setIcon(trigger, 'plus');
		const panel = container.createDiv({ cls: 'scribe-thinking-editor scribe-hidden' });
		const presets = panel.createDiv({ cls: 'scribe-thinking-chips' });
		const entry = panel.createDiv({ cls: 'scribe-thinking-entry' });
		const input = entry.createEl('input', { attr: {
			type: 'text', placeholder: this.text.customThinkingLevel, 'aria-label': this.text.customThinkingLevel,
			spellcheck: 'false', autocapitalize: 'off',
		} });
		const add = entry.createEl('button', { text: this.text.add, attr: { type: 'button' } });
		const setOpen = (open: boolean) => {
			panel.toggleClass('scribe-hidden', !open);
			trigger.setAttribute('aria-expanded', String(open));
			if (open) (presets.querySelector('button') ?? input).focus();
		};
		const append = (level: string) => {
			if (!isThinkingLevel(level) || this.draftThinking.includes(level)
				|| ((level === 'off' || level === 'minimal') && !this.availableThinking.includes(level))) {
				input.setCustomValidity(this.text.invalidThinkingLevel);
				input.reportValidity();
				return;
			}
			this.draftThinking = [...this.draftThinking, level];
			input.value = '';
			render();
			setOpen(false);
			trigger.focus();
		};
		const render = () => {
			chips.querySelectorAll('.scribe-thinking-chip').forEach((chip) => chip.remove());
			presets.empty();
			for (const level of this.draftThinking) {
				const chip = chips.createSpan({ cls: 'scribe-thinking-chip' });
				chips.insertBefore(chip, trigger);
				chip.createSpan({ text: level });
				const label = this.text.removeThinkingLevel.replace('{level}', () => level);
				const remove = chip.createEl('button', { attr: { type: 'button', 'aria-label': label, title: label } });
				remove.disabled = this.draftThinking.length === 1;
				setIcon(remove, 'x');
				remove.addEventListener('click', () => {
					this.draftThinking = this.draftThinking.filter((item) => item !== level);
					render();
					trigger.focus();
				});
			}
			for (const level of this.availableThinking.filter((level) => !this.draftThinking.includes(level))) {
				presets.createEl('button', { text: level, attr: { type: 'button' } }).addEventListener('click', () => append(level));
			}
		};
		render();
		trigger.addEventListener('click', () => setOpen(panel.hasClass('scribe-hidden')));
		add.addEventListener('click', () => append(input.value.trim()));
		input.addEventListener('input', () => input.setCustomValidity(''));
		container.addEventListener('keydown', (event) => {
			if (event.isComposing || panel.hasClass('scribe-hidden')) return;
			if (event.key === 'Enter' && event.target === input) {
				event.preventDefault();
				append(input.value.trim());
			}
			if (event.key === 'Escape') {
				event.stopPropagation();
				setOpen(false);
				trigger.focus();
			}
		});
	}

	/** 下拉预设 + 「自定义」切换为数字输入，存原始数值（128K 即 128000） */
	private numberControl(container: HTMLElement, presets: number[], initial: number, onChange: (value: number) => void): void {
		container.addClass('scribe-number-control');
		const select = new DropdownComponent(container);
		for (const preset of presets) select.addOption(String(preset), formatTokens(preset));
		select.addOption('custom', this.text.customValue);
		const custom = container.createEl('input', {
			cls: 'scribe-custom-number',
			attr: { type: 'number', min: '1', step: '1', value: String(initial) },
		});
		const showCustom = (show: boolean) => custom.toggleClass('scribe-hidden', !show);
		const isPreset = presets.includes(initial);
		select.setValue(isPreset ? String(initial) : 'custom');
		showCustom(!isPreset);
		select.onChange((value) => {
			if (value === 'custom') {
				showCustom(true);
				custom.focus();
				return;
			}
			showCustom(false);
			custom.value = value;
			onChange(Number(value));
		});
		custom.addEventListener('change', () => {
			const value = Math.floor(Number(custom.value));
			if (value > 0) onChange(value);
			custom.value = String(value > 0 ? value : initial);
		});
	}

	private async testConnection(button: ButtonComponent, status: HTMLElement): Promise<void> {
		if (!this.draftModel) return;
		this.testController?.abort();
		this.testController = new AbortController();
		button.setDisabled(true);
		button.setButtonText(this.text.testingConnection);
		status.setText('');
		try {
			const settings = this.plugin.services.settings;
			const override = this.currentOverride();
			const baseUrls = { ...settings.communication.baseUrls };
			if (this.options.providerBaseUrl !== undefined) {
				if (this.options.providerBaseUrl.trim()) baseUrls[this.provider.id] = this.options.providerBaseUrl.trim();
				else delete baseUrls[this.provider.id];
			}
			const protocols = { ...settings.communication.protocols };
			if (this.options.providerProtocol !== undefined) {
				if (this.options.providerProtocol.trim()) protocols[this.provider.id] = this.options.providerProtocol.trim();
				else delete protocols[this.provider.id];
			}
			// 自建服务商也使用父弹窗草稿，不能拿旧设置或空目录去测试
			const customProviders = Object.entries(settings.customProviders)
				.filter(([id]) => id !== this.provider.id)
				.map(([id, entry]) => ({
					id, label: entry.label, baseUrl: entry.baseUrl, protocol: entry.protocol,
					models: settings.providerModels[id] ?? [],
				}));
			const custom = this.options.customProvider ?? settings.customProviders[this.provider.id];
			if (custom) {
				customProviders.push({
					id: this.provider.id, ...custom,
					models: [...new Set([...(settings.providerModels[this.provider.id] ?? []), this.draftModel])],
				});
			}
			const communication = {
				...settings.communication,
				baseUrls,
				protocols,
				credentialIds: { ...settings.communication.credentialIds },
			};
			if (this.options.providerCredentialId !== undefined) {
				if (this.options.providerCredentialId) communication.credentialIds[this.provider.id] = this.options.providerCredentialId;
				else delete communication.credentialIds[this.provider.id];
			}
			const service = createModelService(
				createCredentialStore(this.app, communication),
				this.plugin.services.communication.transport,
				{
					baseUrls: () => baseUrls,
					protocols: () => protocols,
					modelOverrides: () => ({
						...settings.modelOverrides,
						[this.provider.id]: {
							...(settings.modelOverrides[this.provider.id] ?? {}),
							[this.draftModel]: override,
						},
					}),
					customProviders: () => customProviders,
				},
			);
			await service.send({
				providerId: this.provider.id,
				model: this.draftModel,
				messages: [{ role: 'user', content: 'Reply with OK.' }],
				tools: [],
				maxTokens: 16,
				signal: this.testController.signal,
			});
			status.setText(this.text.connectionSucceeded);
			status.className = 'scribe-connection-status is-success';
		} catch (error) {
			status.setText(`${this.text.connectionFailed}: ${error instanceof Error ? error.message : String(error)}`);
			status.className = 'scribe-connection-status is-error';
		} finally {
			button.setDisabled(false);
			button.setButtonText(this.text.testConnection);
		}
	}

	private async save(): Promise<void> {
		if (!this.draftModel) {
			new Notice(this.text.invalidModelConfiguration);
			return;
		}
		const settings = this.plugin.services.settings;
		const list = this.options.draft?.models ?? settings.providerModels[this.provider.id] ?? [];
		if (this.draftModel !== this.model && list.includes(this.draftModel)) {
			new Notice(this.text.duplicateModelId);
			return;
		}
		try {
			const change = { model: this.draftModel, previousModel: this.model, override: this.currentOverride() };
			if (this.options.draft) {
				this.options.draft.save(change);
				this.options.onSaved();
				this.close();
				return;
			}
			const next = applyModelDraft(list, settings.modelOverrides[this.provider.id] ?? {}, change);
			settings.providerModels[this.provider.id] = next.models;
			if (settings.providerId === this.provider.id && settings.model === this.model) settings.model = this.draftModel;
			if (Object.keys(next.overrides).length) settings.modelOverrides[this.provider.id] = next.overrides;
			else delete settings.modelOverrides[this.provider.id];

			await this.plugin.saveSettings();
			this.options.onSaved();
			this.close();
		} catch (error) {
			new Notice(`${this.text.saveFailed}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
