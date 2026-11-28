import { App, ButtonComponent, DropdownComponent, Modal, Notice, setIcon } from 'obsidian';
import { createCredentialStore } from '../communication/credentials';
import { isOpenCodeProvider } from '../communication/openCodeModels';
import { createModelService } from '../communication/providers';
import { supportsResponseSchema } from '../communication/modelFeatures';
import { nativeVideoFormat, videoTakesOnlyUrls } from '../communication/modelVideo';
import { mediaFields, mediaOptions, type MediaAdapter } from '../communication/mediaApi';
import { modelMediaAdapters } from '../communication/mediaRegistry';
import type ScribeAiPlugin from '../main';
import { reconcileDefaultModel } from '../orchestration/settings/modelAvailability';
import { arkMediaModelType, knownMediaModelType, resolveImageOptions, resolveMediaVoice, resolveSpeechRecognitionOptions, resolveSpeechSynthesisOptions,
	resolveVideoOptions } from '../orchestration/settings/mediaSettings';
import { isThinkingLevel, THINKING_LEVEL_PRESETS } from '../orchestration/settings/thinking';
import { queryCatalog } from '../orchestration/storage/modelCatalogStore';
import type { ConfiguredModelType, ModelCatalogResult, ModelInputModality, ModelOverride, ModelProviderInfo, ModelService } from '../types';
import { modelCatalogAddress, modelDetailsForConnection } from './modelCapabilityIcons';
import { ARK_MEDIA_CONNECTIONS, formField, renderMediaModelFields, renderProviderMediaFields, type MediaModelFields } from './modelConfigFields';
import { applyModelDraft, modelConfigurationOverride, prefillModelConfiguration, type ModelDraftChange } from './modelDraft';
import type { UiText } from './uiText';

const CONTEXT_PRESETS = [128000, 200000, 256000, 400000, 512000, 1000000];
const OUTPUT_PRESETS = [16000, 32000, 64000, 128000, 256000];
const INPUT_CHOICES = [['image', 'eye'], ['audio', 'ear'], ['video', 'video'], ['pdf', 'file-text']] as const;
const MANUAL_MODEL_TYPES = [['text', 'type'], ['image', 'image'], ['video', 'video'], ['speech-synthesis', 'audio-lines'],
	['speech-recognition', 'mic'], ['embedding', 'boxes'], ['rerank', 'arrow-up-down']] as const;
const MODEL_TYPE_CHOICES = [...MANUAL_MODEL_TYPES, ['audio', 'audio-lines'], ['other', 'box']] as const;
type Caps = Pick<ReturnType<typeof prefillModelConfiguration>, 'reasoning' | 'tools' | 'structuredOutput'>;
type ModelConfigOptions = {
	onSaved: () => void;
	settingsSignal?: AbortSignal;
	catalog?: ModelCatalogResult;
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

export class ScribeModelConfigModal extends Modal {
	private draftModel: string;
	private draftType: ConfiguredModelType;
	private confirmedType?: ConfiguredModelType;
	private readonly manualTypes = new Map<string, ConfiguredModelType>();
	private readonly fixedMediaType: keyof typeof ARK_MEDIA_CONNECTIONS | undefined;
	private readonly mediaProfiles: readonly MediaAdapter[];
	private readonly draftProviderMedia: NonNullable<ModelOverride['mediaOptions']>;
	private readonly draftMedia: MediaModelFields;
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
	private testCatalog?: ModelCatalogResult;
	private unsubscribeProtocols?: () => void;
	private readonly closeForSettings = () => this.close();

	static async openFor(
		app: App, plugin: ScribeAiPlugin, provider: ModelProviderInfo, model: string, text: UiText, options: ModelConfigOptions,
	): Promise<void> {
		const { settings, communication } = plugin.services;
		const custom = options.customProvider ?? settings.customProviders[provider.id];
		const baseUrl = options.providerBaseUrl ?? (settings.communication.baseUrls[provider.id] || custom?.baseUrl || provider.baseUrl);
		const protocol = options.providerProtocol ?? (settings.communication.protocols[provider.id] || custom?.protocol || provider.protocol);
		const catalogAddress = modelCatalogAddress(provider, baseUrl, Boolean(custom));
		const credentialId = options.providerCredentialId ?? settings.communication.credentialIds[provider.id];
		const readCatalog = async () => {
			const result = await communication.modelCatalog.read(provider.id, catalogAddress, credentialId,
				custom || protocol !== provider.protocol ? protocol : '');
			return result && result.source !== 'bundled' ? result : options.catalog ?? result;
		};
		const catalog = await readCatalog().catch(() => undefined);
		if (options.settingsSignal?.aborted) return;
		const source = {
			baseUrl, protocol, catalogAddress, catalog,
			overrides: options.draft?.overrides ?? settings.modelOverrides[provider.id], readCatalog,
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
		private catalogSource: Parameters<typeof modelDetailsForConnection>[2] & { readCatalog: () => Promise<ModelCatalogResult | undefined> },
	) {
		super(app);
		const { override, bundled, details } = modelDetailsForConnection(provider, model, catalogSource);
		this.savedOverride = override;
		this.fixedMediaType = arkMediaModelType(provider.id, model);
		this.mediaProfiles = modelMediaAdapters(provider.id, model);
		this.draftProviderMedia = Object.fromEntries(Object.entries(override?.mediaOptions ?? {}).map(([kind, values]) => [kind, { ...values }]));
		this.draftMedia = {
			imageDefaults: { ...override?.imageDefaults },
			videoDefaults: { ...override?.videoDefaults },
			voice: override?.voice,
			speechSynthesis: override?.speechSynthesis && { ...override.speechSynthesis },
			speechRecognition: override?.speechRecognition && { ...override.speechRecognition },
		};
		const initial = this.initial = prefillModelConfiguration(override, details, bundled);
		this.draftModel = model;
		this.draftBaseUrl = override?.baseUrl ?? '';
		this.draftProtocol = override?.protocol?.trim() ?? '';
		const savedType = override?.type;
		if (savedType && MANUAL_MODEL_TYPES.some(([type]) => type === savedType)) this.manualTypes.set(this.typeRoute(), savedType);
		this.confirmedType = knownMediaModelType(provider.id, model);
		this.draftType = this.confirmedType ?? this.manualTypes.get(this.typeRoute()) ?? 'text';
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

	private typeRoute(): string {
		return JSON.stringify([this.draftModel, this.draftBaseUrl.trim().replace(/\/+$/u, ''), this.draftProtocol]);
	}

	onOpen(): void {
		this.options.settingsSignal?.addEventListener('abort', this.closeForSettings, { once: true });
		this.modalEl.addClass('scribe-model-config-modal');
		this.contentEl.addClass('scribe-dialog-content');
		this.render();
	}

	onClose(): void {
		this.options.settingsSignal?.removeEventListener('abort', this.closeForSettings);
		this.testController?.abort();
		this.testController = null;
		this.testCatalog = undefined;
		this.catalogSource.catalog = undefined;
		this.options.catalog = undefined;
		this.unsubscribeProtocols?.();
		this.unsubscribeProtocols = undefined;
		this.contentEl.empty();
	}

	/** 自动连接值只在界面提示，显式填写的协议和地址才保存为覆盖项。 */
	private currentOverride(): ModelOverride {
		const override = this.draftType === 'text' ? modelConfigurationOverride({
			contextWindow: this.draftContext, maxTokens: this.draftMaxTokens, input: [...this.draftInput],
			...this.caps, thinkingLevels: this.draftThinking,
		}, {
			...this.initial,
			input: this.featureDefaults.input,
			structuredOutput: this.featureDefaults.structuredOutput,
		}, this.savedOverride) : { ...this.savedOverride };
		delete override.type;
		const manualType = this.manualTypes.get(this.typeRoute());
		if (!this.confirmedType && manualType) override.type = manualType;
		delete override.baseUrl;
		delete override.protocol;
		const baseUrl = this.draftBaseUrl.trim();
		if (baseUrl) override.baseUrl = baseUrl;
		if (this.draftProtocol) override.protocol = this.draftProtocol;
		return override;
	}

	private savedMediaFields(): ModelOverride {
		const type = this.fixedMediaType;
		if (type === 'image') {
			const imageDefaults = resolveImageOptions(this.draftModel, this.draftMedia.imageDefaults);
			return Object.keys(imageDefaults).length ? { imageDefaults } : {};
		}
		if (type === 'video') {
			const videoDefaults = resolveVideoOptions(this.draftModel, this.draftMedia.videoDefaults);
			return Object.keys(videoDefaults).length ? { videoDefaults } : {};
		}
		if (type === 'speech-synthesis') {
			const voice = resolveMediaVoice(this.draftMedia.voice);
			const speechSynthesis = resolveSpeechSynthesisOptions(this.draftMedia.speechSynthesis);
			const customized = JSON.stringify(speechSynthesis) !== JSON.stringify(resolveSpeechSynthesisOptions());
			return { ...(voice && { voice }), ...(customized && { speechSynthesis }) };
		}
		if (type === 'speech-recognition') {
			const speechRecognition = resolveSpeechRecognitionOptions(this.draftMedia.speechRecognition);
			if (JSON.stringify(speechRecognition) !== JSON.stringify(resolveSpeechRecognitionOptions())) return { speechRecognition };
		}
		return {};
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
			attr: { type: 'text', 'aria-label': this.text.modelId, value: this.draftModel, placeholder: this.text.enterModelId },
		});
		modelInput.readOnly = this.fixedMediaType !== undefined || this.mediaProfiles.length > 0;
		modelInput.addEventListener('input', () => {
			this.draftModel = modelInput.value.trim();
			refreshConnection();
		});

		const baseUrlControl = formField(fields, this.text.baseUrl);
		let mediaEndpoint = '';
		if (!this.fixedMediaType && this.mediaProfiles[0]) {
			try { mediaEndpoint = this.mediaProfiles[0].endpoint({ model: this.draftModel, baseUrl: this.draftBaseUrl || this.catalogSource.catalogAddress }); }
			catch { /* 需要账号或部署地址的模型可以在此填写。 */ }
		}
		const baseUrlInput = baseUrlControl.createEl('input', {
			cls: 'scribe-full-input',
			attr: { type: 'text', 'aria-label': this.text.baseUrl,
				value: this.fixedMediaType ? ARK_MEDIA_CONNECTIONS[this.fixedMediaType].address : this.draftBaseUrl,
				...(mediaEndpoint && { placeholder: mediaEndpoint }) },
		});
		baseUrlInput.readOnly = this.fixedMediaType !== undefined;
		baseUrlInput.addEventListener('input', () => {
			this.draftBaseUrl = baseUrlInput.value;
			refreshConnection();
		});

		const protocols = [...this.provider.protocols];
		if (this.draftProtocol && !protocols.includes(this.draftProtocol)) protocols.push(this.draftProtocol);
		const protocolControl = formField(fields, this.text.protocol);
		const protocolDropdown = new DropdownComponent(protocolControl);
		protocolDropdown.selectEl.setAttribute('aria-label', this.text.protocol);
		if (this.fixedMediaType) {
			const { protocol } = ARK_MEDIA_CONNECTIONS[this.fixedMediaType];
			protocolDropdown.addOption(protocol, protocol).setValue(protocol).setDisabled(true);
		} else if (this.mediaProfiles.length) {
			protocolDropdown.addOption('media-api', 'Media API').setValue('media-api').setDisabled(true);
		} else {
			protocolDropdown.addOption('', this.text.modelProtocolUnknown);
			for (const option of protocols) protocolDropdown.addOption(option, option);
			protocolDropdown.setValue(this.draftProtocol).onChange((value) => {
				this.draftProtocol = value;
				refreshConnection();
			});
		}
		const connectionHint = fields.createDiv({ cls: 'scribe-dialog-muted', attr: { role: 'status' } });
		const typeControl = formField(fields, this.text.modelType, true);
		const typeGroup = typeControl.createDiv({ cls: 'scribe-choice-group', attr: { role: 'group', 'aria-label': this.text.modelType } });
		const typeHint = typeControl.createDiv({ cls: 'scribe-dialog-muted' });
		const typeFields = fields.createDiv({ cls: 'scribe-dialog-fields' });
		let structuredOutputButton: HTMLButtonElement | undefined;
		let structuredOutputStatus: HTMLElement | undefined;
		let videoHint: HTMLElement | undefined;
		let syncInputButtons: (() => void) | undefined;
		let lastConnection = '';
		const refreshConnection = () => {
			const { details, bundled } = modelDetailsForConnection(this.provider, this.draftModel, {
				...this.catalogSource, overrides: { [this.draftModel]: { baseUrl: this.draftBaseUrl.trim(), protocol: this.draftProtocol } },
			});
			this.confirmedType = this.draftService.modelType?.(this.provider.id, this.draftModel);
			this.draftType = this.confirmedType ?? this.manualTypes.get(this.typeRoute()) ?? 'text';
			syncModelType();
			const chatModel = this.draftType === 'text';
			testButton.buttonEl.toggleClass('scribe-hidden', !chatModel);
			status.toggleClass('scribe-hidden', !chatModel);
			if (this.fixedMediaType) {
				connectionHint.toggleClass('scribe-hidden', true);
				return;
			}
			if (this.mediaProfiles.length) {
				try {
					connectionHint.setText(this.mediaProfiles.map((profile) => profile.endpoint({
						model: this.draftModel, baseUrl: this.draftBaseUrl.trim() || this.catalogSource.catalogAddress,
					})).filter((address, index, addresses) => addresses.indexOf(address) === index).join(' · '));
				} catch (error) {
					connectionHint.setText(error instanceof Error ? error.message : '');
				}
				return;
			}
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
			videoHint?.setText(this.draftInput.has('video') ? videoTakesOnlyUrls(videoFormat) ? this.text.capabilityStatus.videoUrl
				: videoFormat ? '' : this.text.capabilityConnectionUnsupported : '');
			const key = JSON.stringify([this.draftModel, this.draftType, this.draftProtocol, connection]);
			if (key === lastConnection) return;
			lastConnection = key;
			this.testController?.abort();
			this.testController = null;
			this.testCatalog = undefined;
			status.setText('');
			status.className = chatModel ? 'scribe-connection-status' : 'scribe-connection-status scribe-hidden';
			testButton.setButtonText(this.text.testConnection);
			testButton.setDisabled(!this.draftModel || Boolean(connection.issue));
			const automatic = protocolDropdown.selectEl.options[0];
			if (automatic) automatic.text = this.draftProtocol ? this.text.modelProtocolAuto
				: connection.api ? this.text.modelProtocolAutomatic.replace('{protocol}', () => connection.api)
					: this.text.modelProtocolUnknown;
			baseUrlInput.placeholder = connection.addressFromAuth
				? this.text.modelAddressFromAuth : connection.baseUrl || this.text.modelAddressUnknown;
			baseUrlInput.title = connection.baseUrl;
			connectionHint.setText(connection.issue ? this.text.modelConnectionIssues[connection.issue] : '');
			connectionHint.toggleClass('scribe-hidden', !connection.issue);
		};
		const renderTypeFields = () => {
			typeFields.empty();
			structuredOutputButton = undefined;
			structuredOutputStatus = undefined;
			videoHint = undefined;
			syncInputButtons = undefined;
			if (this.fixedMediaType) {
				renderMediaModelFields(typeFields, this.draftModel, this.fixedMediaType, this.draftMedia);
			}
			for (const profile of this.mediaProfiles) renderProviderMediaFields(typeFields, profile, this.draftModel, this.draftProviderMedia);
			if (this.fixedMediaType || this.mediaProfiles.length) return;
			if (this.draftType !== 'text') {
				typeFields.createDiv({ text: this.text.modelTypeUnavailable, cls: 'scribe-dialog-muted' });
				return;
			}
			const contextControl = formField(typeFields, this.text.contextWindow, true);
			this.numberControl(contextControl, CONTEXT_PRESETS, this.draftContext, this.text.contextWindow,
				this.text.contextWindowPlaceholder, (value) => {
					this.draftContext = value;
				});
			const outputControl = formField(typeFields, this.text.maxOutputTokens, true);
			this.numberControl(outputControl, OUTPUT_PRESETS, this.draftMaxTokens, this.text.maxOutputTokens,
				this.text.maxOutputTokensPlaceholder, (value) => {
					this.draftMaxTokens = value;
				});

			const inputControl = formField(typeFields, this.text.inputModality, true);
			syncInputButtons = this.renderInputModalities(inputControl, refreshConnection);
			videoHint = inputControl.createDiv({ cls: 'scribe-dialog-muted' });

			const capsControl = formField(typeFields, this.text.capabilities, true);
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

			const thinkingControl = formField(typeFields, this.text.thinkingLevel, true);
			const thinkingRow = thinkingControl.parentElement;
			thinkingRow?.toggleClass('scribe-hidden', !this.caps.reasoning);
			this.renderThinkingPicker(thinkingControl);
		};
		let renderedType: ConfiguredModelType | undefined;
		let renderedConfirmedType: ConfiguredModelType | undefined;
		const modelTypeButtons = new Map<ConfiguredModelType, HTMLButtonElement>();
		const syncModelType = () => {
			if (!modelTypeButtons.size || this.confirmedType !== renderedConfirmedType) {
				renderedConfirmedType = this.confirmedType;
				typeGroup.empty();
				modelTypeButtons.clear();
				const choices = this.confirmedType
					? MODEL_TYPE_CHOICES.filter(([type]) => type === this.confirmedType)
					: MANUAL_MODEL_TYPES;
				for (const [type, icon] of choices) {
					const button = typeGroup.createEl('button', {
						cls: 'scribe-choice-button scribe-input-modality', attr: { type: 'button' },
					});
					setIcon(button.createSpan({ attr: { 'aria-hidden': 'true' } }), icon);
					button.createSpan({ text: this.text.modelTypeLabels[type] });
					button.disabled = Boolean(this.confirmedType);
					button.addEventListener('click', () => {
						if (this.confirmedType) return;
						this.manualTypes.set(this.typeRoute(), type);
						refreshConnection();
					});
					modelTypeButtons.set(type, button);
				}
				typeHint.setText(this.confirmedType ? this.text.modelTypeConfirmed : this.text.modelTypeManual);
			}
			for (const [type, button] of modelTypeButtons) {
				button.toggleClass('is-selected', this.draftType === type);
				button.setAttribute('aria-pressed', String(this.draftType === type));
			}
			if (renderedType === this.draftType) return;
			renderedType = this.draftType;
			renderTypeFields();
		};
		this.unsubscribeProtocols?.();
		let catalogRevision = 0;
		const unsubscribe = this.plugin.services.communication.modelCatalog.subscribeProtocols(() => {
			const revision = ++catalogRevision;
			void this.catalogSource.readCatalog().then((catalog) => {
				if (revision !== catalogRevision) return;
				this.catalogSource.catalog = catalog;
				refreshConnection();
			}).catch(() => {});
		});
		this.unsubscribeProtocols = () => {
			catalogRevision++;
			unsubscribe();
		};
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

	/** 预设按钮一键填充 + 常驻输入框，存原始数值（128K 即 128000） */
	private numberControl(
		container: HTMLElement, presets: number[], initial: number, label: string, placeholder: string,
		onChange: (value: number) => void,
	): void {
		container.addClass('scribe-number-control');
		const presetsRow = container.createDiv({ cls: 'scribe-number-presets' });
		const input = container.createEl('input', {
			cls: 'scribe-custom-number',
			attr: {
				type: 'text', inputmode: 'numeric', spellcheck: 'false',
				placeholder, 'aria-label': label, value: String(initial),
			},
		});
		let current = initial;
		const apply = (value: number): boolean => {
			if (!Number.isSafeInteger(value) || value <= 0) return false;
			current = value;
			onChange(value);
			return true;
		};
		for (const preset of presets) {
			presetsRow.createEl('button', {
				cls: 'scribe-number-preset', text: formatTokens(preset), attr: { type: 'button' },
			}).addEventListener('click', () => {
				input.value = String(preset);
				apply(preset);
			});
		}
		input.addEventListener('input', () => apply(Math.floor(Number(input.value))));
		input.addEventListener('change', () => {
			const value = Math.floor(Number(input.value));
			input.value = String(apply(value) ? value : current);
		});
	}

	private createDraftService(): ModelService {
		const { settings, communication: { transport } } = this.plugin.services;
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
				catalogProtocol: (_providerId, model) => (this.testCatalog ?? this.catalogSource.catalog)?.details?.get(model)?.connectionProtocol,
				catalogDetails: (_providerId, model) => modelDetailsForConnection(this.provider, model, {
					...this.catalogSource,
					catalog: this.testCatalog ?? this.catalogSource.catalog,
					overrides: { [model]: { baseUrl: this.draftBaseUrl.trim(), protocol: this.draftProtocol } },
				}).details,
				modelOverrides: () => ({ [id]: { [this.draftModel]: this.currentOverride() } }),
				customProviders: () => custom ? [{ id, ...custom, models: [this.draftModel] }] : [],
			},
		);
	}

	private async testConnection(button: ButtonComponent, status: HTMLElement): Promise<void> {
		if (!this.draftModel || this.draftType !== 'text' || knownMediaModelType(this.provider.id, this.draftModel)) return;
		this.testController?.abort();
		const controller = this.testController = new AbortController();
		button.setDisabled(true);
		button.setButtonText(this.text.testingConnection);
		status.setText('');
		const provider = this.provider;
		const model = this.draftModel;
		try {
			const unknown = !provider.models.some(({ id }) => id === model) && !this.catalogSource.catalog?.details?.has(model);
			if (unknown) {
				const { catalogAddress: baseUrl, protocol } = this.catalogSource;
				const catalog = await queryCatalog(provider, { baseUrl, protocol: protocol === provider.protocol ? undefined : protocol },
					this.draftService, controller.signal).catch(() => undefined);
				controller.signal.throwIfAborted();
				this.testCatalog = catalog;
			}
			if (model !== this.draftModel) return;
			const resolvedProtocol = (this.testCatalog ?? this.catalogSource.catalog)?.details?.get(model)?.connectionProtocol;
			const providerProtocol = this.catalogSource.protocol === provider.protocol ? '' : this.catalogSource.protocol;
			if (unknown && isOpenCodeProvider(provider.id) && !resolvedProtocol && !this.draftProtocol && !providerProtocol) {
				throw new Error(this.text.modelCatalogFetchFailed);
			}
			await this.draftService.send({
				providerId: provider.id,
				model,
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
				this.testCatalog = undefined;
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
		const issue = this.fixedMediaType || this.mediaProfiles.length ? undefined : this.draftService.modelConnection(this.provider.id, this.draftModel).issue;
		if (issue && issue !== 'missing-protocol' && issue !== 'missing-address') {
			new Notice(this.text.modelConnectionIssues[issue]);
			return;
		}
		const settings = this.plugin.services.settings;
		const list = this.options.draft?.models ?? settings.providerModels[this.provider.id] ?? [];
		if (this.draftModel !== this.model && (list.includes(this.draftModel) || knownMediaModelType(this.provider.id, this.draftModel))) {
			new Notice(this.text.duplicateModelId);
			return;
		}
		try {
			const override = this.fixedMediaType ? this.savedMediaFields() : this.currentOverride();
			if (this.mediaProfiles.length) {
				delete override.mediaOptions;
				for (const profile of this.mediaProfiles) {
					const values = mediaOptions(mediaFields(profile, this.draftModel), this.draftProviderMedia[profile.operation], undefined, false);
					if (Object.keys(values).length) (override.mediaOptions ??= {})[profile.operation] = values;
				}
			}
			const change = { model: this.draftModel, previousModel: this.model, override };
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
			reconcileDefaultModel(settings, this.plugin.services.communication.models.modelType);

			await this.plugin.saveSettings();
			this.options.onSaved();
			this.close();
		} catch (error) {
			new Notice(`${this.text.saveFailed}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
