import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { App } from 'obsidian';
import type ScribeAiPlugin from '../../main';
import { DEFAULT_SETTINGS } from '../../orchestration/settings/defaults';
import { AGENT_PLAN_PROVIDER_ID, confirmedCatalogModelType, IMAGE_MODELS } from '../../orchestration/settings/mediaSettings';
import type { ModelCatalogStore } from '../../orchestration/storage/modelCatalogStore';
import type { ModelCatalogResult, ModelProviderInfo, Transport } from '../../types';

type Element = {
	children: Element[];
	className: string;
	attrs: Record<string, string>;
	disabled: boolean;
	tag: string;
	text: string;
	value: string;
	emit(event: string, data?: { key: string; preventDefault(): void }): void;
};

function all(element: Element): Element[] {
	return [element, ...element.children.flatMap(all)];
}

function find(root: Element, predicate: (element: Element) => boolean): Element {
	const element = all(root).find(predicate);
	assert.ok(element);
	return element;
}

void test('the provider picker waits for fetched models and only shows candidates of the active type', async (t) => {
	const hooks = registerHooks({
		resolve: (id, context, next) => id === 'obsidian'
			? { shortCircuit: true, format: 'commonjs', url: 'test:obsidian-provider-model-picker' } : next(id, context),
		load: (url, context, next) => url === 'test:obsidian-provider-model-picker' ? {
			shortCircuit: true, format: 'commonjs', source: `
				class Element {
					children = []; events = {}; disabled = false;
					constructor(tag = 'div', { attr, text, cls } = {}) {
						this.tag = tag; this.attrs = attr ?? {}; this.value = this.attrs.value ?? '';
						this.className = cls ?? ''; this.text = text ?? '';
					}
					createEl(tag, options) {
						const child = new Element(tag, options); child.parentElement = this; this.children.push(child); return child;
					}
					createDiv(options) { return this.createEl('div', options); }
					createSpan(options) { return this.createEl('span', options); }
					querySelector(selector) {
						const attribute = /^\\[([^=]+)=["']?([^"']+)["']?\\]$/.exec(selector);
						if (!attribute) return this.children.find((child) => child.tag === selector);
						return this.children.find((child) => child.attrs[attribute[1]] === attribute[2]);
					}
					addEventListener(event, callback) { this.events[event] = callback; }
					emit(event, data) { if (!this.disabled || event !== 'click') this.events[event]?.(data); }
					toggleClass(name, enabled) {
						const names = new Set(this.className.split(' ').filter(Boolean));
						if (enabled) names.add(name);
						else names.delete(name);
						this.className = [...names].join(' ');
					}
					addClass(name) { this.toggleClass(name, true); }
					setAttribute(key, value) { this.attrs[key] = value; }
					removeAttribute(key) { delete this.attrs[key]; }
					focus() {}
					setText(text) { this.children = []; this.text = text; }
					empty() { this.children = []; this.text = ''; }
				}
				exports.getLanguage = () => 'en';
				exports.setIcon = () => {};
				exports.setTooltip = () => {};
				exports.Modal = class {
					modalEl = { addClass() {}, ownerDocument: { addEventListener() {}, removeEventListener() {} } };
					contentEl = new Element();
					constructor(app) { this.app = app; }
					open() { this.onOpen(); }
					close() { this.onClose(); }
				};
				exports.Notice = class {
					static messages = [];
					constructor(message) { exports.Notice.messages.push(message); }
				};
				exports.SecretComponent = class {
					constructor(app, parent) { this.input = parent.createEl('input', { cls: 'secret-field' }); }
					setValue(value) { this.input.value = value; return this; }
					onChange(callback) { this.input.events.change = () => callback(this.input.value); return this; }
				};
				exports.DropdownComponent = class {
					addOption() { return this; } setValue() { return this; } onChange() { return this; }
				};
				exports.ButtonComponent = class {
					constructor(parent) { this.buttonEl = parent.createEl('button'); }
					setButtonText(text) { this.buttonEl.setText(text); return this; }
					onClick(callback) { this.buttonEl.events.click = callback; return this; }
					setDisabled(value) { this.buttonEl.disabled = value; return this; }
					setTooltip() { return this; } setCta() { return this; }
					setIcon() { return this; } setClass(name) { this.buttonEl.addClass(name); return this; }
				};`,
		} : next(url, context),
	});
	t.after(() => hooks.deregister());
	const { Notice } = await import('obsidian');
	const notices = (Notice as typeof Notice & { messages: string[] }).messages;
	const { ConfigureProviderModal } = await import('../ProviderConfigModal');
	const { renderModelSettings } = await import('../ModelSettings');
	const { uiText } = await import('../uiText');
	const text = uiText();
	const settings = structuredClone(DEFAULT_SETTINGS);
	const catalog: ModelCatalogResult = {
		source: 'provider', models: ['verified-chat', 'untyped-chat'],
		specializedModels: ['verified-video', 'verified-embedding', 'conflicted-image', 'different-protocol'],
		details: new Map([
			['verified-chat', { type: 'text', inputModalities: ['text', 'image'] }],
			['verified-video', { type: 'video' }],
			['verified-embedding', { type: 'embedding' }],
			['conflicted-image', { type: 'image', evidence: { type: { source: 'provider', conflict: true } } }],
			['different-protocol', { type: 'image', connectionProtocol: 'anthropic-messages' }],
			['retired-reranker', { type: 'rerank', tools: false }],
		]),
	};
	const provider: ModelProviderInfo = {
		id: 'fixture', label: 'Fixture', models: [], baseUrl: 'https://fixture.test/v1',
		protocol: 'openai-completions', protocols: ['openai-completions'],
	};
	const app = { secretStorage: { getSecret: (id: string) => id === 'draft-secret' ? 'draft-fixture-key' : '' } } as unknown as App;
	const custom = { ...provider, id: 'custom-draft', baseUrl: 'https://before.test' };
	const requests: Array<{ url: string; auth: string | null }> = [];
	const fetch: Transport['fetch'] = async (input, init) => {
		const req = new Request(input, init);
		requests.push({ url: req.url, auth: req.headers.get('authorization') });
		return new URL(req.url).pathname === '/models' ? new Response(null, { status: 404 })
			: Response.json({ data: [{ id: 'fresh-chat', type: 'chat' }, { id: 'fresh-image', type: 'image' }] });
	};
	let resolveLate = (_catalog: ModelCatalogResult) => {};
	const pending = new Promise<ModelCatalogResult>((resolve) => { resolveLate = resolve; });
	let resolveAfterExit = (_catalog: ModelCatalogResult) => {};
	const pendingOnExit = new Promise<ModelCatalogResult>((resolve) => { resolveAfterExit = resolve; });
	const manualSignals: AbortSignal[] = [];
	const remembered: Array<Parameters<ModelCatalogStore['rememberConnection']>> = [];
	const fetchConnection: ModelCatalogStore['fetchConnection'] = async (target, connection, modelService, signal) => {
		assert.equal(target.id, custom.id);
		manualSignals.push(signal);
		if (manualSignals.length === 1) return pending;
		if (manualSignals.length === 3) throw Error('The service is temporarily unavailable');
		if (manualSignals.length === 4) return pendingOnExit;
		assert.equal(connection.credentialId, 'draft-secret');
		assert.equal(connection.protocol, 'openai-completions');
		assert.ok(connection.baseUrl);
		return { ...await modelService.listCustomModels(target.id, connection.baseUrl, signal), source: 'provider', partial: true };
	};
	const plugin = {
		services: { settings, communication: {
			modelCatalog: {
				read: (id: string) => id !== custom.id ? Promise.resolve(id === provider.id ? catalog : undefined)
					: remembered.length ? Promise.resolve(remembered[0]?.[2]) : new Promise<ModelCatalogResult>(() => {}),
				fetchConnection,
				rememberConnection: (...args: Parameters<ModelCatalogStore['rememberConnection']>) => { remembered.push(args); return Promise.resolve(); },
			},
			transport: { fetch },
			models: { providers: () => [provider],
				modelType: (id: string, model: string) => id === provider.id ? confirmedCatalogModelType(catalog.details?.get(model)) : undefined },
		} },
		saveSettings: () => Promise.resolve(),
	} as unknown as ScribeAiPlugin;
	const settingsPanel = new ConfigureProviderModal(app, plugin, provider, text, { mode: 'new', onSaved() {} }).contentEl;
	renderModelSettings(app, settingsPanel, plugin, text);
	const actions = find(settingsPanel as unknown as Element, (element) => element.className === 'scribe-models-header-actions');
	assert.equal(actions.children.length, 1);
	assert.equal(actions.children[0]?.children.at(-1)?.text, text.addProvider);

	const open = async (selected: ModelProviderInfo, settingsSignal?: AbortSignal) => {
		const modal = new ConfigureProviderModal(app, plugin, selected, text, { mode: 'new', settingsSignal, onSaved() {} });
		modal.open();
		await Promise.resolve();
		const root = modal.contentEl as unknown as Element;
		find(root, (element) => element.className === 'scribe-model-trigger').emit('click');
		return root;
	};
	const choose = (root: Element, model: string) => find(root, (element) => element.attrs['aria-label'] === model).emit('change');
	const trigger = (root: Element) => find(root, (element) => element.className.split(' ').includes('scribe-model-trigger'));
	const title = (element: Element) => all(element).map(({ text: value }) => value).join('').trim();
	const tablist = (root: Element) => find(root, (element) => element.attrs.role === 'tablist');
	const typeTab = (root: Element, kind: keyof typeof text.modelTypeLabels) =>
		find(tablist(root), (element) => element.attrs.role === 'tab' && title(element) === text.modelTypeLabels[kind]);
	const rows = (root: Element) => all(root).filter(({ tag, attrs }) => tag === 'input' && attrs.type === 'checkbox')
		.map(({ attrs }) => attrs['aria-label']);
	const save = async (root: Element) => {
		find(root, (element) => element.text === text.save).emit('click');
		await Promise.resolve();
	};

	const root = await open(provider);
	const panel = find(root, (element) => element.className.split(' ').includes('scribe-model-panel'));
	const manualRow = find(panel, (element) => element.className === 'scribe-manual-model-row');
	assert.ok(panel.children.indexOf(manualRow) < panel.children.indexOf(tablist(root)));
	assert.deepEqual(new Set(all(tablist(root)).filter(({ attrs }) => attrs.role === 'tab').map(title)),
		new Set([text.modelTypeLabels.text, text.modelTypeLabels.video, text.modelTypeLabels.embedding]));
	assert.equal(typeTab(root, 'text').attrs['aria-selected'], 'true');
	assert.deepEqual(rows(root), ['verified-chat', 'untyped-chat']);
	let handledArrow = false;
	typeTab(root, 'text').emit('keydown', { key: 'ArrowRight', preventDefault: () => { handledArrow = true; } });
	assert.equal(handledArrow, true);
	assert.equal(typeTab(root, 'video').attrs['aria-selected'], 'true');
	assert.equal(typeTab(root, 'text').attrs['aria-selected'], 'false');
	assert.deepEqual(rows(root), ['verified-video']);
	choose(root, 'verified-video');
	typeTab(root, 'embedding').emit('click');
	assert.deepEqual(rows(root), ['verified-embedding']);
	const manualId = find(root, (element) => element.attrs.placeholder === text.enterModelId);
	manualId.value = 'verified-embedding';
	manualId.emit('input');
	find(root, (element) => element.text === text.add).emit('click');
	await save(root);
	assert.deepEqual(settings.providerModels[provider.id], ['verified-video', 'verified-embedding']);
	assert.equal(settings.modelOverrides[provider.id], undefined);
	assert.equal(settings.model, '');

	const ark = await open({ ...provider, id: AGENT_PLAN_PROVIDER_ID, label: 'Ark' });
	typeTab(ark, 'image').emit('click');
	assert.deepEqual(rows(ark), [...IMAGE_MODELS]);
	choose(ark, IMAGE_MODELS[0]);
	await save(ark);
	assert.deepEqual(settings.providerModels[AGENT_PLAN_PROVIDER_ID], [IMAGE_MODELS[0]]);
	assert.equal(settings.model, '');

	const modal = new ConfigureProviderModal(app, plugin, custom, text, { mode: 'new', custom: true, onSaved() {} });
	modal.open();
	const draft = modal.contentEl as unknown as Element;
	const secret = find(draft, (element) => element.className === 'secret-field');
	secret.value = 'draft-secret';
	secret.emit('change');
	const spinner = (root: Element) => all(root).find((element) => element.className.split(' ').includes('scribe-model-fetch-spinner'));
	const fetchButton = find(draft, (element) => element.className.split(' ').includes('scribe-model-fetch'));
	const clickFetch = () => fetchButton.emit('click');
	clickFetch();
	assert.equal(manualSignals.length, 1);
	assert.equal(trigger(draft).attrs['aria-expanded'], 'false');
	assert.equal(trigger(draft).disabled, true);
	assert.equal(fetchButton.disabled, true);
	assert.equal(fetchButton.attrs['aria-label'], text.loadingModels);
	assert.ok(spinner(fetchButton));
	trigger(draft).emit('click');
	assert.equal(trigger(draft).attrs['aria-expanded'], 'false');
	const address = find(draft, (element) => element.value === custom.baseUrl);
	address.value = 'https://after.test';
	address.emit('input');
	address.emit('change');
	assert.equal(manualSignals[0]?.aborted, true);
	clickFetch();
	await new Promise<void>((resolve) => setImmediate(resolve));
	resolveLate({ source: 'provider', models: ['late-model'] });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(all(draft).some((element) => element.attrs['aria-label'] === 'late-model'), false);
	assert.deepEqual(requests, [
		{ url: 'https://after.test/models', auth: 'Bearer draft-fixture-key' },
		{ url: 'https://after.test/v1/models', auth: 'Bearer draft-fixture-key' },
	]);
	assert.equal(address.value, 'https://after.test/v1');
	assert.equal(trigger(draft).attrs['aria-expanded'], 'true');
	assert.equal(trigger(draft).disabled, false);
	assert.equal(fetchButton.disabled, false);
	assert.equal(title(fetchButton), text.fetchModels);
	assert.equal(spinner(fetchButton), undefined);
	assert.deepEqual(rows(draft), ['fresh-chat']);
	assert.ok(find(draft, (element) => element.text.includes(text.modelsPartial)));
	assert.equal(remembered.length, 0);
	assert.equal(settings.providerModels[custom.id], undefined);
	clickFetch();
	assert.equal(trigger(draft).attrs['aria-expanded'], 'false');
	assert.ok(spinner(fetchButton));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(trigger(draft).attrs['aria-expanded'], 'false');
	assert.equal(spinner(fetchButton), undefined);
	assert.equal(notices.at(-1), text.modelCatalogFetchFailed);
	trigger(draft).emit('click');
	assert.equal(trigger(draft).attrs['aria-expanded'], 'true');
	assert.ok(find(draft, (element) => element.text.includes(text.modelsFromProvider) && element.text.includes(text.modelCatalogFetchFailed)));
	typeTab(draft, 'image').emit('click');
	assert.deepEqual(rows(draft), ['fresh-image']);
	choose(draft, 'fresh-image');
	await save(draft);
	assert.deepEqual(settings.providerModels[custom.id], ['fresh-image']);
	assert.equal(settings.model, '');
	assert.equal(settings.customProviders[custom.id]?.baseUrl, 'https://after.test/v1');
	assert.equal(remembered.length, 1);
	assert.equal(remembered[0]?.[1].baseUrl, 'https://after.test');
	assert.equal(remembered[0]?.[2].baseUrl, 'https://after.test/v1');
	const lifetime = new AbortController();
	const reopened = await open(custom, lifetime.signal);
	await Promise.resolve();
	typeTab(reopened, 'text').emit('click');
	assert.deepEqual(rows(reopened), ['fresh-chat']);
	typeTab(reopened, 'image').emit('click');
	assert.deepEqual(rows(reopened), ['fresh-image']);
	assert.equal(find(reopened, (element) => element.attrs['aria-label'] === 'fresh-image').attrs.checked, 'true');
	assert.equal(manualSignals.length, 3);
	find(reopened, (element) => element.attrs['aria-label'] === text.fetchModels).emit('click');
	lifetime.abort();
	assert.equal(manualSignals[3]?.aborted, true);
	resolveAfterExit({ source: 'provider', models: ['late-after-close'] });
	await Promise.resolve();
	assert.deepEqual(reopened.children, []);
});
