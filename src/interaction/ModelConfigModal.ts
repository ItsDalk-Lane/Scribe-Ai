import { App, ButtonComponent, DropdownComponent, Modal, Notice, setIcon } from 'obsidian';
import { createCredentialStore } from '../communication/credentials';
import { createModelService } from '../communication/providers';
import { supportsResponseSchema } from '../communication/modelFeatures';
import { nativeVideoFormat, videoTakesOnlyUrls } from '../communication/modelVideo';
import type ScribeAiPlugin from '../main';
import { isThinkingLevel, THINKING_LEVEL_PRESETS } from '../orchestration/settings/thinking';
import type { ModelInputModality, ModelOverride, ModelProviderInfo, ModelService } from '../types';
import { modelCatalogAddress, modelDetailsForConnection } from './modelCapabilityIcons';
import { applyModelDraft, modelConfigurationOverride, prefillModelConfiguration, type ModelDraftChange } from './modelDraft';
import type { UiText } from './uiText';

const CONTEXT_PRESETS = [64000, 128000, 200000, 256000, 512000, 1000000];
const OUTPUT_PRESETS = [8000, 16000, 32000, 64000, 128000, 256000];
const INPUT_CHOICES = [['image', 'eye'], ['audio', 'ear'], ['video', 'video'], ['pdf', 'file-text']] as const;
type Caps = Pick<ReturnType<typeof prefillModelConfiguration>, 'reasoning' | 'tools' | 'structuredOutput'>;
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

function formField(container: HTMLElement, label: string, stacked = false): HTMLDivElement {
	const field = container.createDiv({ cls: stacked ? 'scribe-form-field is-stacked' : 'scribe-form-field' });
	field.createEl('label', { text: label });
	return field.createDiv({ cls: 'scribe-form-control' });
}

export class ScribeModelConfigModal extends Modal {
	private draftModel: string;
	private draftBaseUrl: string;
	private draftProtocol: string;
	private draftContext: number;
	private draftMaxTokens: number;
	private draftInput: Set<ModelInputModality>;
	private caps: Caps;
	private featureDefaults: ReturnType<typeof prefillModelConfiguration>;
	private editedStructuredOutput = false;
	private readonly editedInputs = new Set<ModelInputModality>();
	private draftThinking: string[];
	private availableThinking: readonly string[];
	private readonly initial: ReturnType<typeof prefillModelConfiguration>;
	private readonly draftService: ModelService;
	private testController: AbortController | null = null;
	private unsubscribeProtocols?: () => void;

	static async openFor(
		app: App, plugin: ScribeAiPlugin, provider: ModelProviderInfo, model: string, text: UiText, options: ModelConfigOptions,
	): Promise<void> {
		const { settings, communication } = plugin.services;
		const custom = options.customProvider ?? settings.customProviders[provider.id];
		const baseUrl = options.providerBaseUrl ?? (settings.communication.baseUrls[provider.id] || custom?.baseUrl || provider.baseUrl);
		const protocol = options.providerProtocol ?? (settings.communication.protocols[provider.id] || custom?.protocol || provider.protocol);
		const catalogAddress = modelCatalogAddress(provider, baseUrl, Boolean(custom));
		const credentialId = options.providerCredentialId ?? settings.communication.credentialIds[provider.id];
		const catalog = await communication.modelCatalog.read(provider.id, catalogAddress, credentialId,
			custom || protocol !== provider.protocol ? protocol : '').catch(() => undefined);
		const source = {
			baseUrl, protocol, catalogAddress, catalog,
			overrides: options.draft?.overrides ?? settings.modelOverrides[provider.id],
		};
		new ScribeModelConfigModal(app, plugin, provider, model, text, options, source).open();
	}

	private constructor(
		app: App,
		private plugin: ScribeAiPlugin,
		private provider: ModelProviderInfo,
		private model: string,
		private text: UiText,
		private options: ModelConfigOptions,
		private catalogSource: Parameters<typeof modelDetailsForConnection>[2],
	) {
		super(app);
		const { override, bundled, details } = modelDetailsForConnection(provider, model, catalogSource);
		this.savedOverride = override;
		const initial = this.initial = prefillModelConfiguration(override, details, bundled);
		this.draftModel = model;
		this.draftBaseUrl = override?.baseUrl ?? '';
		this.draftProtocol = override?.protocol?.trim() ?? '';
		this.draftContext = initial.contextWindow;
		this.draftMaxTokens = initial.maxTokens;
		this.draftInput = new Set(initial.input);
		this.featureDefaults = initial;
		this.caps = {
			reasoning: initial.reasoning, tools: initial.tools,
			structuredOutput: initial.structuredOutput,
		};
		this.draftThinking = [...initial.thinkingLevels];
		const supported = initial.requiresReasoning ? initial.thinkingLevels : ['off', ...initial.thinkingLevels];
		this.availableThinking = THINKING_LEVEL_PRESETS.filter((level) => (level !== 'off' && level !== 'minimal') || supported.includes(level));
		this.draftService = this.createDraftService();
	}

	private readonly savedOverride?: ModelOverride;

	onOpen(): void {
		this.modalEl.addClass('scribe-model-config-modal');
		this.contentEl.addClass('scribe-dialog-content');
		this.render();
	}

	onClose(): void {
		this.testController?.abort();
		this.testController = null;
		this.unsubscribeProtocols?.();
		this.unsubscribeProtocols = undefined;
		this.contentEl.empty();
	}

	/** 自动连接值只在界面提示，显式填写的协议和地址才保存为覆盖项。 */
	private currentOverride(): ModelOverride {
		const override = modelConfigurationOverride({
			contextWindow: this.draftContext, maxTokens: this.draftMaxTokens, input: [...this.draftInput],
			...this.caps, thinkingLevels: this.draftThinking,
		}, {
			...this.initial,
			input: this.featureDefaults.input,
			structuredOutput: this.featureDefaults.structuredOutput,
		}, this.savedOverride);
		const baseUrl = this.draftBaseUrl.trim();
		if (baseUrl) override.baseUrl = baseUrl;
		if (this.draftProtocol) override.protocol = this.draftProtocol;
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
		testButton.onClick(() => {
			refreshConnection();
			void this.testConnection(testButton, status);
		});

		const scroll = this.contentEl.createDiv({ cls: 'scribe-dialog-scroll scribe-model-config-body' });
		const fields = scroll.createDiv({ cls: 'scribe-dialog-fields' });

		const modelControl = formField(fields, this.text.modelId);
		const modelInput = modelControl.createEl('input', {
			cls: 'scribe-full-input',
			attr: { type: 'text', value: this.draftModel, placeholder: this.text.enterModelId },
		});
		modelInput.addEventListener('input', () => {
			this.draftModel = modelInput.value.trim();
			refreshConnection();
		});

		const baseUrlControl = formField(fields, this.text.baseUrl);
		const baseUrlInput = baseUrlControl.createEl('input', {
			cls: 'scribe-full-input',
			attr: { type: 'text', value: this.draftBaseUrl },
		});
		baseUrlInput.addEventListener('input', () => {
			this.draftBaseUrl = baseUrlInput.value;
			refreshConnection();
		});

		const protocols = [...this.provider.protocols];
		if (this.draftProtocol && !protocols.includes(this.draftProtocol)) protocols.push(this.draftProtocol);
		const protocolControl = formField(fields, this.text.protocol);
		const protocolDropdown = new DropdownComponent(protocolControl);
		protocolDropdown.addOption('', this.text.modelProtocolUnknown);
		for (const option of protocols) protocolDropdown.addOption(option, option);
		protocolDropdown.setValue(this.draftProtocol);
		protocolDropdown.onChange((value) => {
			this.draftProtocol = value;
			refreshConnection();
		});
		const connectionHint = fields.createDiv({ cls: 'scribe-dialog-muted', attr: { role: 'status' } });
		let structuredOutputButton: HTMLButtonElement | undefined;
		let structuredOutputStatus: HTMLElement | undefined;
		let videoHint: HTMLElement;
		let syncInputButtons: () => void;
		let lastConnection = '';
		const refreshConnection = () => {
			const { details, bundled } = modelDetailsForConnection(this.provider, this.draftModel, {
				...this.catalogSource, overrides: { [this.draftModel]: { baseUrl: this.draftBaseUrl.trim(), protocol: this.draftProtocol } },
			});
			this.featureDefaults = prefillModelConfiguration(this.savedOverride, details, bundled);
			for (const modality of [...new Set([...this.draftInput, ...this.featureDefaults.input])]) {
				if (this.editedInputs.has(modality)) continue;
				if (this.featureDefaults.input.includes(modality)) this.draftInput.add(modality);
				else this.draftInput.delete(modality);
			}
			syncInputButtons?.();
			if (!this.editedStructuredOutput) this.caps.structuredOutput = this.featureDefaults.structuredOutput;
			structuredOutputButton?.toggleClass('is-selected', this.caps.structuredOutput);
			structuredOutputButton?.setAttribute('aria-pressed', String(this.caps.structuredOutput));
			const connection = this.draftService.modelConnection(this.provider.id, this.draftModel);
			const available = supportsResponseSchema(connection.api, connection.baseUrl, this.draftModel);
			const evidence = details?.evidence?.structuredOutput;
			const labels = this.text.capabilityStatus;
			const manual = this.editedStructuredOutput || this.savedOverride?.capabilities?.structuredOutput !== undefined;
			const schemaStatus = manual ? labels.manual : evidence?.conflict ? labels.conflict
				: details?.structuredOutput === true ? labels.supported : details?.structuredOutput === false ? labels.unsupported
					: details?.jsonOutput === true ? labels.jsonOnly : labels.unknown;
			const notice = !manual && details?.structuredOutput === true && !available ? this.text.capabilityConnectionUnsupported : schemaStatus;
			structuredOutputStatus?.setText(notice);
			if (structuredOutputButton) structuredOutputButton.title = [schemaStatus, evidence?.source, evidence?.checkedAt,
				connection.issue || available ? '' : this.text.capabilityConnectionUnsupported].filter(Boolean).join(' · ');
			const videoFormat = nativeVideoFormat(connection, this.draftModel);
			videoHint.setText(this.draftInput.has('video') ? videoTakesOnlyUrls(videoFormat) ? this.text.capabilityStatus.videoUrl
				: videoFormat ? '' : this.text.capabilityConnectionUnsupported : '');
			const key = JSON.stringify([this.draftModel, this.draftProtocol, connection]);
			if (key === lastConnection) return;
			lastConnection = key;
			this.testController?.abort();
			this.testController = null;
			status.setText('');
			status.className = 'scribe-connection-status';
			testButton.setButtonText(this.text.testConnection);
			testButton.setDisabled(!this.draftModel || Boolean(connection.issue));
			const automatic = protocolDropdown.selectEl.options[0];
			if (automatic) automatic.text = this.draftProtocol ? this.text.modelProtocolAuto
				: connection.api ? this.text.modelProtocolAutomatic.replace('{protocol}', () => connection.api)
					: this.text.modelProtocolUnknown;
			baseUrlInput.placeholder = connection.addressFromAuth
				? this.text.modelAddressFromAuth : connection.baseUrl || this.text.modelAddressUnknown;
			baseUrlInput.title = connection.baseUrl;
			connectionHint.setText(connection.issue ? this.text.modelConnectionIssues[connection.issue]
				: this.text.modelConnectionSources[connection.source]);
		};
		this.unsubscribeProtocols?.();
		this.unsubscribeProtocols = this.plugin.services.communication.modelCatalog.subscribeProtocols(refreshConnection);

		this.numberControl(formField(fields, this.text.contextWindow), CONTEXT_PRESETS, this.draftContext, (value) => {
			this.draftContext = value;
		});
		this.numberControl(formField(fields, this.text.maxOutputTokens), OUTPUT_PRESETS, this.draftMaxTokens, (value) => {
			this.draftMaxTokens = value;
		});

		const inputControl = formField(fields, this.text.inputModality, true);
		syncInputButtons = this.renderInputModalities(inputControl, refreshConnection);
		videoHint = inputControl.createDiv({ cls: 'scribe-dialog-muted' });

		const capsControl = formField(fields, this.text.capabilities, true);
		const capsGroup = capsControl.createDiv({ cls: 'scribe-choice-group' });
		const capItems: Array<{ key: keyof Caps; label: string }> = [
			{ key: 'reasoning', label: this.text.capabilityReasoning },
			{ key: 'tools', label: this.text.capabilityTools },
			{ key: 'structuredOutput', label: this.text.capabilityStructuredOutput },
		];
		for (const item of capItems) {
			const button = capsGroup.createEl('button', { cls: 'scribe-choice-button', attr: { type: 'button' } });
			button.setText(item.label);
			button.toggleClass('is-selected', this.caps[item.key]);
			button.setAttribute('aria-pressed', String(this.caps[item.key]));
			if (item.key === 'structuredOutput') {
				structuredOutputButton = button;
				structuredOutputStatus = capsControl.createDiv({ cls: 'scribe-dialog-muted', attr: { 'aria-label': item.label } });
			}
			button.disabled = item.key === 'reasoning' && this.initial.requiresReasoning;
			button.addEventListener('click', () => {
				if (item.key === 'structuredOutput') this.editedStructuredOutput = true;
				this.caps[item.key] = !this.caps[item.key];
				button.toggleClass('is-selected', this.caps[item.key]);
				button.setAttribute('aria-pressed', String(this.caps[item.key]));
				thinkingRow?.toggleClass('scribe-hidden', !this.caps.reasoning);
				refreshConnection();
			});
		}

		const thinkingControl = formField(fields, this.text.thinkingLevel, true);
		const thinkingRow = thinkingControl.parentElement;
		thinkingRow?.toggleClass('scribe-hidden', !this.caps.reasoning);
		this.renderThinkingPicker(thinkingControl);
		refreshConnection();

		const footer = this.contentEl.createDiv({ cls: 'scribe-model-config-footer' });
		const actions = footer.createDiv({ cls: 'scribe-modal-action-group' });
		new ButtonComponent(actions).setButtonText(this.text.cancel).onClick(() => this.close());
		new ButtonComponent(actions).setCta().setButtonText(this.text.save).onClick(() => void this.save());
	}

	private renderInputModalities(container: HTMLElement, onChange: () => void): () => void {
		const choices = container.createDiv({
			cls: 'scribe-choice-group', attr: { role: 'group', 'aria-label': this.text.inputModality },
		});
		const updates: (() => void)[] = [];
		for (const [modality, icon] of INPUT_CHOICES) {
			const button = choices.createEl('button', {
				cls: 'scribe-choice-button scribe-input-modality', attr: { type: 'button' },
			});
			setIcon(button.createSpan({ attr: { 'aria-hidden': 'true' } }), icon);
			button.createSpan({ text: this.text.modelCapabilityLabels[icon] });
			const sync = () => {
				const selected = this.draftInput.has(modality);
				button.toggleClass('is-selected', selected);
				button.setAttribute('aria-pressed', String(selected));
			};
			sync();
			updates.push(sync);
			button.addEventListener('click', () => {
				this.editedInputs.add(modality);
				if (this.draftInput.has(modality)) this.draftInput.delete(modality);
				else this.draftInput.add(modality);
				sync();
				onChange();
			});
		}
		return () => updates.forEach((update) => update());
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

	private createDraftService(): ModelService {
		const { settings, communication: { transport, modelCatalog } } = this.plugin.services;
		const id = this.provider.id;
		const baseUrls = { ...settings.communication.baseUrls };
		const protocols = { ...settings.communication.protocols };
		if (this.options.providerBaseUrl !== undefined) {
			const address = this.options.providerBaseUrl.trim();
			if (address && address !== this.provider.baseUrl) baseUrls[id] = address;
			else delete baseUrls[id];
		}
		if (this.options.providerProtocol !== undefined) {
			const protocol = this.options.providerProtocol.trim();
			if (protocol && protocol !== this.provider.protocol) protocols[id] = protocol;
			else delete protocols[id];
		}
		const credentialIds = { ...settings.communication.credentialIds };
		if (this.options.providerCredentialId !== undefined) {
			if (this.options.providerCredentialId) credentialIds[id] = this.options.providerCredentialId;
			else delete credentialIds[id];
		}
		const custom = this.options.customProvider ?? settings.customProviders[id];
		return createModelService(
			createCredentialStore(this.app, { ...settings.communication, baseUrls, protocols, credentialIds }),
			transport,
			{
				baseUrls: () => baseUrls,
				protocols: () => protocols,
				catalogProtocol: (providerId, model) => modelCatalog.protocol(providerId, model, credentialIds[providerId] ?? ''),
				catalogDetails: (_providerId, model) => modelDetailsForConnection(this.provider, model, {
					...this.catalogSource,
					overrides: { [model]: { baseUrl: this.draftBaseUrl.trim(), protocol: this.draftProtocol } },
				}).details,
				modelOverrides: () => ({ [id]: { [this.draftModel]: this.currentOverride() } }),
				customProviders: () => custom ? [{ id, ...custom, models: [this.draftModel] }] : [],
			},
		);
	}

	private async testConnection(button: ButtonComponent, status: HTMLElement): Promise<void> {
		if (!this.draftModel) return;
		this.testController?.abort();
		const controller = this.testController = new AbortController();
		button.setDisabled(true);
		button.setButtonText(this.text.testingConnection);
		status.setText('');
		try {
			await this.draftService.send({
				providerId: this.provider.id,
				model: this.draftModel,
				messages: [{ role: 'user', content: 'Reply with OK.' }],
				tools: [],
				maxTokens: 16,
				signal: controller.signal,
			});
			if (this.testController !== controller) return;
			status.setText(this.text.connectionSucceeded);
			status.className = 'scribe-connection-status is-success';
		} catch (error) {
			if (this.testController !== controller) return;
			status.setText(`${this.text.connectionFailed}: ${error instanceof Error ? error.message : String(error)}`);
			status.className = 'scribe-connection-status is-error';
		} finally {
			if (this.testController === controller) {
				this.testController = null;
				button.setDisabled(false);
				button.setButtonText(this.text.testConnection);
			}
		}
	}

	private async save(): Promise<void> {
		if (!this.draftModel) {
			new Notice(this.text.invalidModelConfiguration);
			return;
		}
		const issue = this.draftService.modelConnection(this.provider.id, this.draftModel).issue;
		if (issue && issue !== 'missing-protocol' && issue !== 'missing-address') {
			new Notice(this.text.modelConnectionIssues[issue]);
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
