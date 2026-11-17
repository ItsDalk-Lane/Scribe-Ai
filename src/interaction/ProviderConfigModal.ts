import {
	App,
	ButtonComponent,
	DropdownComponent,
	Modal,
	Notice,
	SecretComponent,
	setIcon,
} from 'obsidian';
import { createCredentialStore, credentialIdForProvider } from '../communication/credentials';
import { createModelService } from '../communication/providers';
import type ScribeAiPlugin from '../main';
import type { ModelOverride, ModelProviderInfo } from '../types';
import { confirmAction } from './ConfirmModal';
import { applyModelDraft } from './modelDraft';
import { createOAuthInteraction } from './oauthInteraction';
import { ScribeModelConfigModal } from './ModelConfigModal';
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
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
	return `${Math.round(tokens / 1000)}K`;
}

interface ConfigureOptions {
	mode: 'new' | 'edit';
	/** 自建服务商（自定义端点/本地模型），名称与地址写入 customProviders */
	custom?: boolean;
	/** 添加服务商时可选择同一厂商的不同端点 */
	variants?: ModelProviderInfo[];
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
	private showAll = false;
	/** 自建/本地服务商从 /models 扫回来的模型 ID */
	private remoteModels: string[] = [];
	private panel: HTMLElement | null = null;
	private triggerEl: HTMLButtonElement | null = null;
	private pickerEl: HTMLElement | null = null;
	private addedListEl: HTMLElement | null = null;
	private saveButtons: ButtonComponent[] = [];
	private onOutside: ((event: MouseEvent) => void) | null = null;
	private panelList: HTMLDivElement | null = null;
	private panelEmpty: HTMLDivElement | null = null;
	private panelSearch?: HTMLInputElement;
	private loginController: AbortController | null = null;
	private loginButton: ButtonComponent | null = null;
	private pendingOAuthSecrets = new Set<string>();

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

	private contextOf(modelId: string): number {
		return this.provider.models.find((entry) => entry.id === modelId)?.contextWindow ?? 0;
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
		this.remoteModels = [];
		this.showAll = false;
		this.panelOpen = false;
		this.renderForm();
	}

	private renderForm(): void {
		this.contentEl.empty();
		// 重绘时旧引用全部失效，避免叠加上一轮的按钮和面板
		this.saveButtons = [];
		this.loginButton = null;
		this.panel = this.triggerEl = this.pickerEl = null;
		this.addedListEl = this.panelList = this.panelEmpty = null;
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
		const dot = credentialControl.parentElement?.querySelector('label')?.createSpan({ cls: 'scribe-secret-dot' });
		const credentialRow = credentialControl.createDiv({ cls: 'scribe-secret-row' });
		// SecretComponent 自带 Obsidian 原生的选择/新建密钥弹窗，这里只把它的按钮藏起来做代理
		const secretHost = credentialRow.createDiv({ cls: 'scribe-secret-host' });
		const credential = new SecretComponent(this.app, secretHost);
		credential.setValue(this.draftCredentialId);
		const linkButton = credentialRow.createEl('button', { cls: 'scribe-secret-button', attr: { type: 'button' } });
		const unlinkButton = credentialRow.createEl('button', {
			cls: 'scribe-secret-unlink',
			attr: { type: 'button', 'aria-label': this.text.credentialUnlink },
		});
		setIcon(unlinkButton, 'trash-2');
		const isLinked = () => Boolean(this.draftCredentialId && this.app.secretStorage.getSecret(this.draftCredentialId));
		const renderSecret = () => {
			const linked = isLinked();
			linkButton.setText(linked ? this.text.credentialLinked : this.text.credentialLink);
			linkButton.toggleClass('is-linked', linked);
			unlinkButton.toggleClass('scribe-hidden', !linked);
			dot?.toggleClass('scribe-hidden', !linked);
		};
		linkButton.addEventListener('click', () => {
			secretHost.querySelector('button')?.click();
		});
		unlinkButton.addEventListener('click', () => {
			this.loginController?.abort();
			this.draftCredentialId = '';
			credential.setValue('');
			renderSecret();
		});
		credential.onChange((value) => {
			this.loginController?.abort();
			this.draftCredentialId = value ?? '';
			renderSecret();
		});
		renderSecret();
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
			this.remoteModels = [];
			if (this.showAll) this.renderPanelRows();
		};
		baseUrlInput.addEventListener('input', () => {
			this.draftBaseUrl = baseUrlInput.value;
			// 地址一改，旧的扫描结果就作废
			this.remoteModels = [];
			if (presetSelect) {
				const matched = LOCAL_PRESETS.find((preset) => preset.url === baseUrlInput.value.trim());
				presetSelect.setValue(matched?.url ?? '');
			}
		});

		const protocols = [...this.provider.protocols];
		if (this.draftProtocol && !protocols.includes(this.draftProtocol)) protocols.push(this.draftProtocol);
		const protocolControl = formField(fields, this.text.protocol);
		const protocolDropdown = new DropdownComponent(protocolControl);
		if (!this.provider.protocol) protocolDropdown.addOption('', this.text.protocolAuto);
		for (const option of protocols) protocolDropdown.addOption(option, option);
		protocolDropdown.setValue(this.draftProtocol);
		protocolDropdown.onChange((value) => {
			this.draftProtocol = value;
		});

		this.renderModelBar(baseUrlInput);
		this.renderAddedList();

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
			await this.createDraftService(credentialId).login(providerId, interaction, {
				agentName: 'Scribe AI',
				getDeviceId: () => {
					const stored: unknown = this.app.loadLocalStorage('oauth-device-id');
					if (typeof stored === 'string' && stored) return stored;
					const id = crypto.randomUUID();
					this.app.saveLocalStorage('oauth-device-id', id);
					return id;
				},
			});
			if (!controller.signal.aborted && this.provider.id === providerId) {
				this.draftCredentialId = credentialId;
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
		this.panel?.toggleClass('scribe-hidden', !open);
		this.triggerEl?.setAttribute('aria-expanded', String(open));
		if (open) this.renderPanelRows();
	}

	private renderModelBar(baseUrlInput: HTMLInputElement): void {
		const bar = this.contentEl.createDiv({ cls: 'scribe-model-bar' });
		// 触发按钮铺满到「获取模型」左侧，面板宽度跟随它
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

		panel.createDiv({ cls: 'scribe-model-panel-title', text: this.text.selectedModels });
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
		this.panelList = panel.createDiv({ cls: 'scribe-model-checklist', attr: { role: 'list' } });
		this.panelEmpty = panel.createDiv({ cls: 'scribe-models-empty' });
		search.addEventListener('input', () => this.renderPanelRows());

		trigger.addEventListener('click', () => this.setPanelOpen(!this.panelOpen));

		const fetchButton = new ButtonComponent(bar).setButtonText(this.text.fetchModels);
		const setFetching = (busy: boolean) => {
			fetchButton.setDisabled(busy).setButtonText(busy ? this.text.refreshing : this.text.fetchModels);
		};
		fetchButton.onClick(async () => {
			const provider = this.provider;
			const baseUrl = this.draftBaseUrl.trim();
			const credentialId = this.draftCredentialId;
			const isCurrent = () => panel.isConnected && this.panel === panel && this.provider.id === provider.id
				&& this.draftBaseUrl.trim() === baseUrl && this.draftCredentialId === credentialId;
			setFetching(true);
			this.showAll = true;
			this.setPanelOpen(true);
			try {
				const service = this.createDraftService();
				// 改过地址时只访问用户填写的端点，不能把草稿密钥交给内置目录。
				if (this.isCustomProvider() || (baseUrl && baseUrl.replace(/\/+$/, '') !== provider.baseUrl.replace(/\/+$/, ''))) {
					if (!baseUrl) {
						new Notice(this.text.baseUrlRequired);
						return;
					}
					const found = await service.listCustomModels(provider.id, baseUrl);
					if (!isCurrent()) return;
					if (found.baseUrl !== baseUrl) {
						baseUrlInput.value = found.baseUrl;
						baseUrlInput.dispatchEvent(new Event('input'));
					}
					this.remoteModels = found.models;
				} else {
					await service.refresh(provider.id);
					if (!isCurrent()) return;
					this.provider = service.providers().find((entry) => entry.id === provider.id) ?? provider;
					for (const model of this.draftModels) {
						if (!this.provider.models.some((entry) => entry.id === model)) this.customIds.add(model);
					}
				}
			} catch (error) {
				if (isCurrent()) new Notice(`${this.text.refreshModelsFailed}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				setFetching(false);
				if (panel.isConnected && this.panel === panel) this.renderPanelRows();
			}
		});

		this.renderPanelRows();
		this.addedListEl = this.contentEl.createDiv({ cls: 'scribe-model-added-list' });
	}

	/** “添加模型”一行下方的常驻区域：显示已添加模型，向上浮面板只管搜索与挑选 */
	private renderAddedList(): void {
		const list = this.addedListEl;
		if (!list) return;
		list.empty();
		const title = list.createDiv({ cls: 'scribe-model-added-title', text: this.text.selectedModels });
		if (this.draftModels.length) title.createSpan({ cls: 'scribe-model-added-count', text: String(this.draftModels.length) });
		const rows = list.createDiv({ cls: 'scribe-model-added-rows', attr: { role: 'list' } });
		for (const model of this.draftModels) {
			const row = rows.createDiv({ cls: 'scribe-model-panel-row', attr: { role: 'listitem' } });
			row.createSpan({ cls: 'scribe-model-panel-name', text: model });
			// 上下文长度紧跟模型 ID，右侧只放操作按钮
			row.createSpan({ cls: 'scribe-model-context', text: formatContext(this.contextOf(model)) });
			const meta = row.createSpan({ cls: 'scribe-model-panel-meta' });
			new ButtonComponent(meta)
				.setIcon('pencil')
				.setTooltip(this.text.configureModel)
				.setClass('scribe-icon-button')
				.onClick(() => {
					new ScribeModelConfigModal(this.app, this.plugin, this.provider, model, this.text, {
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
					}).open();
				});
			const remove = meta.createSpan({ cls: 'scribe-model-panel-remove' });
			setIcon(remove, 'x');
			remove.setAttribute('aria-label', this.text.removeModel);
			remove.addEventListener('click', () => this.toggleModel(model));
		}
		if (!this.draftModels.length) rows.createDiv({ cls: 'scribe-models-empty', text: this.text.noModelsAdded });
	}

	private renderPanelRows(): void {
		const list = this.panelList;
		if (!list) return;
		list.empty();
		const normalized = this.panelSearch?.value.trim().toLowerCase() ?? '';
		// 获取模型之后是全部目录模型 + 手填的 ID，默认只显示已添加的
		const ids = this.showAll
			? [...new Set([...this.draftModels, ...this.provider.models.map((entry) => entry.id), ...this.remoteModels, ...this.customIds])]
			: [...this.draftModels];
		const visible = ids.filter((model) => !normalized || model.toLowerCase().includes(normalized));
		if (this.panelEmpty) {
			this.panelEmpty.setText(normalized ? this.text.noModelsMatch : this.text.noModelsAdded);
			this.panelEmpty.toggleClass('scribe-hidden', visible.length > 0);
		}
		for (const model of visible) {
			const row = list.createDiv({ cls: 'scribe-model-panel-row', attr: { role: 'listitem' } });
			if (this.showAll) {
				// 圆角复选框：外观像单选，但允许多选
				const pick = row.createEl('input', {
					cls: 'scribe-model-radio',
					attr: { type: 'checkbox', 'aria-label': model, ...(this.isAdded(model) ? { checked: 'true' } : {}) },
				});
				pick.addEventListener('change', () => this.toggleModel(model));
			}
			row.createSpan({ cls: 'scribe-model-panel-name', text: model });
			const meta = row.createSpan({ cls: 'scribe-model-panel-meta' });
			meta.createSpan({ cls: 'scribe-model-context', text: formatContext(this.contextOf(model)) });
			if (this.isAdded(model) && !this.showAll) {
				const remove = meta.createSpan({ cls: 'scribe-model-panel-remove' });
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
			const providerId = this.provider.id;
			const firstProvider = this.options.mode === 'new' && !settings.providerId && !Object.keys(settings.providerModels).length;
			settings.providerModels[providerId] = [...this.draftModels];
			if (Object.keys(this.draftOverrides).length) settings.modelOverrides[providerId] = { ...this.draftOverrides };
			else delete settings.modelOverrides[providerId];
			if (firstProvider || settings.providerId === providerId) {
				settings.model = this.draftModels.includes(this.draftActiveModel) ? this.draftActiveModel : (this.draftModels[0] ?? '');
				settings.providerId = settings.model ? providerId : '';
			}
			if (custom) {
				// 自建服务商没有目录，名称/地址/协议就是它的定义本身
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
			await this.plugin.saveSettings();
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
				removeProviderSettings(this.plugin.services.settings, this.provider.id);
				await this.plugin.saveSettings();
				this.options.onSaved();
				this.close();
			},
		});
	}
}
