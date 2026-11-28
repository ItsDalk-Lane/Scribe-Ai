import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type ScribeAiPlugin from '../../main';
import { AGENT_PLAN_PROVIDER_ID, normalizeMediaSettings, type MediaSettings } from '../../orchestration/settings/mediaSettings';

class Element {
	readonly children: Element[] = [];
	readonly options: string[] = [];
	name = '';
	value = '';
	text = '';
	disabled = false;
	change?: (value: string) => Promise<void>;
	createDiv() {
		const child = new Element();
		this.children.push(child);
		return child;
	}
	setText(text: string) { this.text = text; }
	empty() { this.text = ''; }
}

void test('media service settings select six operations and restore the saved model on reopen or failed saves', async (t) => {
	const hooks = registerHooks({
		resolve: (id, context, next) => id === 'obsidian'
			? { shortCircuit: true, format: 'commonjs', url: 'test:obsidian-media-settings' } : next(id, context),
		load: (url, context, next) => url === 'test:obsidian-media-settings' ? {
			shortCircuit: true, format: 'commonjs', source: `
				exports.getLanguage = () => 'en';
				exports.Setting = class {
					constructor(container) { this.row = container.createDiv(); }
					setName(name) { this.row.name = name; return this; }
					addDropdown(setup) {
						const row = this.row;
						const dropdown = {
							selectEl: { setAttribute() {} },
							addOption(value) { row.options.push(value); return this; },
							setValue(value) { row.value = value; return this; },
							setDisabled(value) { row.disabled = value; return this; },
							onChange(change) { row.change = change; return this; },
						};
						setup(dropdown);
						return this;
					}
				};`,
		} : next(url, context),
	});
	t.after(() => hooks.deregister());
	const { renderMediaSettings } = await import('../mediaSettingsUi');
	const settings = { media: { imageDirectory: 'Assets/Images' } as MediaSettings, modelOverrides: {},
		disabledProviderIds: [],
		providerModels: { [AGENT_PLAN_PROVIDER_ID]: ['doubao-seedream-5.5', 'doubao-seedream-5.0-flash', 'doubao-seedance-2.5', 'doubao-seed-tts-2.0'],
			another: ['doubao-seed-asr-2.0'] } };
	let reject = false;
	const plugin = {
		services: { settings },
		async saveMediaSettings(update: (current: MediaSettings) => MediaSettings) {
			if (reject) throw new Error('Save failed');
			settings.media = normalizeMediaSettings(update(settings.media), true);
		},
	} as unknown as ScribeAiPlugin;
	const open = () => {
		const panel = new Element();
		renderMediaSettings(panel as unknown as HTMLElement, plugin);
		return panel.children[0]!.children;
	};
	const rows = open();
	const [, , image, video, synthesize, recognize] = rows;
	assert.deepEqual(rows.map((row) => row.name).filter(Boolean),
		['Image generation model', 'Video generation model', 'Speech synthesis model', 'Speech recognition model',
			'Image editing model', 'Video editing model']);
	assert.equal(image?.value, 'doubao-seedream-5.5');
	assert.deepEqual(image?.options, ['doubao-seedream-5.5', 'doubao-seedream-5.0-flash']);
	assert.equal(video?.value, 'doubao-seedance-2.5');
	assert.deepEqual(synthesize?.options, ['doubao-seed-tts-2.0']);
	assert.deepEqual(recognize?.options, ['']);
	assert.equal(recognize?.disabled, true);

	assert.ok(image?.change);
	await image.change('doubao-seedream-5.0-pro');
	assert.equal(settings.media.selections?.image, undefined);
	await image.change('doubao-seedream-5.0-flash');
	assert.deepEqual(settings.media.selections?.image, { providerId: AGENT_PLAN_PROVIDER_ID, model: 'doubao-seedream-5.0-flash' });
	assert.equal(settings.media.imageDirectory, 'Assets/Images');
	settings.media = normalizeMediaSettings(JSON.parse(JSON.stringify(settings.media)));
	const [, status, restoredImage] = open();
	assert.ok(restoredImage?.change);
	assert.equal(restoredImage.value, 'doubao-seedream-5.0-flash');
	reject = true;
	await restoredImage.change('doubao-seedream-5.5');
	assert.equal(restoredImage.value, 'doubao-seedream-5.0-flash');
	assert.equal(restoredImage.disabled, false);
	assert.equal(status?.text, 'Save failed');
});
