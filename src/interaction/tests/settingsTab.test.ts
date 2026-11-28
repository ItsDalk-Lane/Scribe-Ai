import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { App, Setting } from 'obsidian';
import type ScribeAiPlugin from '../../main';

void test('native settings search and legacy settings open the same tabs and use the same settings', async (t) => {
	const hooks = registerHooks({
		resolve: (id, context, next) => id === 'obsidian'
			? { shortCircuit: true, format: 'commonjs', url: 'test:obsidian-settings' } : next(id, context),
		load: (url, context, next) => url === 'test:obsidian-settings' ? {
			shortCircuit: true, format: 'commonjs', source: `
				class Element {
					children = []; attrs = {}; listeners = {}; ownerDocument = { defaultView: null };
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
					setAttribute(key, value) { this.attrs[key] = value; }
					querySelectorAll() { return []; }
					remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
				}
				exports.getLanguage = () => 'en';
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
						const field = { addOption: () => field, setValue: (value) => { this.settingEl.value = value; return field; },
							setDisabled: (value) => { this.settingEl.disabled = value; return field; },
							onChange: (change) => { this.settingEl.change = change; return field; } };
						callback(field);
						return this;
					}
					addToggle(callback) { return this.addDropdown(callback); }
					addText(callback) {
						const field = { inputEl: new Element(), setValue: () => field };
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
	const settings: { chatLocation: string; confirmChatRemoval: boolean; communication: { proxyUrl: string };
		confirmFullAccessExternalActions?: boolean } = {
		chatLocation: 'right-sidebar', confirmChatRemoval: true, communication: { proxyUrl: '' },
	};
	let saved = 0;
	let rejectPermissionSave = false;
	const permissions: boolean[] = [];
	const plugin = {
		register() {},
		saveSettings() { saved++; },
		async saveFullAccessExternalActions(approved: boolean) {
			if (rejectPermissionSave) throw new Error('Save failed');
			permissions.push(approved);
			settings.confirmFullAccessExternalActions = approved;
		},
		manifest: { name: 'Scribe Ai', version: '1.0.2' },
		services: { settings, paths: { cache: '', data: '', logs: '' }, logs: { size: () => 0 },
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

		const advancedTab = Array.from(tabs.children).find((node) =>
			(node as typeof tabs).attrs.id === 'scribe-ai-settings-tab-advanced') as HTMLElement;
		advancedTab.click();
		const advanced = Array.from(container.children).find((node) => (node as typeof tabs).attrs.id === 'scribe-ai-settings-advanced');
		const rows = Array.from(advanced!.children).flatMap((group) => Array.from(group.children)) as (HTMLElement & {
			name?: string; value?: boolean; disabled?: boolean; change: (value: boolean) => Promise<void>;
		})[];
		const approval = rows.find((row) => row.name === 'Require approval for elevated actions in full access');
		assert.ok(approval);
		assert.equal(approval.value, !native);
		await approval.change(native);
		assert.equal(settings.confirmFullAccessExternalActions, native);
		assert.equal(approval.value, native);
		assert.equal(rows.at(-1)?.name, 'Current plugin version');
		if (native) {
			rejectPermissionSave = true;
			await approval.change(false);
			assert.equal(approval.value, true);
			assert.equal(approval.disabled, false);
		}
		tab.hide();
		cleanup?.();
	}
	assert.equal(saved, 2);
	assert.deepEqual(permissions, [false, true]);
});
