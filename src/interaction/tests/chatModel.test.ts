import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSettings } from '../../orchestration/settings/defaults';
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
});
