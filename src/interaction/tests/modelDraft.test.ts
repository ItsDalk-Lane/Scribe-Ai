import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelCatalogDetails, ModelOverride, ProviderModelInfo } from '../../types';
import { modelConfigurationOverride, prefillModelConfiguration } from '../modelDraft';

const bundled: ProviderModelInfo = {
	id: 'model', contextWindow: 128000, maxTokens: 32768, input: ['text', 'image'],
	reasoning: true, thinkingLevels: ['low', 'medium'], baseUrl: 'https://example.test', api: 'openai-completions',
};

const catalog: ModelCatalogDetails = {
	contextWindow: 1048576, inputModalities: ['text', 'audio', 'video'],
	reasoning: false, tools: false, reportedThinkingLevels: ['medium', 'deep'],
};

void test('model configuration prefills each field, including catalog values that are false', () => {
	const initial = prefillModelConfiguration(undefined, catalog, bundled);
	assert.equal(initial.contextWindow, 1048576);
	assert.equal(initial.maxTokens, 32768);
	assert.deepEqual(initial.input, ['text', 'audio', 'video']);
	assert.equal(initial.reasoning, false);
	assert.equal(initial.tools, false);
	assert.deepEqual(initial.thinkingLevels, ['medium', 'deep']);
	assert.deepEqual(modelConfigurationOverride(initial, initial), {});
});

void test('manual settings take precedence after reopening and legacy output settings survive a save', () => {
	const saved: ModelOverride = {
		contextWindow: 64000, maxTokens: 8000, input: ['text'], output: ['text', 'image'],
		capabilities: { reasoning: true, tools: true, structuredOutput: true }, thinkingLevels: ['medium'],
	};
	const reopened = prefillModelConfiguration(saved, catalog, bundled);
	assert.deepEqual(modelConfigurationOverride(reopened, reopened, saved), saved);

	const initial = prefillModelConfiguration(undefined, catalog, bundled);
	const edited = modelConfigurationOverride({ ...initial, reasoning: true, input: ['text', 'image'] }, initial);
	const restored = prefillModelConfiguration(edited, catalog, bundled);
	assert.equal(restored.reasoning, true);
	assert.deepEqual(restored.input, ['text', 'image']);
});

void test('missing metadata gives usable defaults and explicit empty lists are preserved', () => {
	const defaults = prefillModelConfiguration(undefined);
	assert.equal(defaults.contextWindow, 128000);
	assert.equal(defaults.maxTokens, 8000);
	assert.deepEqual(defaults.input, ['text']);
	assert.equal(defaults.reasoning, false);
	assert.equal(defaults.tools, true);
	assert.deepEqual(modelConfigurationOverride(defaults, defaults), {});
	const saved = { input: [], thinkingLevels: [] };
	const initial = prefillModelConfiguration(saved, catalog, bundled);
	assert.deepEqual(initial.input, []);
	assert.deepEqual(initial.thinkingLevels, []);
});

void test('a saved false for structured output takes precedence over catalog support', () => {
	const shared = { structuredOutput: true };
	const initial = prefillModelConfiguration(undefined, shared, bundled);
	assert.equal(initial.structuredOutput, true);
	const saved = modelConfigurationOverride({ ...initial, structuredOutput: false }, initial);
	assert.deepEqual(saved.capabilities, { structuredOutput: false });
	assert.equal(prefillModelConfiguration(saved, shared, bundled).structuredOutput, false);
});

void test('prefill uses explicit video evidence without replacing other inputs or saving inherited values', () => {
	const shared = { inputModalities: ['text', 'image'] as ('text' | 'image')[], videoInput: true, structuredOutput: true };
	const saved = { capabilities: { structuredOutput: false } };
	const draft = prefillModelConfiguration(saved, shared, bundled);
	assert.deepEqual(draft.input, ['text', 'image', 'video']);
	assert.equal(draft.structuredOutput, false);
	assert.deepEqual(modelConfigurationOverride(draft, draft, saved), saved);
	assert.deepEqual(prefillModelConfiguration(undefined, { ...shared, videoInput: false }, bundled).input, ['text', 'image']);
});
