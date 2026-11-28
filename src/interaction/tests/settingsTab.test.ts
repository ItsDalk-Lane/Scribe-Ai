import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { App, Setting } from 'obsidian';
import type ScribeAiPlugin from '../../main';
import type { MediaSettings } from '../../orchestration/settings/mediaSettings';
import { normalizeSettings } from '../../orchestration/settings/defaults';
import { chatModelKey } from '../../orchestration/settings/thinking';
import { normalizeWebSearchSettings } from '../../tools/external/webSearchSettings';
import type { ScribeSettings } from '../../types';

void test('native settings search and legacy settings open the same tabs and use the same settings', async (t) => {
	const hooks = registerHooks({
		resolve: (id, context, next) => id === 'obsidian'
			? { shortCircuit: true, format: 'commonjs', url: 'test:obsidian-settings' } : next(id, context),
		load: (url, context, next) => url === 'test:obsidian-settings' ? {
			shortCircuit: true, format: 'commonjs', source: `
				class Element {
					children = []; attrs = {}; listeners = {}; style = {}; ownerDocument = { defaultView: null };
					createEl(_tag, options) { return this.createDiv(options); }
					createDiv({ cls, attr } = {}) {
						const element = new Element();
						element.parent = this;
						element.className = cls;
						element.attrs = attr ?? {};
						this.children.push(element);
						return element;
					}
					createSpan(options) { return this.createDiv(options); }
					addClass(cls) { this.className = cls; }
					addEventListener(name, listener) { this.listeners[name] = listener; }
					click() { this.listeners.click?.(); }
					empty() { this.children = []; }
					toggleClass() {}
					setText(text) { this.text = text; }
					setAttribute(key, value) { this.attrs[key] = value; }
					querySelectorAll() { return []; }
					remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
				}
				exports.getLanguage = () => 'en';
				exports.setIcon = () => {};
				exports.setTooltip = () => {};
				exports.Platform = { isDesktopApp: true };
				exports.Modal = class {};
				exports.Notice = class {};
				exports.PluginSettingTab = class {
					containerEl = new Element();
					hide() {}
				};
				exports.Setting = class {
					constructor(container) {
						this.settingEl = container.createDiv();
						this.controlEl = this.settingEl.createDiv();
						this.descEl = new Element();
					}
					setName(name) { this.settingEl.name = name; return this; }
					setDesc() { return this; }
					setHeading() { return this; }
					addDropdown(callback) {
						const field = { selectEl: new Element(), addOption: (value, label) => {
							(this.settingEl.options ??= []).push([value, label]); return field;
						}, setValue: (value) => { this.settingEl.value = value; return field; },
							setDisabled: (value) => { this.settingEl.disabled = value; return field; },
							onChange: (change) => { this.settingEl.change = change; return field; } };
						callback(field);
						return this;
					}
					addToggle(callback) { return this.addDropdown(callback); }
					addText(callback) {
						let value = '';
						const field = { inputEl: new Element(), setPlaceholder: () => field, setDisabled: () => field,
							setValue: (text) => { value = text; return field; }, getValue: () => value };
						this.settingEl.textField = field;
						callback(field);
						return this;
					}
					addButton(callback) {
						const button = { setButtonText: () => button, setClass: () => button, onClick: () => button };
						callback(button);
						return this;
					}
				};`,
		} : next(url, context),
	});
	t.after(() => hooks.deregister());
	const { ScribeAiSettingTab } = await import('../SettingsTab');
	const { Setting: SettingStub } = await import('obsidian');
	const settings = normalizeSettings({
		webSearch: normalizeWebSearchSettings({ provider: 'exa' }),
		media: { imageDirectory: 'Assets/Images', videoDirectory: 'Assets/Videos', speechDirectory: 'Assets/Speech' },
	});
	settings.communication.providerNames.pc = 'Provider';
	let saved = 0;
	let clearedModelCatalogs = 0;
	let rejectPermissionSave = false;
	let rejectPdfSave = false;
	const permissions: boolean[] = [];
	const plugin = {
		register() {},
		saveSettings() { saved++; },
		saveMediaSettings(update: (current: MediaSettings) => MediaSettings) {
			settings.media = update(settings.media ?? {});
			return Promise.resolve();
		},
		async savePdfModel(pdfModel: ScribeSettings['pdfModel']) {
			if (rejectPdfSave) throw new Error('Save failed');
			settings.pdfModel = normalizeSettings({ pdfModel }).pdfModel;
		},
		async saveFullAccessExternalActions(approved: boolean) {
			if (rejectPermissionSave) throw new Error('Save failed');
			permissions.push(approved);
			settings.confirmFullAccessExternalActions = approved;
		},
		manifest: { name: 'Scribe Ai', version: '1.0.2' },
		services: { settings, paths: { cache: '', data: '', logs: '' }, logs: { size: () => 0 },
			communication: { models: { providers: () => [],
				modelCapabilities: (_provider: string, model: string) => ({ pdfAnalysis: model !== 'text-only' }),
				modelType: (_provider: string, model: string) => model === 'image-model' ? 'image' : 'text' },
				modelCatalog: { clearSettings: () => { clearedModelCatalogs++; } } },
			orchestration: { skills: { library: { list: async () => [] } } } },
	} as unknown as ScribeAiPlugin;

	for (const native of [false, true]) {
		const tab = new ScribeAiSettingTab({} as App, plugin);
		let container = tab.containerEl;
		let cleanup: (() => void) | void = undefined;
		if (native) {
			const [group] = tab.getSettingDefinitions();
			assert.ok(group && 'type' in group && group.type === 'group');
			assert.equal(group.cls, 'scribe-settings-native');
			const [definition] = group.items ?? [];
			assert.ok(definition && 'render' in definition && definition.render);
			assert.equal(definition.name, 'Scribe Ai');
			assert.ok(definition.aliases?.includes('Proxy URL'));
			assert.ok(definition.aliases?.includes('Web search'));
			assert.ok(definition.aliases?.includes('PDF analysis'));
			assert.ok(definition.aliases?.includes('Media output folders'));
			assert.ok(definition.aliases?.includes('Require approval for elevated actions in full access'));
			const shell = new SettingStub(tab.containerEl);
			cleanup = definition.render(shell, {} as Parameters<typeof definition.render>[1]);
			container = shell.controlEl.children[0] as HTMLElement;
			assert.equal(shell.settingEl.className, 'scribe-settings-host');
		} else {
			const legacyHost: { display(): void } = tab;
			legacyHost.display();
		}
		const tabs = container.children[0] as HTMLElement & { attrs: Record<string, string> };
		assert.equal(tabs.attrs.role, 'tablist');
		assert.equal(tabs.children.length, 8);
		assert.deepEqual(Array.from(container.children).slice(1).map((node) => (node as HTMLElement).hidden),
			[false, true, true, true, true, true, true, true]);
		const general = container.children[1]!.children[0]!;
		const location = general.children[1] as unknown as Setting['settingEl'] & {
			change: (value: string) => Promise<void>;
		};
		await location.change(native ? 'editor-tab' : 'left-sidebar');
		assert.equal(settings.chatLocation, native ? 'editor-tab' : 'left-sidebar');
		const servicesTab = Array.from(tabs.children).find((node) =>
			(node as typeof tabs).attrs.id === 'scribe-ai-settings-tab-services') as HTMLElement;
		settings.providerModels = { pc: ['reads-pdf', 'text-only', 'image-model'], disabled: ['reads-pdf'] };
		settings.disabledProviderIds = ['disabled'];
		servicesTab.click();
		const services = Array.from(container.children).find((node) => (node as typeof tabs).attrs.id === 'scribe-ai-settings-services');
		const pdf = Array.from(services!.children).flatMap((group) => Array.from(group.children))
			.find((row) => (row as HTMLElement & { name?: string }).name === 'PDF analysis model') as HTMLElement & {
				value: string; options: [string, string][]; change(value: string): Promise<void>;
			};
		const model = chatModelKey('pc', 'reads-pdf');
		assert.ok(pdf);
		assert.deepEqual(pdf.options, [['', 'Not configured'], [model, 'Provider / reads-pdf']]);
		assert.equal(pdf.value, native ? model : '');
		await pdf.change(chatModelKey('pc', 'text-only'));
		assert.equal(settings.pdfModel?.model, native ? 'reads-pdf' : undefined);
		rejectPdfSave = native;
		await pdf.change(native ? '' : model);
		assert.deepEqual(settings.pdfModel, { providerId: 'pc', model: 'reads-pdf' });
		if (native) {
			assert.equal(pdf.value, model);
			rejectPdfSave = false;
			await pdf.change('');
			assert.equal(settings.pdfModel, undefined);
		}
		settings.providerModels = {};
		settings.disabledProviderIds = [];

		const advancedTab = Array.from(tabs.children).find((node) =>
			(node as typeof tabs).attrs.id === 'scribe-ai-settings-tab-advanced') as HTMLElement;
		advancedTab.click();
		const advanced = Array.from(container.children).find((node) => (node as typeof tabs).attrs.id === 'scribe-ai-settings-advanced');
		const rows = Array.from(advanced!.children).flatMap((group) => Array.from(group.children)) as (HTMLElement & {
			name?: string; value?: boolean; disabled?: boolean; change: (value: boolean) => Promise<void>;
			textField?: { getValue(): string; setValue(value: string): void; inputEl: { listeners: { change(): void } } };
		})[];
		const approval = rows.find((row) => row.name === 'Require approval for elevated actions in full access');
		assert.ok(approval);
		assert.equal(approval.value, !native);
		await approval.change(native);
		assert.equal(settings.confirmFullAccessExternalActions, native);
		assert.equal(approval.value, native);
		assert.ok(rows.some((row) => row.name === 'Current plugin version'));
		for (const [label, key] of [['Image output folder', 'imageDirectory'], ['Video output folder', 'videoDirectory'],
			['Generated speech output folder', 'speechDirectory']] as const) {
			const field = rows.find((row) => row.name === label)?.textField;
			assert.ok(field);
			assert.equal(field.getValue(), settings.media?.[key]);
			const updated = `${settings.media?.[key]}/New`;
			field.setValue(updated);
			field.inputEl.listeners.change();
			assert.equal(settings.media?.[key], updated);
		}
		if (native) {
			rejectPermissionSave = true;
			await approval.change(false);
			assert.equal(approval.value, true);
			assert.equal(approval.disabled, false);
		}
		const modelTab = Array.from(tabs.children).find((node) =>
			(node as typeof tabs).attrs.id === 'scribe-ai-settings-tab-models') as HTMLElement;
		const clearedBefore = clearedModelCatalogs;
		modelTab.click();
		assert.equal(clearedModelCatalogs, clearedBefore);
		advancedTab.click();
		assert.equal(clearedModelCatalogs, clearedBefore + 1);
		modelTab.click();
		if (native) cleanup?.();
		else tab.hide();
		assert.equal(clearedModelCatalogs, clearedBefore + 2);
		tab.hide();
	}
	assert.equal(saved, 2);
	assert.deepEqual(permissions, [false, true]);
});
