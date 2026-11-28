import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { App } from 'obsidian';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SavedVideoJob } from '../../orchestration/storage/mediaVideoRecords';

void test('the conversation renders saved video jobs without a message and hides them once linked', async (t) => {
	const hooks = registerHooks({
		resolve: (id, context, next) => id === 'obsidian'
			? { shortCircuit: true, format: 'commonjs', url: 'test:obsidian-video-jobs' } : next(id, context),
		load: (url, context, next) => url === 'test:obsidian-video-jobs'
			? { shortCircuit: true, format: 'commonjs', source: "exports.getLanguage = () => 'en'; exports.Modal = class {};" }
			: next(url, context),
	});
	t.after(() => hooks.deregister());
	const { GeneratedVideoJobsContext, UnlinkedGeneratedVideoJobs } = await import('../components/GeneratedVideoJobs');
	const jobs: SavedVideoJob[] = [
		{ id: 'a', state: 'ready', media: { kind: 'video', path: 'generated.mp4' } },
		{ id: 'b', state: 'paused', remoteId: 'remote-job', error: 'Download interrupted' },
		{ id: 'c', state: 'unknown', error: 'No remote receipt' },
	];
	const render = (linkedJobIds: ReadonlySet<string>) => renderToStaticMarkup(
		<GeneratedVideoJobsContext.Provider value={{ jobs, recover: async () => assert.fail('Rendering must not contact the provider') }}>
			<UnlinkedGeneratedVideoJobs app={{} as App} linkedJobIds={linkedJobIds} />
		</GeneratedVideoJobsContext.Provider>);

	const orphaned = render(new Set(['c']));
	assert.match(orphaned, /Video generated/u);
	assert.match(orphaned, /scribe-generated-media/u);
	assert.match(orphaned, /Download interrupted/u);
	assert.match(orphaned, /Resume checking/u);
	assert.doesNotMatch(orphaned, /No remote receipt/u);
	assert.equal(render(new Set(['a', 'b', 'c'])), '');
});
