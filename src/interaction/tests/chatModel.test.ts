import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSettings } from '../../orchestration/settings/defaults';
import { isModelAvailable, reconcileDefaultModel, setProviderEnabled } from '../../orchestration/settings/modelAvailability';
import { guardModelConnection } from '../../orchestration/settings/modelConnection';
import { chatModelKey, chatReasoningForRequest, updateChatThinking } from '../../orchestration/settings/thinking';
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

void test('chat choices skip specialized models and recover the text default when its type changes', () => {
	const settings = normalizeSettings({
		providerId: 'mixed',
		model: 'current',
		providerModels: {
			mixed: ['draw', 'current', 'other'],
			specialized: ['embed'],
			'volcengine-agent-plan': ['doubao-seedance-2.5'],
		},
		modelOverrides: {
			mixed: { draw: { type: 'image' } },
			specialized: { embed: { type: 'embedding' } },
		},
	});
	const preferred = { providerId: 'mixed', model: 'draw' };
	const choices = () => chatModelOptions(settings, () => [], preferred);
	assert.deepEqual(choices().groups.map(({ id, models }) => [id, models.map((model) => model.id)]),
		[['mixed', ['current', 'other']]]);
	assert.equal(choices().selection.model, 'current');
	assert.equal(isModelAvailable(settings, preferred), false);
	assert.throws(guardModelConnection(settings, preferred), /无法处理文字对话/u);

	const send = guardModelConnection(settings, { providerId: 'mixed', model: 'current' });
	assert.doesNotThrow(send);
	const mixed = settings.modelOverrides.mixed;
	assert.ok(mixed);
	mixed.current = { type: 'rerank' };
	assert.throws(send, /无法处理文字对话/u);
	reconcileDefaultModel(settings);
	assert.equal(settings.model, 'other');
	assert.deepEqual(settings.providerModels.mixed, ['draw', 'current', 'other']);
});

void test('confirmed connection types guide chat choices and defaults without changing saved model overrides', () => {
	const settings = normalizeSettings({
		providerId: 'mixed', model: 'initial',
		providerModels: { mixed: ['initial', 'new-chat'] },
		modelOverrides: { mixed: { initial: { type: 'text' }, 'new-chat': { type: 'image' } } },
	});
	const choice = { providerId: 'mixed', model: 'initial' };
	const modelType = (_providerId: string, model: string) => model === 'initial' ? 'embedding' as const : 'text' as const;
	reconcileDefaultModel(settings, modelType);
	const options = chatModelOptions(settings, () => [], choice, undefined, modelType);
	assert.equal(options.selection.model, 'new-chat');
	assert.deepEqual(options.groups[0]?.models.map(({ id }) => id), ['new-chat']);
	assert.throws(guardModelConnection(settings, choice, undefined, modelType), /无法处理文字对话/u);
	assert.deepEqual(settings.modelOverrides.mixed, { initial: { type: 'text' }, 'new-chat': { type: 'image' } });
});

void test('cold model capabilities preserve explicit thinking choices and leave an unknown default to request-time resolution', () => {
	const model = { providerId: 'remote', model: 'new-model' };
	const key = chatModelKey(model.providerId, model.model);
	const settings = normalizeSettings({ ...model, thinkingByModel: { [key]: 'high' } });
	const cold = { levels: [] };
	assert.equal(chatReasoningForRequest(cold), undefined);
	assert.equal(chatReasoningForRequest(cold, 'off'), null);
	assert.equal(chatReasoningForRequest(cold, 'high'), 'high');
	assert.equal(chatReasoningForRequest({ levels: ['off', 'high'] }), null);
	assert.equal(chatReasoningForRequest({ levels: ['low', 'high'], level: 'low' }, 'high'), 'low');
	assert.equal(updateChatThinking(settings, model, () => cold)[key], 'high');
	assert.equal(updateChatThinking(settings, { ...model, thinkingLevel: 'off' }, () => cold)[key], 'off');
});
