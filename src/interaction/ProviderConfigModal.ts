import {
	App,
	ButtonComponent,
	DropdownComponent,
	Modal,
	Notice,
	setIcon,
} from 'obsidian';
import { createCredentialStore, credentialIdForProvider } from '../communication/credentials';
import { isVolcengineSubscriptionProvider } from '../communication/extraProviders';
import { createModelService } from '../communication/providers';
import type ScribeAiPlugin from '../main';
import { AGENT_PLAN_PROVIDER_ID, knownMediaModelType, CONFIGURED_MODEL_TYPES, confirmedCatalogModelType, MEDIA_MODELS } from '../orchestration/settings/mediaSettings';
import { mediaAdapters } from '../communication/mediaRegistry';
import { reconcileDefaultModel } from '../orchestration/settings/modelAvailability';
import type { ModelCatalogStore } from '../orchestration/storage/modelCatalogStore';
import type { ConfiguredModelType, ModelCatalogResult, ModelOverride, ModelProviderInfo } from '../types';
import { confirmAction } from './ConfirmModal';
import { renderCredentialLink } from './credentialLink';
import { modelCatalogAddress, modelDetailsForConnection, renderModelCapabilityIcons } from './modelCapabilityIcons';
import { applyModelDraft } from './modelDraft';
import { createOAuthInteraction } from './oauthInteraction';
import { ScribeModelConfigModal } from './ModelConfigModal';
import { updateOverflowTitle } from './overflowTitle';
import { removeProviderSettings } from './providerSettings';
import type { UiText } from './uiText';

// 三个常见本地服务的 OpenAI 兼容地址
const LOCAL_PRESETS = [
	{ label: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
	{ label: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
	{ label: 'llama.cpp', url: 'http://127.0.0.1:8080/v1' },
];
const NAME_MAX = 40;
/** 名称可见宽度上限（半角算 1、全角算 2），超出按字符截断，避免撑破输入框 */
const NAME_WIDTH = 28;
function clampName(value: string): string {
	let width = 0;
	const kept: string[] = [];
	for (const char of Array.from(value)) {
		width += /[\u1100-\uFFFF]/.test(char) ? 2 : 1;
		if (width > NAME_WIDTH) break;
		kept.push(char);
	}
	return kept.join('');
}

/** 上下文长度按 K/M 显示，未知时留短横线 */
function formatContext(tokens: number): string {
	if (!tokens) return '—';
	if (tokens < 1000) return String(tokens);
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
	return `${Math.round(tokens / 100) / 10}K`;
}

interface ConfigureOptions {
	mode: 'new' | 'edit';
	/** 自建服务商（自定义端点/本地模型），名称与地址写入 customProviders */
	custom?: boolean;
	/** 添加服务商时可选择同一厂商的不同端点 */
	variants?: ModelProviderInfo[];
	settingsSignal?: AbortSignal;
	onSaved: () => void;
}

interface ProviderDraft {
	models: string[];
	overrides: Record<string, ModelOverride>;
	activeModel: string;
	credentialId: string;
	name: string;
	baseUrl: string;
	protocol: string;
}

function formField(container: HTMLElement, label: string): HTMLDivElement {
	const field = container.createDiv({ cls: 'scribe-form-field' });
	field.createEl('label', { text: label });
	return field.createDiv({ cls: 'scribe-form-control' });
}

export class ConfigureProviderModal extends Modal {
	private draftModels: string[] = [];
	private draftOverrides: Record<string, ModelOverride> = {};
	private draftActiveModel = '';
	private draftCredentialId = '';
	private draftName = '';
	private draftBaseUrl = '';
	private draftProtocol = '';
	private defaultCredentialId = '';
	private variantDrafts = new Map<string, ProviderDraft>();
	private customIds = new Set<string>();
	private panelOpen = false;
	private modelCatalog: ModelCatalogResult | null = null;
	private catalogMessage = '';
	private fetchRequest: { controller: AbortController; manual: boolean } | null = null;
	private fetchedCatalog: { connection: Parameters<ModelCatalogStore['fetchConnection']>[1]; result: ModelCatalogResult & { baseUrl?: string } } | null = null;
	private fetchButton: ButtonComponent | null = null;
	private panel: HTMLElement | null = null;
	private triggerEl: HTMLButtonElement | null = null;
	private pickerEl: HTMLElement | null = null;
	private addedListEl: HTMLElement | null = null;
	private saveButtons: ButtonComponent[] = [];
	private onOutside: ((event: MouseEvent) => void) | null = null;
	private panelList: HTMLDivElement | null = null;
	private panelEmpty: HTMLDivElement | null = null;
	private panelStatus: HTMLDivElement | null = null;
	private panelTypes: HTMLDivElement | null = null;
	private panelResults: HTMLDivElement | null = null;
	private panelType: ConfiguredModelType = 'text';
	private readonly panelResultsId = `scribe-provider-models-${crypto.randomUUID()}`;
	private panelSearch?: HTMLInputElement;
	private loginController: AbortController | null = null;
	private loginButton: ButtonComponent | null = null;
	private pendingOAuthSecrets = new Set<string>();
	private readonly closeOnSettingsLeave = () => this.close();

	constructor(
		app: App,
		private plugin: ScribeAiPlugin,
		private provider: ModelProviderInfo,
		private text: UiText,
		private options: ConfigureOptions,
	) {
		super(app);
		this.loadDraft(provider);
	}

	private loadDraft(provider: ModelProviderInfo): void {
		const settings = this.plugin.services.settings;
		const cached = this.variantDrafts.get(provider.id);
		const custom = settings.customProviders[provider.id];
		const active = settings.providerId === provider.id ? settings.model : '';
		const firstModel = active || (this.options.mode === 'new' ? provider.models[0]?.id : undefined);
		this.draftModels = cached?.models ?? [...(settings.providerModels[provider.id] ?? (firstModel ? [firstModel] : []))];
		this.draftOverrides = cached?.overrides ?? { ...(settings.modelOverrides[provider.id] ?? {}) };
		this.draftActiveModel = cached?.activeModel ?? active;
		this.defaultCredentialId = /^[a-z0-9][a-z0-9-]*$/.test(provider.id)
			? credentialIdForProvider(provider.id)
			: 'scribe-ai-provider';
		this.draftCredentialId = cached?.credentialId ?? settings.communication.credentialIds[provider.id] ?? '';
		// 已保存的旧版自建服务商可能把编辑结果放在服务商覆盖项里。
		this.draftName = cached?.name ?? clampName(settings.communication.providerNames[provider.id] ?? custom?.label ?? provider.label);
		this.draftBaseUrl = cached?.baseUrl ?? settings.communication.baseUrls[provider.id] ?? custom?.baseUrl ?? provider.baseUrl;
		this.draftProtocol = cached?.protocol ?? settings.communication.protocols[provider.id] ?? custom?.protocol ?? provider.protocol;
		this.customIds = new Set(this.draftModels.filter((model) => !provider.models.some((entry) => entry.id === model)));
	}

	onOpen(): void {
		this.options.settingsSignal?.addEventListener('abort', this.closeOnSettingsLeave, { once: true });
		this.modalEl.addClass('scribe-configure-modal');
		this.contentEl.addClass('scribe-dialog-content');
		this.renderForm();
		// 面板不是 modal：点面板与触发按钮以外的地方就收起来
		const doc = this.modalEl.ownerDocument;
		this.onOutside = (event) => {
			if (this.panelOpen && !this.pickerEl?.contains(event.target as Node)) this.setPanelOpen(false);
		};
		doc.addEventListener('mousedown', this.onOutside);
	}

	onClose(): void {
		this.options.settingsSignal?.removeEventListener('abort', this.closeOnSettingsLeave);
		this.fetchRequest?.controller.abort();
		this.fetchRequest = null;
		this.fetchedCatalog = null;
		this.modelCatalog = null;
		this.catalogMessage = '';
		this.panelOpen = false;
		this.loginController?.abort();
		this.loginController = null;
		const linked = new Set(Object.values(this.plugin.services.settings.communication.credentialIds));
		for (const id of this.pendingOAuthSecrets) {
			if (!linked.has(id) && this.app.secretStorage.getSecret(id)) this.app.secretStorage.setSecret(id, '');
		}
		this.pendingOAuthSecrets.clear();
		if (this.onOutside) this.modalEl.ownerDocument.removeEventListener('mousedown', this.onOutside);
		this.contentEl.empty();
	}

	private renderHeader(title: string, description: string): HTMLDivElement {
		const header = this.contentEl.createDiv({ cls: 'scribe-dialog-header' });
		const titleEl = header.createDiv({ cls: 'scribe-dialog-title', text: title });
		header.createDiv({ cls: 'scribe-dialog-muted', text: description });
		return titleEl;
	}

	private createDraftService(credentialId = this.draftCredentialId) {
		const settings = this.plugin.services.settings;
		const baseUrls = { ...settings.communication.baseUrls };
		const draftUrl = this.draftBaseUrl.trim();
		if (draftUrl) baseUrls[this.provider.id] = draftUrl;
		else delete baseUrls[this.provider.id];
		const protocols = { ...settings.communication.protocols };
		const draftProtocol = this.draftProtocol.trim();
		if (draftProtocol) protocols[this.provider.id] = draftProtocol;
		else delete protocols[this.provider.id];
		const communication = {
			...settings.communication,
			baseUrls,
			credentialIds: {
				...settings.communication.credentialIds,
				[this.provider.id]: credentialId,
			},
		};
		return createModelService(
			createCredentialStore(this.app, communication),
			this.plugin.services.communication.transport,
			{ baseUrls: () => baseUrls, protocols: () => protocols },
		);
	}

	private catalogAddress(): string | undefined {
		return modelCatalogAddress(this.provider, this.draftBaseUrl, this.isCustomProvider());
	}

	private modelDetails(modelId: string) {
		return modelDetailsForConnection(this.provider, modelId, {
			baseUrl: this.draftBaseUrl,
			protocol: this.draftProtocol,
			catalogAddress: this.catalogAddress(),
			catalog: this.modelCatalog,
			overrides: this.draftOverrides,
		});
	}

	private confirmedModelType(modelId: string, evidence = this.modelDetails(modelId)) {
		return knownMediaModelType(this.provider.id, modelId) ?? confirmedCatalogModelType(evidence.details, evidence.bundled);
	}

	private isCustomProvider(): boolean {
		return Boolean(this.options.custom) || Boolean(this.plugin.services.settings.customProviders[this.provider.id]);
	}

	private isAdded(modelId: string): boolean {
		return this.draftModels.includes(modelId);
	}

	private toggleModel(modelId: string): void {
		const removing = this.isAdded(modelId);
		this.draftModels = removing
			? this.draftModels.filter((model) => model !== modelId)
			: [...this.draftModels, modelId];
		if (removing) delete this.draftOverrides[modelId];
		this.renderPanelRows();
		this.renderAddedList();
		this.refreshSaveState();
	}

	private refreshSaveState(): void {
		const disabled = this.options.mode === 'new' && this.draftModels.length === 0;
		for (const button of this.saveButtons) button.setDisabled(disabled);
	}

	/** 切回原端点时恢复正在编辑的内容，仍只保存当前端点。 */
	private switchTo(next: ModelProviderInfo): void {
		this.loginController?.abort();
		this.resetModelCatalog();
		this.variantDrafts.set(this.provider.id, {
			models: this.draftModels,
			overrides: this.draftOverrides,
			activeModel: this.draftActiveModel,
			credentialId: this.draftCredentialId,
			name: this.draftName,
			baseUrl: this.draftBaseUrl,
			protocol: this.draftProtocol,
		});
		this.provider = next;
		this.loadDraft(next);
		this.panelOpen = false;
		this.renderForm();
	}

	private renderForm(): void {
		this.contentEl.empty();
		// 重绘时旧引用全部失效，避免叠加上一轮的按钮和面板
		this.saveButtons = [];
		this.loginButton = null;
		this.fetchButton = null;
		this.panel = this.triggerEl = this.pickerEl = null;
		this.addedListEl = this.panelList = this.panelEmpty = this.panelStatus = this.panelTypes = this.panelResults = null;
		const headerTitle = this.renderHeader(`${this.text.configureProvider} ${this.draftName}`, this.text.configureProviderDescription);
		const scroll = this.contentEl.createDiv({ cls: 'scribe-dialog-scroll' });
		const fields = scroll.createDiv({ cls: 'scribe-dialog-fields' });

		const variants = this.options.variants ?? [];
		if (variants.length > 1) {
			const variantControl = formField(fields, this.text.providerVariant);
			const variantSelect = new DropdownComponent(variantControl);
			for (const variant of variants) variantSelect.addOption(variant.id, variant.label);
			variantSelect.setValue(this.provider.id);
			variantSelect.onChange((value) => {
				const next = variants.find((variant) => variant.id === value);
				if (next) this.switchTo(next);
			});
		}

		const nameControl = formField(fields, this.text.providerName);
		const nameInput = nameControl.createEl('input', {
			cls: 'scribe-full-input',
			attr: { type: 'text', maxlength: String(NAME_MAX), value: this.draftName, placeholder: this.provider.label },
		});
		const nameNote = nameControl.createDiv({ cls: 'scribe-field-note is-warn' });
		const renderNameNote = () => {
			const empty = !this.draftName.trim();
			nameNote.toggleClass('scribe-hidden', !empty);
			if (empty) nameNote.setText(this.text.providerNameEmptyHint.replace('{label}', this.provider.label));
		};
		nameInput.addEventListener('input', () => {
			// 超过可见宽度直接截断，避免长名称撑破输入框和卡片标题
			const clamped = clampName(nameInput.value);
			if (clamped !== nameInput.value) nameInput.value = clamped;
			this.draftName = nameInput.value;
			headerTitle.setText(`${this.text.configureProvider} ${this.draftName.trim() || this.provider.label}`);
			renderNameNote();
		});
		renderNameNote();

		const credentialControl = formField(fields, this.text.credential);
		renderCredentialLink(this.app, credentialControl, credentialControl.parentElement?.querySelector('label') ?? null, {
			text: this.text,
			read: () => this.draftCredentialId,
			change: (id) => {
				this.loginController?.abort();
				this.draftCredentialId = id;
				this.resetModelCatalog();
				void this.requestModelCatalog(baseUrlInput, false);
			},
		});
		if (this.provider.oauth) {
			this.loginButton = new ButtonComponent(credentialControl)
				.setButtonText(this.provider.oauth.subscription ? this.text.subscriptionLogin : this.text.oauthLogin);
			this.loginButton.onClick(() => void this.login());
		}

		// 本地模型：先画“本地服务”预设行，选中即填入下面的 Base URL
		let applyPreset: ((url: string) => void) | undefined;
		let presetSelect: DropdownComponent | undefined;
		if (this.provider.id.startsWith('local-')) {
			const presetControl = formField(fields, this.text.localService);
			presetSelect = new DropdownComponent(presetControl);
			for (const preset of LOCAL_PRESETS) presetSelect.addOption(preset.url, preset.label);
			presetSelect.addOption('', this.text.customAddress);
			presetSelect.setValue(LOCAL_PRESETS.some((preset) => preset.url === this.draftBaseUrl) ? this.draftBaseUrl : '');
			presetSelect.onChange((value) => {
				if (value) applyPreset?.(value);
			});
		}
		const baseUrlControl = formField(fields, this.text.baseUrl);
		const baseUrlInput = baseUrlControl.createEl('input', {
			cls: 'scribe-full-input',
			attr: { type: 'text', value: this.draftBaseUrl, placeholder: this.provider.baseUrl || this.text.baseUrlNone },
		});
		applyPreset = (url) => {
			this.draftBaseUrl = url;
			baseUrlInput.value = url;
			this.resetModelCatalog();
			void this.requestModelCatalog(baseUrlInput, false);
		};
		baseUrlInput.addEventListener('input', () => {
			this.draftBaseUrl = baseUrlInput.value;
			// 地址一改，旧的扫描结果就作废
			this.resetModelCatalog();
			if (presetSelect) {
				const matched = LOCAL_PRESETS.find((preset) => preset.url === baseUrlInput.value.trim());
				presetSelect.setValue(matched?.url ?? '');
			}
		});
		baseUrlInput.addEventListener('change', () => void this.requestModelCatalog(baseUrlInput, false));

		const protocols = [...this.provider.protocols];
		if (this.draftProtocol && !protocols.includes(this.draftProtocol)) protocols.push(this.draftProtocol);
		const protocolControl = formField(fields, this.text.protocol);
		const protocolDropdown = new DropdownComponent(protocolControl);
		if (!this.provider.protocol) protocolDropdown.addOption('', this.text.protocolAuto);
		for (const option of protocols) protocolDropdown.addOption(option, option);
		protocolDropdown.setValue(this.draftProtocol);
		protocolDropdown.onChange((value) => {
			this.draftProtocol = value;
			this.resetModelCatalog();
			void this.requestModelCatalog(baseUrlInput, false);
		});

		this.renderModelBar(baseUrlInput);
		this.renderAddedList();
		void this.requestModelCatalog(baseUrlInput, false);

		if (this.options.mode === 'new') {
			const actions = this.contentEl.createDiv({ cls: 'scribe-modal-actions is-end' });
			new ButtonComponent(actions).setButtonText(this.text.cancel).onClick(() => this.close());
			const save = new ButtonComponent(actions).setCta().setButtonText(this.text.save);
			save.onClick(() => void this.save());
			this.saveButtons.push(save);
		} else {
			const actions = this.contentEl.createDiv({ cls: 'scribe-modal-actions is-between' });
			new ButtonComponent(actions).setClass('mod-warning').setButtonText(this.text.removeProvider).onClick(() => this.remove());
			const right = actions.createDiv({ cls: 'scribe-modal-action-group' });
			new ButtonComponent(right).setButtonText(this.text.cancel).onClick(() => this.close());
			const save = new ButtonComponent(right).setCta().setButtonText(this.text.save);
			save.onClick(() => void this.save());
			this.saveButtons.push(save);
		}
		this.refreshSaveState();
	}

	private async login(): Promise<void> {
		const oauth = this.provider.oauth;
		if (!oauth || this.loginController) return;
		const providerId = this.provider.id;
		// 登录总是新建槽位，避免覆盖仍被其他服务商使用的密钥。
		const credentialId = `${this.defaultCredentialId}-oauth-${crypto.randomUUID()}`;
		this.pendingOAuthSecrets.add(credentialId);
		const button = this.loginButton;
		const controller = new AbortController();
		this.loginController = controller;
		button?.setDisabled(true).setButtonText(this.text.oauthLoggingIn);
		const interaction = createOAuthInteraction(this.app, this.text, controller.signal);
		try {
			const deviceId = await this.plugin.services.localState.getOAuthDeviceId();
			await this.createDraftService(credentialId).login(providerId, interaction, {
				agentName: 'Scribe AI',
				getDeviceId: () => deviceId,
			});
			if (!controller.signal.aborted && this.provider.id === providerId) {
				this.draftCredentialId = credentialId;
				this.resetModelCatalog();
				this.renderForm();
				new Notice(this.text.oauthLoginSucceeded);
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				new Notice(message === this.text.oauthLoginCancelled
					? message
					: `${this.text.oauthLoginFailed}: ${message}`);
			}
		} finally {
			interaction.close();
			if (this.loginController === controller) this.loginController = null;
			if (this.loginButton === button) {
				button?.setDisabled(false).setButtonText(oauth.subscription ? this.text.subscriptionLogin : this.text.oauthLogin);
			}
		}
	}

	private setPanelOpen(open: boolean): void {
		this.panelOpen = open;
		if (open) this.renderPanelRows();
		this.panel?.toggleClass('scribe-hidden', !open);
		this.triggerEl?.setAttribute('aria-expanded', String(open));
	}

	private resetModelCatalog(): void {
		this.fetchRequest?.controller.abort();
		this.fetchRequest = null;
		this.fetchedCatalog = null;
		this.modelCatalog = null;
		this.catalogMessage = '';
		this.panelType = 'text';
		this.renderPanelRows();
		this.renderAddedList();
	}

	private async requestModelCatalog(baseUrlInput: HTMLInputElement, manual: boolean): Promise<void> {
		if (this.fetchRequest?.manual || (!manual && (this.fetchRequest || this.fetchedCatalog))) return;
		const baseUrl = this.catalogAddress();
		if (baseUrl === '') {
			if (manual) new Notice(this.text.baseUrlRequired);
			return;
		}
		this.fetchRequest?.controller.abort();
		const controller = new AbortController();
		const request = this.fetchRequest = { controller, manual };
		const isCurrent = () => this.fetchRequest === request && !controller.signal.aborted;
		const provider = this.provider;
		const credentialId = this.draftCredentialId;
		const protocol = this.isCustomProvider() || this.draftProtocol !== provider.protocol ? this.draftProtocol || undefined : undefined;
		const connection = { baseUrl, credentialId, protocol };
		const catalog = this.plugin.services.communication.modelCatalog;
		this.catalogMessage = '';
		if (manual) this.setPanelOpen(false);
		this.renderPanelRows();
		let ready = false;
		try {
			const found = manual
				? await catalog.fetchConnection(provider, connection, this.createDraftService(credentialId), controller.signal)
				: await catalog.read(provider.id, baseUrl, credentialId, protocol ?? '');
			if (!isCurrent()) return;
			if (!found) {
				this.catalogMessage = manual ? this.text.modelCatalogFetchFailed : this.text.modelCatalogUnavailable;
				return;
			}
			if ((manual || this.panelOpen) && baseUrl && found.baseUrl) {
				this.draftBaseUrl = baseUrlInput.value = found.baseUrl;
			}
			this.modelCatalog = found;
			if (manual) this.fetchedCatalog = { connection, result: found };
			this.renderAddedList();
			ready = true;
		} catch {
			if (!isCurrent()) return;
			this.catalogMessage = manual ? this.text.modelCatalogFetchFailed : this.text.modelCatalogReadFailed;
		} finally {
			if (isCurrent()) {
				this.fetchRequest = null;
				if (manual && ready) {
					this.setPanelOpen(true);
					this.panelSearch?.focus();
				} else {
					this.renderPanelRows();
					if (manual && this.catalogMessage) new Notice(this.catalogMessage);
				}
			}
		}
	}

	private renderModelBar(baseUrlInput: HTMLInputElement): void {
		const bar = this.contentEl.createDiv({ cls: 'scribe-model-bar' });
		const picker = bar.createDiv({ cls: 'scribe-model-picker' });
		this.pickerEl = picker;
		const trigger = picker.createEl('button', { cls: 'scribe-model-trigger', attr: { type: 'button' } });
		this.triggerEl = trigger;
		trigger.createSpan({ text: this.text.addModel });
		const chevron = trigger.createSpan({ cls: 'scribe-model-trigger-icon' });
		setIcon(chevron, 'chevron-down');
		trigger.setAttribute('aria-expanded', String(this.panelOpen));

		const panel = picker.createDiv({ cls: 'scribe-model-panel' });
		this.panel = panel;
		panel.toggleClass('scribe-hidden', !this.panelOpen);

		panel.createDiv({ cls: 'scribe-model-panel-title', text: this.text.models });
		const search = this.panelSearch = panel.createEl('input', {
			cls: 'scribe-provider-search',
			attr: { type: 'search', placeholder: this.text.searchAvailableModels, 'aria-label': this.text.searchAvailableModels },
		});
		const manualRow = panel.createDiv({ cls: 'scribe-manual-model-row' });
		const manualInput = manualRow.createEl('input', {
			cls: 'scribe-full-input',
			attr: { type: 'text', placeholder: this.text.enterModelId },
		});
		const addButton = new ButtonComponent(manualRow).setButtonText(this.text.add).setDisabled(true);
		const addCustom = () => {
			const id = manualInput.value.trim();
			if (!id) return;
			if (!this.provider.models.some((entry) => entry.id === id)) this.customIds.add(id);
			if (!this.isAdded(id)) this.draftModels = [...this.draftModels, id];
			manualInput.value = '';
			addButton.setDisabled(true);
			this.renderPanelRows();
			this.renderAddedList();
			this.refreshSaveState();
		};
		manualInput.addEventListener('input', () => {
			addButton.setDisabled(!manualInput.value.trim());
		});
		manualInput.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			addCustom();
		});
		addButton.onClick(addCustom);
		this.panelTypes = panel.createDiv({ cls: 'scribe-model-type-tabs', attr: { role: 'tablist', 'aria-label': this.text.modelType } });
		this.panelStatus = panel.createDiv({ cls: 'scribe-dialog-muted', attr: { role: 'status' } });
		const results = this.panelResults = panel.createDiv({ cls: 'scribe-model-type-results', attr: { id: this.panelResultsId } });
		this.panelList = results.createDiv({ cls: 'scribe-model-checklist', attr: { role: 'list' } });
		this.panelEmpty = results.createDiv({ cls: 'scribe-models-empty' });
		search.addEventListener('input', () => this.renderPanelRows());

		trigger.addEventListener('click', () => {
			if (this.fetchRequest?.manual) return;
			this.setPanelOpen(!this.panelOpen);
			if (this.panelOpen) void this.requestModelCatalog(baseUrlInput, false);
		});
		this.fetchButton = new ButtonComponent(bar).setClass('scribe-model-fetch')
			.setTooltip(this.text.fetchModelsDescription).onClick(() => void this.requestModelCatalog(baseUrlInput, true));

		this.renderPanelRows();
		this.addedListEl = this.contentEl.createDiv({ cls: 'scribe-model-added-list' });
	}

	/** “添加模型”一行下方的常驻区域：显示已添加模型，浮层只管搜索与挑选。 */
	private renderAddedList(): void {
		const list = this.addedListEl;
		if (!list) return;
		list.empty();
		const title = list.createDiv({ cls: 'scribe-model-added-title', text: this.text.selectedModels });
		if (this.draftModels.length) title.createSpan({ cls: 'scribe-model-added-count', text: String(this.draftModels.length) });
		const rows = list.createDiv({ cls: 'scribe-model-added-rows', attr: { role: 'list' } });
		for (const model of this.draftModels) {
			const row = rows.createDiv({ cls: 'scribe-model-panel-row', attr: { role: 'listitem' } });
			const summary = row.createDiv({ cls: 'scribe-model-panel-summary' });
			const name = summary.createSpan({ cls: 'scribe-model-panel-name', text: model });
			name.addEventListener('pointerenter', () => updateOverflowTitle(name));
			const evidence = this.modelDetails(model);
			renderModelCapabilityIcons(summary, evidence, this.text.modelCapabilityLabels, setIcon);
			const context = evidence.override?.contextWindow ?? evidence.details?.contextWindow ?? evidence.bundled?.contextWindow ?? 0;
			const type = this.confirmedModelType(model, evidence) ?? evidence.override?.type;
			summary.createSpan({ cls: 'scribe-model-context',
				text: type && type !== 'text' ? this.text.modelTypeLabels[type] : formatContext(context) });
			const meta = row.createSpan({ cls: 'scribe-model-panel-meta' });
			new ButtonComponent(meta)
				.setIcon('pencil')
				.setTooltip(this.text.configureModel)
				.setClass('scribe-icon-button')
				.onClick(() => {
					void ScribeModelConfigModal.openFor(this.app, this.plugin, this.provider, model, this.text, {
						settingsSignal: this.options.settingsSignal,
						catalog: this.modelCatalog ?? undefined,
						providerBaseUrl: this.draftBaseUrl,
						providerProtocol: this.draftProtocol,
						providerCredentialId: this.draftCredentialId,
						customProvider: this.isCustomProvider() ? {
							label: this.draftName.trim() || this.provider.label,
							baseUrl: this.draftBaseUrl.trim(),
							protocol: this.draftProtocol,
						} : undefined,
						draft: {
							models: this.draftModels,
							overrides: this.draftOverrides,
							save: (change) => {
								const next = applyModelDraft(this.draftModels, this.draftOverrides, change);
								this.draftModels = next.models;
								this.draftOverrides = next.overrides;
								if (change.previousModel !== change.model) this.customIds.delete(change.previousModel);
								if (!this.provider.models.some((entry) => entry.id === change.model)) this.customIds.add(change.model);
								if (this.draftActiveModel === change.previousModel) this.draftActiveModel = change.model;
							},
						},
						onSaved: () => {
							this.renderAddedList();
							this.renderPanelRows();
							this.refreshSaveState();
						},
					});
				});
			const remove = meta.createSpan({ cls: 'scribe-model-panel-remove' });
			setIcon(remove, 'x');
			remove.setAttribute('aria-label', this.text.removeModel);
			remove.addEventListener('click', () => this.toggleModel(model));
		}
		if (!this.draftModels.length) rows.createDiv({ cls: 'scribe-models-empty', text: this.text.noModelsAdded });
	}

	private renderPanelRows(): void {
		const fetching = this.fetchRequest?.manual === true;
		if (this.triggerEl) this.triggerEl.disabled = fetching;
		const fetchControl = this.fetchButton?.setDisabled(fetching).buttonEl;
		if (fetchControl) {
			fetchControl.setAttribute('aria-busy', String(fetching));
			fetchControl.setAttribute('aria-label', fetching ? this.text.loadingModels : this.text.fetchModels);
			fetchControl.empty();
			fetchControl.createSpan({ cls: 'scribe-model-fetch-label', text: this.text.fetchModels });
			if (fetching) fetchControl.createSpan({ cls: 'scribe-model-fetch-spinner', attr: { 'aria-hidden': 'true' } });
		}
		const { panelList: list, panelTypes: typeTabs, panelResults: results } = this;
		if (!this.panelOpen || !list || !typeTabs || !results) return;
		list.empty();
		const normalized = this.panelSearch?.value.trim().toLowerCase() ?? '';
		const catalog = this.modelCatalog;
		const status = catalog?.source === 'provider' ? this.text.modelsFromProvider
			: catalog?.source === 'pi' ? this.text.modelsFromPi
			: catalog?.source === 'models.dev' ? this.text.modelsFromModelsDev
			: catalog?.source === 'docs' ? isVolcengineSubscriptionProvider(this.provider.id) ? this.text.modelsFromArkPlan : this.text.modelsFromDocs
			: catalog ? this.text.modelsFromBundled : '';
		const checkedAt = catalog?.updatedAt ? new Date(catalog.updatedAt) : undefined;
		const freshness = catalog ? [catalog.stale && this.text.modelsStale, catalog.partial && this.text.modelsPartial,
			checkedAt && Number.isFinite(checkedAt.getTime()) ? checkedAt.toLocaleString() : ''] : [];
		const panelStatus = [status, ...freshness, this.catalogMessage].filter(Boolean).join(' · ');
		this.panelStatus?.setText(panelStatus);
		this.panelStatus?.toggleClass('scribe-hidden', !panelStatus);
		const arkModels = this.provider.id === AGENT_PLAN_PROVIDER_ID ? Object.values(MEDIA_MODELS).flat() : [];
		const mediaModels = mediaAdapters.flatMap((adapter) => adapter.providerId === this.provider.id ? adapter.models : []);
		const availableSpecialized = catalog?.specializedModels ?? [...catalog?.details ?? []]
			.flatMap(([id, { type }]) => type && type !== 'text' ? [id] : []);
		const specialized = availableSpecialized.filter((id) => {
			const type = this.confirmedModelType(id);
			return type !== undefined && type !== 'text';
		});
		const ids = [...new Set([
			...this.draftModels, ...(catalog?.models ?? []), ...specialized, ...arkModels, ...mediaModels, ...(catalog ? this.customIds : []),
		])];
		const items = ids.map((model) => {
			const evidence = this.modelDetails(model);
			const type = this.confirmedModelType(model, evidence) ?? evidence.override?.type ?? 'text';
			return { model, evidence, type };
		});
		const typesWithModels = new Set(items.map(({ type }) => type));
		const types = CONFIGURED_MODEL_TYPES.filter((type) => typesWithModels.has(type));
		const activeType = types.includes(this.panelType) ? this.panelType : types[0];
		if (activeType) this.panelType = activeType;
		const tabId = (type: ConfiguredModelType) => `${this.panelResultsId}-${type}`;
		typeTabs.empty();
		typeTabs.toggleClass('scribe-hidden', !activeType);
		results.setAttribute('role', activeType ? 'tabpanel' : 'group');
		if (activeType) results.setAttribute('aria-labelledby', tabId(activeType));
		else results.removeAttribute('aria-labelledby');
		const selectType = (type: ConfiguredModelType) => {
			this.panelType = type;
			this.renderPanelRows();
			typeTabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
		};
		for (const [index, type] of types.entries()) {
			const selected = type === activeType;
			const tab = typeTabs.createEl('button', {
				cls: ['scribe-choice-button', ...(selected ? ['is-selected'] : [])].join(' '), text: this.text.modelTypeLabels[type],
				attr: { type: 'button', role: 'tab', id: tabId(type), 'aria-controls': this.panelResultsId,
					'aria-selected': String(selected), tabindex: selected ? '0' : '-1' },
			});
			tab.addEventListener('click', () => selectType(type));
			tab.addEventListener('keydown', (event) => {
				const next = event.key === 'ArrowLeft' ? types[(index + types.length - 1) % types.length]
					: event.key === 'ArrowRight' ? types[(index + 1) % types.length]
						: event.key === 'Home' ? types[0] : event.key === 'End' ? types.at(-1) : undefined;
				if (!next) return;
				event.preventDefault();
				selectType(next);
			});
		}
		const visible = items.filter(({ model, type }) => type === activeType && (!normalized || model.toLowerCase().includes(normalized)));
		if (this.panelEmpty) {
			this.panelEmpty.setText(normalized ? this.text.noModelsMatch
				: catalog ? this.text.noModelsDiscovered : this.text.noModelsAdded);
			this.panelEmpty.toggleClass('scribe-hidden', visible.length > 0 || this.fetchRequest !== null || Boolean(this.catalogMessage && !catalog));
		}
		for (const { model, evidence } of visible) {
			const row = list.createDiv({ cls: 'scribe-model-panel-row', attr: { role: 'listitem' } });
			const selectable = catalog || knownMediaModelType(this.provider.id, model);
			if (selectable) {
				// 圆角复选框：外观像单选，但允许多选
				const pick = row.createEl('input', {
					cls: 'scribe-model-radio',
					attr: { type: 'checkbox', 'aria-label': model, ...(this.isAdded(model) ? { checked: 'true' } : {}) },
				});
				pick.addEventListener('change', () => this.toggleModel(model));
			}
			const summary = row.createDiv({ cls: 'scribe-model-panel-summary' });
			const name = summary.createSpan({ cls: 'scribe-model-panel-name', text: model });
			name.addEventListener('pointerenter', () => updateOverflowTitle(name));
			renderModelCapabilityIcons(summary, evidence, this.text.modelCapabilityLabels, setIcon);
			if (this.isAdded(model) && !selectable) {
				const remove = row.createSpan({ cls: 'scribe-model-panel-remove' });
				setIcon(remove, 'x');
				remove.setAttribute('aria-label', this.text.removeModel);
				remove.addEventListener('click', () => this.toggleModel(model));
			}
		}
	}

	private async save(): Promise<void> {
		if (this.options.mode === 'new' && !this.draftModels.length) return;
		const name = clampName(this.draftName.trim());
		const baseUrl = this.draftBaseUrl.trim();
		const protocol = this.draftProtocol.trim();
		const custom = this.isCustomProvider();
		if (custom && !baseUrl) {
			new Notice(this.text.baseUrlRequired);
			return;
		}
		try {
			const settings = this.plugin.services.settings;
			const provider = this.provider;
			const providerId = provider.id;
			const fetched = this.fetchedCatalog;
			settings.providerModels[providerId] = [...this.draftModels];
			if (Object.keys(this.draftOverrides).length) settings.modelOverrides[providerId] = { ...this.draftOverrides };
			else delete settings.modelOverrides[providerId];
			if (settings.providerId === providerId && !this.draftModels.includes(settings.model)
				&& this.draftModels.includes(this.draftActiveModel)) {
				settings.model = this.draftActiveModel;
			}
			if (custom) {
				// 自建服务商由用户保存的名称、地址和协议定义。
				settings.customProviders[providerId] = { label: name || this.provider.label, baseUrl, protocol };
				delete settings.communication.providerNames[providerId];
				delete settings.communication.baseUrls[providerId];
				delete settings.communication.protocols[providerId];
			} else {
				if (name && name !== this.provider.label) settings.communication.providerNames[this.provider.id] = name;
				else delete settings.communication.providerNames[this.provider.id];
				if (baseUrl && baseUrl !== this.provider.baseUrl) settings.communication.baseUrls[this.provider.id] = baseUrl;
				else delete settings.communication.baseUrls[this.provider.id];
				if (protocol && protocol !== this.provider.protocol) settings.communication.protocols[this.provider.id] = protocol;
				else delete settings.communication.protocols[this.provider.id];
			}
			// 只记录真的存在于密钥库里的链接，避免留下悬空的 credentialId
			if (this.draftCredentialId && this.app.secretStorage.getSecret(this.draftCredentialId)) {
				settings.communication.credentialIds[this.provider.id] = this.draftCredentialId;
			} else {
				delete settings.communication.credentialIds[this.provider.id];
			}
			const { modelType } = this.plugin.services.communication.models;
			reconcileDefaultModel(settings, (id, model) => (id === providerId ? this.confirmedModelType(model) : undefined) ?? modelType?.(id, model));
			await this.plugin.saveSettings();
			if (this.options.settingsSignal?.aborted) return;
			if (fetched) await this.plugin.services.communication.modelCatalog.rememberConnection(provider, fetched.connection, fetched.result).catch(() => {});
			if (this.options.settingsSignal?.aborted) return;
			this.options.onSaved();
			this.close();
		} catch (error) {
			new Notice(`${this.text.saveFailed}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private remove(): void {
		confirmAction(this.app, {
			title: this.text.removeProvider,
			message: this.text.removeProviderConfirm.replace('{provider}', this.draftName.trim() || this.provider.label),
			confirmText: this.text.remove,
			cancelText: this.text.cancel,
			onConfirm: async () => {
				removeProviderSettings(this.plugin.services.settings, this.provider.id, this.plugin.services.communication.models.modelType);
				await this.plugin.saveSettings();
				this.options.onSaved();
				this.close();
			},
		});
	}
}
