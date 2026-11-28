import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type TaskInput from '../components/TaskInput';

void test('the composer warns immediately about attached PDFs and enables sending after configuration', async (t) => {
	const hooks = registerHooks({
		resolve: (id, context, next) => id === 'obsidian'
			? { shortCircuit: true, format: 'commonjs', url: 'test:obsidian-pdf-composer' } : next(id, context),
		load: (url, context, next) => url === 'test:obsidian-pdf-composer' ? {
			shortCircuit: true, format: 'commonjs', source: "exports.getLanguage = () => 'en'; exports.Platform = { isDesktopApp: true }; exports.Modal = class {};",
		} : next(url, context),
	});
	t.after(() => hooks.deregister());
	const { default: Composer } = await import('../components/TaskInput');
	type Props = ComponentProps<typeof TaskInput>;
	const ignore = () => {};
	const props: Props = {
		inputRef: { current: null }, busy: false, disabled: false, conversationId: 'fixture',
		context: {
			app: { vault: { adapter: {} } } as Props['context']['app'],
			conversationStore: {} as Props['context']['conversationStore'],
			refs: [{ kind: 'file', path: 'fixture.PDF' }], onAdd: ignore, onAddQuote: ignore, onRemove: ignore, onRemoveQuotes: ignore,
		},
		modelGroups: [{ id: 'chat', label: 'Chat provider', models: [{ id: 'chat-model', value: 'chat-model' }] }],
		modelValue: 'chat-model', thinking: { levels: [] }, error: '', instruction: '', skillMentions: [],
		skills: {} as Props['skills'], pdfAnalysisSupported: true,
		onChange: ignore, onModelChange: async () => false, onThinkingChange: ignore, onSubmit: ignore, onStop: ignore,
	};
	const render = (override: Partial<Props> = {}) => renderToStaticMarkup(<Composer {...props} {...override} />);
	const disabled = /class="scribe-compose-action scribe-compose-primary" disabled/u;
	const unconfigured = render();
	assert.match(unconfigured, /role="alert">Select an available PDF analysis model/u);
	assert.match(unconfigured, disabled);

	const configured = render({ pdfAnalysisModelLabel: 'PDF provider / pdf-model' });
	assert.match(configured, /The PDF and your question will be sent to PDF provider \/ pdf-model\./u);
	assert.doesNotMatch(configured, /role="alert"/u);
	assert.doesNotMatch(configured, disabled);

	const unsupported = render({ pdfAnalysisSupported: false, pdfAnalysisModelLabel: 'PDF provider / pdf-model' });
	assert.match(unsupported, /role="alert">Send PDFs in a regular chat\./u);
	assert.match(unsupported, disabled);

	const removed = render({ instruction: '普通对话', context: { ...props.context, refs: [] } });
	assert.doesNotMatch(removed, /role="alert"/u);
	assert.doesNotMatch(removed, disabled);
});
