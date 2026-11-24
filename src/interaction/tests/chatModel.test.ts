import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSettings } from '../../orchestration/settings/defaults';
import { setProviderEnabled } from '../../orchestration/settings/modelAvailability';
import { chatModelOptions } from '../useChatModel';

void test('configured providers include empty model lists, and identical model IDs remain distinct across providers', () => {
	const settings = normalizeSettings({
		providerId: 'local-2',
		model: 'model-a',
		providerModels: {
			'local-1': ['model-a', 'model-a', 'model-b'],
			'local-2': ['model-a'],
			empty: [],
		},
		customProviders: { 'local-2': { label: 'Local', baseUrl: 'http://localhost:11434', protocol: 'openai-completions' } },
	});
	const providers = () => [
		{ id: 'local-1', label: 'Local' },
		{ id: 'unconfigured', label: 'Not configured' },
	];
	const { groups, value } = chatModelOptions(settings, providers);
	assert.deepEqual(groups.map(({ label, models }) => [label, models.map(({ id }) => id)]), [
		['Local · local-1', ['model-a', 'model-b']],
		['Local · local-2', ['model-a']],
		['empty', []],
	]);
	assert.notEqual(groups[0]?.models[0]?.value, groups[1]?.models[0]?.value);
	assert.equal(value, groups[1]?.models[0]?.value);
	const otherTab = { providerId: 'local-1', model: 'model-a' };
	assert.equal(chatModelOptions(settings, providers, otherTab).value, groups[0]?.models[0]?.value);
	assert.equal(chatModelOptions(settings, providers).value, value);

	delete settings.providerModels['local-2'];
	assert.equal(chatModelOptions(settings, providers).value, '');
	settings.providerId = 'local-1';
	assert.equal(chatModelOptions(settings, providers, { providerId: 'local-2', model: 'model-a' }).value, groups[0]?.models[0]?.value);
});

void test('provider switches are independent of the default and keep disabled models configured', () => {
	const settings = normalizeSettings({
		providerId: 'second',
		model: 'preferred',
		providerModels: { first: ['fallback'], second: ['other', 'preferred'] },
	});
	const providers = () => [];
	const groups = () => chatModelOptions(settings, providers).groups.map(({ id }) => id);
	assert.deepEqual(groups(), ['first', 'second']);

	setProviderEnabled(settings, 'first', false);
	assert.deepEqual(groups(), ['second']);
	assert.equal(settings.model, 'preferred');
	setProviderEnabled(settings, 'first', true);
	assert.deepEqual(groups(), ['first', 'second']);
	assert.equal(settings.model, 'preferred');

	setProviderEnabled(settings, 'second', false);
	assert.deepEqual(groups(), ['first']);
	assert.equal(settings.model, 'fallback');
	assert.deepEqual(settings.providerModels.second, ['other', 'preferred']);
	const preferred = { providerId: 'second', model: 'preferred' };
	assert.equal(chatModelOptions(settings, providers, preferred).selection.model, 'fallback');
	setProviderEnabled(settings, 'first', false);
	assert.deepEqual(groups(), []);
	assert.equal(settings.model, '');

	setProviderEnabled(settings, 'second', true);
	assert.deepEqual(groups(), ['second']);
	assert.equal(settings.model, 'other');
	assert.equal(chatModelOptions(settings, providers, preferred).selection.model, 'preferred');
});
