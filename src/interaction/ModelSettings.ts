import {
	App,
	ButtonComponent,
	Modal,
	ToggleComponent,
	setIcon,
} from 'obsidian';
import { API_PROTOCOLS } from '../communication/providers';
import { providerCategory, type ProviderCategory } from './providerCategories';
import { groupProviders } from './providerGroups';
import { paintProviderIcon } from './paintProviderIcon';
import type ScribeAiPlugin from '../main';
import type { ModelProviderInfo } from '../types';
import { confirmAction } from './ConfirmModal';
import { ScribeModelConfigModal } from './ModelConfigModal';
import { ConfigureProviderModal } from './ProviderConfigModal';
import { removeProviderSettings } from './providerSettings';
import type { UiText } from './uiText';

/** 显示名可改，索引始终是 provider.id */
function providerLabel(plugin: ScribeAiPlugin, providerId: string, fallback: string): string {
	return plugin.services.settings.communication.providerNames[providerId] ?? fallback;
}

/** 与参考项目一致：已配置服务商列表、搜索、添加入口、折叠卡片和模型行。 */
export function renderModelSettings(
	app: App,
	panel: HTMLElement,
	plugin: ScribeAiPlugin,
	text: UiText,
	openState = new Set<string>(),
): void {
	panel.empty();
	panel.addClass('scribe-models-panel');
	const settings = plugin.services.settings;
	const modelService = plugin.services.communication.models;
	const providers = modelService.providers();
	const configuredIds = [...new Set([
		...Object.keys(settings.providerModels),
		...(settings.providerId ? [settings.providerId] : []),
	])];
	const cards = configuredIds.map((id): ModelProviderInfo => providers.find((entry) => entry.id === id) ?? {
		id,
		label: id,
		models: (settings.providerModels[id] ?? []).map((modelId) => ({
			id: modelId, contextWindow: 0, maxTokens: 0, input: ['text' as const], reasoning: false, baseUrl: '', api: '', thinkingLevels: [],
		})),
		baseUrl: '',
		protocol: '',
		protocols: [],
	});

	const header = panel.createDiv({ cls: 'scribe-models-header' });
	const heading = header.createDiv({ cls: 'scribe-models-heading' });
	heading.createDiv({ cls: 'scribe-models-title', text: text.modelsTitle });
	heading.createDiv({ cls: 'scribe-models-description', text: text.modelsDescription });
	// ButtonComponent 的 setButtonText 会清掉 setIcon 写入的图标，因此图标与文字各占一个子元素
	const addProv = header.createEl('button', { cls: 'scribe-icon-text-button' });
	const addProvIcon = addProv.createSpan({ cls: 'scribe-icon-text-icon' });
	setIcon(addProvIcon, 'plus');
	addProv.createSpan({ text: text.addProvider });
	const rerender = () => renderModelSettings(app, panel, plugin, text, openState);
	addProv.addEventListener('click', () => new AddProviderModal(app, plugin, text, rerender).open());

	const list = panel.createDiv({ cls: 'scribe-provider-list', attr: { role: 'list' } });
	const empty = panel.createDiv({ cls: 'scribe-models-empty' });

	const selectActive = async (providerId: string, model: string) => {
		settings.providerId = providerId;
		settings.model = model;
		await plugin.saveSettings();
		rerender();
	};

	const removeProvider = (provider: ModelProviderInfo) => {
		confirmAction(app, {
			title: text.removeProvider,
			message: text.removeProviderConfirm.replace('{provider}', providerLabel(plugin, provider.id, provider.label)),
			confirmText: text.remove,
			cancelText: text.cancel,
			onConfirm: async () => {
				removeProviderSettings(settings, provider.id);
				openState.delete(provider.id);
				await plugin.saveSettings();
				rerender();
			},
		});
	};

	const renderCard = (provider: ModelProviderInfo, models: string[]) => {
		const label = providerLabel(plugin, provider.id, provider.label);
		const card = list.createDiv({ cls: 'scribe-provider-card', attr: { role: 'listitem' } });
		const isOpen = openState.has(provider.id);
		const cardHeader = card.createDiv({
			cls: 'scribe-provider-header',
			attr: { role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) },
		});
		const chevron = cardHeader.createSpan({ cls: 'scribe-provider-chevron' });
		setIcon(chevron, 'chevron-right');
		const tile = cardHeader.createSpan({ cls: 'scribe-provider-icon-tile' });
		paintProviderIcon(tile, provider.id, label);
		const title = cardHeader.createDiv({ cls: 'scribe-provider-heading' });
		title.createDiv({ cls: 'scribe-provider-title', text: label });
		const subline = title.createDiv({ cls: 'scribe-provider-subline' });
		subline.createSpan({
			text: models.length ? text.modelsCount.replace('{count}', String(models.length)) : text.noModelsAdded,
		});
		const credentialId = settings.communication.credentialIds[provider.id];
		const hasCredential = Boolean(credentialId && app.secretStorage.getSecret(credentialId));
		subline.createSpan({
			cls: `scribe-provider-status ${hasCredential ? 'is-ready' : 'is-missing'}`,
			text: hasCredential ? text.credentialReady : text.credentialMissing,
		});

		const actions = cardHeader.createDiv({ cls: 'scribe-provider-actions' });
		actions.addEventListener('click', (event) => event.stopPropagation());
		actions.addEventListener('keydown', (event) => event.stopPropagation());
		new ToggleComponent(actions)
			.setValue(settings.providerId === provider.id && Boolean(settings.model))
			.setDisabled(!models.length)
			.setTooltip(text.includeProviderModels)
			.onChange(async (enabled) => {
				if (enabled && models.length) {
					await selectActive(provider.id, models[0] ?? '');
					return;
				}
				if (!enabled && settings.providerId === provider.id) {
					settings.providerId = '';
					settings.model = '';
					await plugin.saveSettings();
				}
				rerender();
			});
		new ButtonComponent(actions)
			.setIcon('settings-2')
			.setTooltip(text.editCredential)
			.setClass('scribe-icon-button')
			.onClick(() => new ConfigureProviderModal(app, plugin, provider, text, {
				mode: 'edit',
				onSaved: rerender,
			}).open());
		new ButtonComponent(actions)
			.setIcon('trash-2')
			.setTooltip(text.remove)
			.setClass('scribe-icon-button')
			.setClass('scribe-danger-icon')
			.onClick(() => removeProvider(provider));

		const content = card.createDiv({ cls: 'scribe-provider-content scribe-provider-models' });
		content.hidden = !isOpen;
		card.toggleClass('is-open', isOpen);
		if (models.length) {
			for (const model of models) {
				const row = content.createDiv({ cls: 'scribe-configured-model-row', attr: { role: 'listitem' } });
				row.createSpan({ cls: 'scribe-configured-model-name', text: model });
				const modelActions = row.createDiv({ cls: 'scribe-model-row-actions' });
				new ButtonComponent(modelActions)
					.setIcon('pencil')
					.setTooltip(text.configureModel)
					.setClass('scribe-icon-button')
					.onClick(() => new ScribeModelConfigModal(app, plugin, provider, model, text, {
						onSaved: rerender,
					}).open());
				new ButtonComponent(modelActions)
					.setIcon('x')
					.setTooltip(text.removeModel)
					.setClass('scribe-icon-button')
					.setClass('scribe-danger-icon')
					.onClick(() => confirmAction(app, {
						title: text.removeModel,
						message: text.removeModelConfirm.replace('{model}', model),
						confirmText: text.remove,
						cancelText: text.cancel,
						onConfirm: async () => {
							const remaining = (settings.providerModels[provider.id] ?? []).filter((entry) => entry !== model);
							settings.providerModels[provider.id] = remaining;
							const overrides = settings.modelOverrides[provider.id];
							if (overrides) {
								delete overrides[model];
								if (!Object.keys(overrides).length) delete settings.modelOverrides[provider.id];
							}
							if (settings.providerId === provider.id && settings.model === model) {
								settings.model = remaining[0] ?? '';
								if (!settings.model) settings.providerId = '';
							}
							await plugin.saveSettings();
							rerender();
						},
					}));
			}
		} else {
			content.createDiv({ cls: 'scribe-models-empty', text: text.noModelsAdded });
		}

		const toggle = () => {
			if (openState.has(provider.id)) openState.delete(provider.id);
			else openState.add(provider.id);
			const nowOpen = openState.has(provider.id);
			content.hidden = !nowOpen;
			card.toggleClass('is-open', nowOpen);
			cardHeader.setAttribute('aria-expanded', String(nowOpen));
		};
		cardHeader.addEventListener('click', toggle);
		cardHeader.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			toggle();
		});
	};

	const renderCards = () => {
		list.empty();
		for (const provider of cards) renderCard(provider, settings.providerModels[provider.id] ?? []);
		empty.setText(text.noProvidersYet);
		empty.hidden = cards.length > 0;
	};

	renderCards();
}

class AddProviderModal extends Modal {
	constructor(
		app: App,
		private plugin: ScribeAiPlugin,
		private text: UiText,
		private onSaved: () => void,
	) {
		super(app);
		this.titleEl.setText(text.addProvider);
	}

	private refresh = (): void => {};

	onOpen(): void {
		this.modalEl.addClass('scribe-add-provider-modal');
		this.contentEl.addClass('scribe-dialog-content');
		this.contentEl.createDiv({ cls: 'scribe-dialog-muted', text: this.text.pickProvider });
		const search = this.contentEl.createEl('input', {
			cls: 'scribe-provider-search',
			attr: { type: 'search', placeholder: this.text.searchProviders, 'aria-label': this.text.searchProviders },
		});
		const categories = this.contentEl.createDiv({ cls: 'scribe-provider-categories' });
		const tabs: Array<{ id: 'all' | ProviderCategory; el: HTMLButtonElement; count: HTMLSpanElement }> = [
			{ id: 'all', label: this.text.allProviders },
			{ id: 'domestic', label: this.text.categoryDomestic },
			{ id: 'global', label: this.text.categoryGlobal },
			{ id: 'aggregator', label: this.text.categoryAggregator },
			{ id: 'other', label: this.text.categoryOther },
		].map(({ id, label }, index) => {
			const el = categories.createEl('button', { cls: 'scribe-provider-category' });
			if (index === 0) el.addClass('is-active');
			el.createSpan({ text: label });
			return { id: id as 'all' | ProviderCategory, el, count: el.createSpan({ cls: 'scribe-provider-category-count' }) };
		});
		let category: 'all' | ProviderCategory = 'all';
		for (const tab of tabs) {
			tab.el.addEventListener('click', () => {
				category = tab.id;
				for (const entry of tabs) entry.el.toggleClass('is-active', entry.id === tab.id);
				render();
			});
		}
		const grid = this.contentEl.createDiv({ cls: 'scribe-add-provider-grid' });
		const empty = this.contentEl.createDiv({ cls: 'scribe-models-empty', text: this.text.noProvidersMatch });
		empty.hidden = true;

		const uniqueId = (prefix: string) => {
			const settings = this.plugin.services.settings;
			const existing = new Set([
				settings.providerId,
				...Object.keys(settings.customProviders),
				...Object.keys(settings.providerModels),
				...Object.keys(settings.modelOverrides),
				...Object.keys(settings.communication.credentialIds),
				...Object.keys(settings.communication.providerNames),
				...Object.keys(settings.communication.baseUrls),
				...Object.keys(settings.communication.protocols),
			]);
			let index = 1;
			while (existing.has(`${prefix}-${index}`)) index += 1;
			return `${prefix}-${index}`;
		};
		const openCustom = (kind: 'custom' | 'local') => {
			const id = uniqueId(kind);
			const provider: ModelProviderInfo = {
				id,
				label: kind === 'custom' ? this.text.customEndpoint : this.text.localModel,
				models: [],
				baseUrl: kind === 'local' ? 'http://127.0.0.1:11434/v1' : '',
				protocol: 'openai-completions',
				protocols: [...API_PROTOCOLS],
			};
			new ConfigureProviderModal(this.app, this.plugin, provider, this.text, {
				mode: 'new',
				custom: true,
				onSaved: () => {
					this.onSaved();
					this.refresh();
				},
			}).open();
		};

		const render = () => {
			grid.empty();
			const { services } = this.plugin;
			const groups = groupProviders(services.communication.models.providers()
			.filter((provider) => !Object.prototype.hasOwnProperty.call(services.settings.customProviders, provider.id)));
			const query = search.value.trim().toLowerCase();
			// 自建入口不分类，只在「全部服务商」中出现
			const customEntries = ([
				['custom', this.text.customEndpoint, this.text.customEndpointDescription, 'plug'],
				['local', this.text.localModel, this.text.localModelDescription, 'server'],
			] as const).filter(([, name, detail]) => `${name} ${detail}`.toLowerCase().includes(query));
			for (const [kind, name, detail, icon] of category === 'all' ? customEntries : []) {
				const card = grid.createDiv({
					cls: 'scribe-add-provider-card',
					attr: { role: 'button', tabindex: '0', 'aria-label': name },
				});
				const tile = card.createSpan({ cls: 'scribe-provider-icon-tile' });
				setIcon(tile, icon);
				const label = card.createSpan({ cls: 'scribe-add-provider-label' });
				label.createSpan({ cls: 'scribe-add-provider-name', text: name });
				label.createSpan({ cls: 'scribe-add-provider-detail', text: detail });
				const plus = card.createSpan({ cls: 'scribe-provider-plus' });
				setIcon(plus, 'plus');
				card.addEventListener('click', () => openCustom(kind));
				card.addEventListener('keydown', (event) => {
					if (event.key !== 'Enter' && event.key !== ' ') return;
					event.preventDefault();
					openCustom(kind);
				});
			}
			const matched = groups.filter((group) => !query
				|| group.label.toLowerCase().includes(query)
				|| group.providers.some((provider) => provider.id.toLowerCase().includes(query)
					|| provider.label.toLowerCase().includes(query)
					|| provider.models.some((model) => model.id.toLowerCase().includes(query))));
			const visible = matched.filter((group) => category === 'all'
				|| providerCategory(group.providers[0]?.id ?? group.id) === category);
			for (const tab of tabs) {
				const total = tab.id === 'all'
					? matched.length + customEntries.length
					: matched.filter((group) => providerCategory(group.providers[0]?.id ?? group.id) === tab.id).length;
				tab.count.setText(String(total));
			}
			empty.hidden = visible.length > 0 || (category === 'all' && customEntries.length > 0);
			for (const group of visible) {
				const provider = group.providers[0];
				if (!provider) continue;
				const card = grid.createDiv({
					cls: 'scribe-add-provider-card',
					attr: { role: 'button', tabindex: '0', 'aria-label': `${this.text.addProvider}: ${group.label}` },
				});
				const tile = card.createSpan({ cls: 'scribe-provider-icon-tile' });
				paintProviderIcon(tile, group.providers[0]?.id ?? group.id, group.label);
				const label = card.createSpan({ cls: 'scribe-add-provider-label' });
				label.createSpan({ cls: 'scribe-add-provider-name', text: group.label });
				label.createSpan({
					cls: 'scribe-add-provider-detail',
					text: group.providers.length > 1
						? this.text.providerEndpoints.replace('{count}', String(group.providers.length))
						: provider.id,
				});
				const plus = card.createSpan({ cls: 'scribe-provider-plus' });
				setIcon(plus, 'plus');
				const pick = () => {
					new ConfigureProviderModal(this.app, this.plugin, provider, this.text, {
						mode: 'new',
						variants: group.providers,
						onSaved: () => {
							this.onSaved();
							this.refresh();
						},
					}).open();
				};
				card.addEventListener('click', pick);
				card.addEventListener('keydown', (event) => {
					if (event.key !== 'Enter' && event.key !== ' ') return;
					event.preventDefault();
					pick();
				});
			}
		};
		search.addEventListener('input', render);
		this.refresh = render;
		render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
