import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelCatalogResult, ModelProviderInfo, ProviderModelInfo } from '../../types';
import { modelCapabilityIcons, modelCatalogAddress, modelDetailsForConnection, renderModelCapabilityIcons } from '../modelCapabilityIcons';

void test('model picker exposes confirmed input formats and request capabilities', () => {
	assert.deepEqual(modelCapabilityIcons({
		inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
		reasoning: true, tools: true, structuredOutput: true,
		contextWindow: 128_000, maxTokens: 8_000, thinkingLevels: ['high'],
	}), ['eye', 'ear', 'video', 'file-text', 'lightbulb', 'wrench', 'braces']);
	assert.deepEqual(modelCapabilityIcons({
		outputModalities: ['image', 'audio', 'video'], tools: true,
		contextWindow: 128_000, maxTokens: 8_000, thinkingLevels: ['high'],
	}), ['wrench']);
	assert.deepEqual(modelCapabilityIcons({ tools: true }), ['wrench']);
});

void test('bundled vision and reasoning fill gaps but do not replace explicit catalog values', () => {
	const bundled: Pick<ProviderModelInfo, 'input' | 'reasoning'> = { input: ['text', 'image'], reasoning: true };
	assert.deepEqual(modelCapabilityIcons(undefined, bundled), ['eye', 'lightbulb']);
	assert.deepEqual(modelCapabilityIcons({ inputModalities: [], reasoning: false }, bundled), []);
	assert.deepEqual(modelCapabilityIcons(), []);
});

void test('configured rows render confirmed icons from the saved catalog for their own connection', () => {
	const provider: ModelProviderInfo = {
		id: 'fixture', label: 'Fixture', baseUrl: 'https://fixture.test/v1',
		protocol: 'openai-completions', models: [], protocols: [],
	};
	const connection = { baseUrl: 'https://FIXTURE.test/v1/', protocol: provider.protocol };
	const model = 'not-in-bundled-catalog';
	const catalog: ModelCatalogResult = {
		models: [model], source: 'provider',
		details: new Map([[model, { inputModalities: ['text', 'image'], reasoning: false, tools: true, structuredOutput: true }]]),
	};
	const catalogAddress = modelCatalogAddress(provider, connection.baseUrl, false);
	assert.equal(catalogAddress, undefined);
	assert.equal(modelCatalogAddress(provider, ' https://proxy.test/v1/ ', false), 'https://proxy.test/v1/');
	assert.equal(modelCatalogAddress(provider, connection.baseUrl, true), connection.baseUrl);

	const icons: string[] = [];
	const badges: Record<string, string>[] = [];
	const row = {
		createDiv({ cls }: { cls: string }) {
			assert.equal(cls, 'scribe-model-panel-capabilities');
			return {
				createSpan({ attr }: { attr: Record<string, string> }) {
					badges.push(attr);
					return {};
				},
			};
		},
	} as unknown as HTMLElement;
	const labels = { eye: '视觉', ear: '音频', video: '视频', 'file-text': 'PDF', lightbulb: '推理', wrench: '工具', braces: '结构化' };
	renderModelCapabilityIcons(row, modelDetailsForConnection(provider, model, {
		...connection, catalogAddress, catalog,
	}), labels, (_, icon) => icons.push(icon));
	assert.deepEqual(icons, ['eye', 'wrench', 'braces']);
	assert.deepEqual(badges, [
		{ 'data-capability': 'eye', role: 'img', 'aria-label': '视觉', title: '视觉' },
		{ 'data-capability': 'wrench', role: 'img', 'aria-label': '工具', title: '工具' },
		{ 'data-capability': 'braces', role: 'img', 'aria-label': '结构化', title: '结构化' },
	]);

	for (const override of [{ baseUrl: 'https://different.test/v1' }, { protocol: 'anthropic-messages' }]) {
		const scoped = modelDetailsForConnection(provider, model, {
			...connection, catalogAddress, catalog, overrides: { [model]: override },
		});
		assert.deepEqual(modelCapabilityIcons(scoped.details, scoped.bundled), []);
	}
});
