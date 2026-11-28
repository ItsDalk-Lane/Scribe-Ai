import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { App } from 'obsidian';
import type ScribeAiPlugin from '../../main';
import { AGENT_PLAN_PROVIDER_ID, IMAGE_MODELS, MEDIA_MODELS, VIDEO_MODELS } from '../../orchestration/settings/mediaSettings';
import type { ModelCatalogDetails, ModelCatalogResult, ModelProviderInfo, ModelOverride } from '../../types';

type Element = {
	tag: string;
	text: string;
	className: string;
	children: Element[];
	attrs: Record<string, string>;
	value: string;
	options: Array<{ value: string; text: string }>;
	checked: boolean;
	disabled: boolean;
	emit(name: string): void | Promise<void>;
};

void test('the model editor shows only applicable controls and locks confirmed types to the current connection', async (t) => {
	const hooks = registerHooks({
		resolve: (id, context, next) => id === 'obsidian'
			? { shortCircuit: true, format: 'commonjs', url: 'test:obsidian-model-config' } : next(id, context),
		load: (url, context, next) => url === 'test:obsidian-model-config' ? {
			shortCircuit: true, format: 'commonjs', source: `
				class Element {
					children = []; attrs = {}; events = {}; options = [];
					constructor(tag = 'div', { attr, text, cls } = {}) {
						this.tag = tag; this.attrs = attr ?? {}; this.value = this.attrs.value ?? ''; this.text = text ?? '';
						this.className = cls ?? ''; this.hidden = false; this.disabled = false;
					}
					createEl(tag, options) {
						const child = new Element(tag, options);
						child.parentElement = this;
						this.children.push(child);
						return child;
					}
					createDiv(options) { return this.createEl('div', options); }
					createSpan(options) { return this.createEl('span', options); }
					toggleClass(name, active) {
						const classes = new Set(this.className.split(' ').filter(Boolean));
						if (active) classes.add(name);
						else classes.delete(name);
						this.className = [...classes].join(' ');
					}
					addClass() {}
					setText(text) { this.text = text; }
					setAttribute(key, value) { this.attrs[key] = value; }
					addEventListener(name, callback) { this.events[name] = callback; }
					emit(name) { return this.events[name]?.(); }
					querySelectorAll() { return []; }
					insertBefore(node, reference) {
						this.children = this.children.filter((child) => child !== node);
						this.children.splice(this.children.indexOf(reference), 0, node);
					}
					focus() {}
					empty() { this.children = []; this.options = []; }
				}
				exports.getLanguage = () => 'en';
				exports.setIcon = () => {};
				let openModal;
				exports.getOpenModal = () => openModal;
				exports.Modal = class {
					modalEl = new Element();
					contentEl = new Element();
					constructor(app) { this.app = app; }
					open() { openModal = this; this.onOpen(); }
					close() { this.onClose(); }
				};
				exports.Notice = class { constructor(message) { throw Error(message); } };
				exports.DropdownComponent = class {
					constructor(parent) { this.selectEl = parent.createEl('select'); }
					addOption(value, text) { this.selectEl.options.push({ value, text }); return this; }
					setValue(value) { this.selectEl.value = value; return this; }
					setDisabled(disabled) { this.selectEl.disabled = disabled; return this; }
					onChange(callback) { this.selectEl.events.change = () => callback(this.selectEl.value); return this; }
				};
				exports.ToggleComponent = class {
					constructor(parent) { this.toggleEl = parent.createEl('input', { attr: { type: 'checkbox' } }); }
					setValue(value) { this.toggleEl.checked = value; return this; }
					onChange(callback) {
						this.toggleEl.events.click = () => {
							this.toggleEl.checked = !this.toggleEl.checked;
							return callback(this.toggleEl.checked);
						};
						return this;
					}
				};
				exports.ButtonComponent = class {
					constructor(parent) { this.buttonEl = parent.createEl('button'); }
					setButtonText(value) { this.buttonEl.text = value; return this; }
					setCta() { return this; }
					onClick(callback) { this.buttonEl.events.click = callback; return this; }
					setDisabled(disabled) { this.buttonEl.disabled = disabled; return this; }
				};`,
		} : next(url, context),
	});
	t.after(() => hooks.deregister());
	const { ScribeModelConfigModal } = await import('../ModelConfigModal');
	const { uiText } = await import('../uiText');
	const obsidian = await import('obsidian') as unknown as { getOpenModal(): { contentEl: Element } };
	const { app, plugin, settings, refreshCatalog } = fixture();
	const text = uiText();
	const open = async (model: string, connection = provider) => {
		await ScribeModelConfigModal.openFor(app, plugin, connection, model, text, { onSaved: () => {} });
		return obsidian.getOpenModal().contentEl;
	};

	const manualId = 'manual-text-model';
	const textEditor = await open(manualId);
	assert.deepEqual(labels(textEditor).slice(2, 5), [text.protocol, text.modelType, text.contextWindow]);
	within(textEditor, (elt) => elt.attrs['aria-label'] === text.contextWindow).value = '200000';
	await within(textEditor, (elt) => elt.attrs['aria-label'] === text.contextWindow).emit('input');
	await within(textEditor, (elt) => elt.tag === 'button' && elt.children.some((child) => child.text === 'Image')).emit('click');
	assert.ok(!labels(textEditor).includes(text.contextWindow));
	assert.match(within(textEditor, (elt) => elt.text === text.testConnection).className, /\bscribe-hidden\b/u);
	const manualModelId = within(textEditor, (elt) => elt.attrs['aria-label'] === text.modelId);
	manualModelId.value = 'another-manual-id';
	await manualModelId.emit('input');
	assert.ok(labels(textEditor).includes(text.contextWindow));
	manualModelId.value = 'glm-5.3-flash';
	await manualModelId.emit('input');
	const officialType = modelTypeButtons(textEditor, text.modelType);
	assert.deepEqual(officialType.map(({ children }) => children.at(-1)?.text), ['Text']);
	assert.equal(officialType[0]?.disabled, true);
	assert.ok(labels(textEditor).includes(text.contextWindow));
	manualModelId.value = manualId;
	await manualModelId.emit('input');
	assert.ok(!labels(textEditor).includes(text.contextWindow));
	await within(textEditor, (elt) => elt.tag === 'button' && elt.children.some((child) => child.text === 'Text')).emit('click');
	assert.equal(within(textEditor, (elt) => elt.attrs['aria-label'] === text.contextWindow).value, '200000');

	const imageEditor = await open(IMAGE_MODELS[0]);
	assert.deepEqual(modelTypeButtons(imageEditor, text.modelType).map(({ children }) => children.at(-1)?.text), ['Image']);
	assert.ok(labels(imageEditor).includes('Image size'));
	assert.ok(!labels(imageEditor).includes(text.contextWindow));
	assert.ok(!labels(imageEditor).includes('Video resolution'));
	assert.match(within(imageEditor, (elt) => elt.text === text.testConnection).className, /\bscribe-hidden\b/u);
	const format = within(imageEditor, (elt) => elt.attrs['aria-label'] === 'Image format');
	assert.equal(format.value, 'png');
	format.value = 'jpeg';
	await format.emit('change');
	await within(imageEditor, (elt) => elt.text === text.save).emit('click');
	assert.deepEqual(settings.modelOverrides[AGENT_PLAN_PROVIDER_ID]?.[IMAGE_MODELS[0]], { imageDefaults: { size: '1K', format: 'jpeg' } });
	assert.deepEqual(settings.providerModels[AGENT_PLAN_PROVIDER_ID], ['glm-5.3-flash', IMAGE_MODELS[0], VIDEO_MODELS[0],
		MEDIA_MODELS['speech-synthesis'][0], MEDIA_MODELS['speech-recognition'][0]]);

	const videoEditor = await open(VIDEO_MODELS[0]);
	assert.ok(labels(videoEditor).includes('Video resolution'));
	assert.ok(!labels(videoEditor).includes('Image size'));
	assert.ok(!labels(videoEditor).includes(text.contextWindow));

	const synthesisModel = MEDIA_MODELS['speech-synthesis'][0];
	const synthesis = await open(synthesisModel);
	const voice = byLabel(synthesis, 'Synthesis voice');
	assert.equal(voice.value, 'custom_voice');
	const outputFormat = byLabel(synthesis, 'Output format');
	const sampleRate = byLabel(synthesis, 'Sample rate');
	assert.equal(outputFormat.value, 'mp3');
	assert.equal(sampleRate.value, '24000');
	outputFormat.value = 'ogg_opus';
	await outputFormat.emit('change');
	assert.deepEqual(sampleRate.options.map((entry) => entry.value), ['48000']);
	assert.equal(sampleRate.value, '48000');
	assert.equal(sampleRate.disabled, true);
	outputFormat.value = 'wav';
	await outputFormat.emit('change');
	assert.ok(sampleRate.options.some((entry) => entry.value === '16000'));
	assert.equal(sampleRate.disabled, false);
	sampleRate.value = '16000';
	await sampleRate.emit('change');
	const speechRate = byLabel(synthesis, 'Speech rate adjustment (%)');
	const volume = byLabel(synthesis, 'Volume adjustment (%)');
	assert.equal(speechRate.value, '0');
	assert.equal(volume.value, '0');
	speechRate.value = '-20';
	volume.value = '30';
	await speechRate.emit('input');
	await volume.emit('input');
	await within(synthesis, (elt) => elt.text === text.save).emit('click');
	assert.deepEqual(settings.modelOverrides[AGENT_PLAN_PROVIDER_ID]?.[synthesisModel], {
		voice: 'custom_voice', speechSynthesis: { format: 'wav', sampleRate: 16_000, speechRate: -20, loudnessRate: 30 },
	});
	const reopenedSynthesis = await open(synthesisModel);
	assert.equal(byLabel(reopenedSynthesis, 'Output format').value, 'wav');
	assert.equal(byLabel(reopenedSynthesis, 'Sample rate').value, '16000');

	const recognitionModel = MEDIA_MODELS['speech-recognition'][0];
	const recognition = await open(recognitionModel);
	assert.ok(!labels(recognition).includes('Output format'));
	const recognitionOptions = ['Automatic punctuation', 'Text normalization', 'Sentence segments'];
	assert.deepEqual(recognitionOptions.map((label) => byLabel(recognition, label).checked), [true, true, false]);
	for (const label of recognitionOptions) await byLabel(recognition, label).emit('click');
	await within(recognition, (elt) => elt.text === text.save).emit('click');
	assert.deepEqual(settings.modelOverrides[AGENT_PLAN_PROVIDER_ID]?.[recognitionModel], {
		speechRecognition: { enablePunctuation: false, normalizeText: false, showUtterances: true },
	});
	const reopenedRecognition = await open(recognitionModel);
	assert.deepEqual(recognitionOptions.map((label) => byLabel(reopenedRecognition, label).checked), [false, false, true]);

	const known = await open('catalog-text');
	const [textType] = modelTypeButtons(known, text.modelType);
	assert.equal(modelTypeButtons(known, text.modelType).length, 1);
	assert.equal(textType?.children.at(-1)?.text, 'Text');
	assert.equal(textType?.attrs['aria-pressed'], 'true');
	assert.equal(textType?.disabled, true);
	assert.ok(labels(known).includes(text.contextWindow));
	const modelId = within(known, (elt) => elt.attrs['aria-label'] === text.modelId);
	modelId.value = 'catalog-rerank';
	await modelId.emit('input');
	assert.deepEqual(modelTypeButtons(known, text.modelType).map(({ children }) => children.at(-1)?.text), ['Reranking']);
	assert.ok(!labels(known).includes(text.contextWindow));
	assert.match(within(known, (elt) => elt.text === text.testConnection).className, /\bscribe-hidden\b/u);

	const baseUrl = within(known, (elt) => elt.attrs['aria-label'] === text.baseUrl);
	baseUrl.value = 'https://alternate.example/v1';
	await baseUrl.emit('input');
	assert.equal(modelTypeButtons(known, text.modelType).length, 7);
	assert.ok(labels(known).includes(text.contextWindow));
	baseUrl.value = '';
	await baseUrl.emit('input');
	const protocol = within(known, (elt) => elt.attrs['aria-label'] === text.protocol);
	protocol.value = 'anthropic-messages';
	await protocol.emit('change');
	assert.equal(modelTypeButtons(known, text.modelType).length, 7);
	protocol.value = '';
	await protocol.emit('change');
	assert.deepEqual(modelTypeButtons(known, text.modelType).map(({ children }) => children.at(-1)?.text), ['Reranking']);

	modelId.value = 'catalog-conflicted';
	await modelId.emit('input');
	assert.equal(modelTypeButtons(known, text.modelType).length, 7);
	assert.ok(labels(known).includes(text.contextWindow));
	modelId.value = 'catalog-text';
	await modelId.emit('input');
	await within(known, (elt) => elt.text === text.save).emit('click');
	assert.equal(settings.modelOverrides[AGENT_PLAN_PROVIDER_ID]?.['catalog-text']?.type, undefined);

	const audio = await open('catalog-audio');
	assert.deepEqual(modelTypeButtons(audio, text.modelType).map(({ children }) => children.at(-1)?.text), ['Audio']);
	assert.ok(!labels(audio).includes(text.contextWindow));
	await refreshCatalog('catalog-audio', { type: 'speech-recognition' });
	assert.deepEqual(modelTypeButtons(audio, text.modelType).map(({ children }) => children.at(-1)?.text), ['Speech recognition']);

	const openai = { ...provider, id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' };
	const image = await open('gpt-image-1.5', openai);
	assert.ok(labels(image).includes('Source fidelity'));
	assert.ok(!labels(image).includes('Width × height (pixels)'));
	assert.ok(!labels(image).includes(text.contextWindow));
	const quality = byLabel(image, 'Render quality');
	quality.value = 'high';
	await quality.emit('change');
	await byLabel(image, 'Source fidelity').emit('change');
	await within(image, (elt) => elt.text === text.save).emit('click');
	assert.deepEqual(settings.modelOverrides.openai?.['gpt-image-1.5']?.mediaOptions, { image: { quality: 'high' } });
	const xai = { ...provider, id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1' };
	const speech = await open('grok-voice-tts', xai);
	assert.ok(labels(speech).includes('Audio codec'));
	assert.ok(labels(speech).includes('Sample rate (Hz)'));
	assert.ok(!labels(speech).includes('Voice instructions'));
});

const provider: ModelProviderInfo = {
	id: AGENT_PLAN_PROVIDER_ID, label: 'Agent Plan', models: [],
	baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', protocol: 'openai-completions', protocols: ['openai-completions', 'anthropic-messages'],
};

function fixture() {
	const details = new Map<string, ModelCatalogDetails>([
		['catalog-text', { type: 'text' }],
		['catalog-rerank', { type: 'rerank' }],
		['catalog-conflicted', { type: 'image', evidence: { type: { source: 'provider', conflict: true } } }],
		['catalog-audio', { type: 'audio' }],
	]);
	const listeners = new Set<() => void>();
	const refreshCatalog = async (model: string, detail: ModelCatalogDetails) => {
		details.set(model, detail);
		for (const listener of listeners) listener();
		await Promise.resolve();
	};
	const settings = {
		communication: { baseUrls: {}, protocols: {}, credentialIds: {}, providerNames: {} },
		modelOverrides: { [AGENT_PLAN_PROVIDER_ID]: {
			[IMAGE_MODELS[0]]: { imageDefaults: { size: '1K', format: 'png' } },
			[MEDIA_MODELS['speech-synthesis'][0]]: { voice: 'custom_voice' },
			'catalog-text': { type: 'image' },
		} } as Record<string, Record<string, ModelOverride>>,
		providerModels: { [AGENT_PLAN_PROVIDER_ID]: ['glm-5.3-flash', IMAGE_MODELS[0], VIDEO_MODELS[0],
			MEDIA_MODELS['speech-synthesis'][0], MEDIA_MODELS['speech-recognition'][0]] },
		disabledProviderIds: [],
		customProviders: {},
		providerId: AGENT_PLAN_PROVIDER_ID,
		model: 'glm-5.3-flash',
	};
	const app = { secretStorage: { getSecret: () => '' } } as unknown as App;
	const plugin = {
		services: { settings, communication: {
			transport: {},
			models: {},
			modelCatalog: {
				read: () => Promise.resolve({ models: ['catalog-text'], source: 'provider', details: new Map(details) } satisfies ModelCatalogResult),
				protocol: () => undefined,
				subscribeProtocols: (listener: () => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
		} },
		saveSettings: () => Promise.resolve(),
	} as unknown as ScribeAiPlugin;
	return { app, plugin, settings, refreshCatalog };
}

function collect(element: Element): Element[] {
	return [element, ...element.children.flatMap(collect)];
}

function labels(root: Element): string[] {
	return collect(root).filter((elt) => elt.tag === 'label').map((elt) => elt.text);
}

function modelTypeButtons(root: Element, label: string): Element[] {
	return within(root, (elt) => elt.attrs.role === 'group' && elt.attrs['aria-label'] === label).children;
}

function byLabel(root: Element, label: string): Element {
	return within(root, (elt) => elt.attrs['aria-label'] === label);
}

function within(root: Element, predicate: (elt: Element) => boolean): Element {
	const found = collect(root).find(predicate);
	assert.ok(found);
	return found;
}
