import assert from 'node:assert/strict';
import test from 'node:test';
import { chatStatusBarSpace } from '../components/chatStatusBarSpace';

void test('conversation spacing follows its own window status bar and stops observing on close', () => {
	let hidden = false;
	let changed: (() => void) | undefined;
	const attributes: boolean[] = [];
	const bar = {
		hasAttribute: (name: string) => name === 'hidden' && hidden,
		ownerDocument: {
			defaultView: {
				MutationObserver: class {
					constructor(update: () => void) { changed = update; }
					observe(target: unknown, options: MutationObserverInit) {
						assert.equal(target, bar);
						assert.deepEqual(options, { attributes: true, attributeFilter: ['hidden'] });
					}
					disconnect() { changed = undefined; }
				},
			},
		},
	};
	const element = {
		ownerDocument: { querySelector: (selector: string) => selector === '.status-bar' ? bar : null },
		toggleAttribute: (name: string, visible: boolean) => {
			assert.equal(name, 'data-status-bar-visible');
			attributes.push(visible);
		},
	} as unknown as HTMLDivElement;
	const stop = chatStatusBarSpace(element);
	assert.ok(stop && changed);
	hidden = true;
	changed();
	hidden = false;
	changed();
	stop();
	assert.equal(changed, undefined);
	assert.deepEqual(attributes, [true, false, true]);
});
