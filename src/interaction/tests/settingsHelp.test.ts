import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

void test('settings descriptions converge when updating a tooltip changes its own DOM', async (t) => {
	const hooks = registerHooks({
		resolve: (id, context, next) => id === 'obsidian'
			? { shortCircuit: true, format: 'commonjs', url: 'test:obsidian-settings-help' } : next(id, context),
		load: (url, context, next) => url === 'test:obsidian-settings-help'
			? { shortCircuit: true, format: 'commonjs', source: 'exports.setIcon = () => {}; exports.setTooltip = (element, text) => element.update(text);' }
			: next(url, context),
	});
	t.after(() => hooks.deregister());
	const { watchSettingDescriptions } = await import('../settingsHelp');
	const description = { textContent: 'Folder A' };
	const delivered: string[] = [];
	let changed = false;
	let scan = () => {};
	const help = { update(text: string) { delivered.push(text); changed = true; }, getAttribute: () => null };
	let created = false;
	const name = { querySelector: () => created ? help : null, createSpan: () => { created = true; return help; } };
	const info = { querySelector: (query: string) => query.endsWith('name') ? name : description };
	const row = { querySelector: () => info };
	const container = { querySelectorAll: () => [row], ownerDocument: { defaultView: { MutationObserver: class {
		constructor(callback: () => void) { scan = callback; }
		observe() {}
		disconnect() {}
	} } } };
	t.after(watchSettingDescriptions(container as unknown as HTMLElement));
	for (const text of ['Folder A', 'Folder B']) {
		description.textContent = text;
		for (let i = 0; i < 5; i++) {
			changed = false;
			scan();
			if (!changed) break;
		}
		assert.equal(changed, false);
	}
	assert.deepEqual(delivered, ['Folder A', 'Folder B']);
});
