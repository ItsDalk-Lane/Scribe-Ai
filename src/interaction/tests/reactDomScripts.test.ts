import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { flushSync, preinit, preinitModule } from 'react-dom';
import { createRoot } from 'react-dom/client';

const disabled = /Script loading is disabled in the Scribe renderer/u;

void test('React rejects classic and module script initialization', () => {
	assert.throws(() => preinit('https://example.invalid/library.js', { as: 'script' }), disabled);
	assert.throws(() => preinitModule('https://example.invalid/library.mjs'), disabled);
});

void test('React rejects script elements before DOM creation', () => {
	const htmlNamespace = 'http://www.w3.org/1999/xhtml';
	const document = {
		nodeType: 9,
		addEventListener() {},
		documentElement: { namespaceURI: htmlNamespace },
		get defaultView() { return { document: this, HTMLIFrameElement: class {} }; },
		createElement: () => assert.fail('Unexpected element creation'),
		createElementNS: () => assert.fail('Unexpected namespaced element creation'),
	};
	const variants = [
		{ name: 'script', namespaceURI: htmlNamespace },
		{ name: 'ScRiPt', namespaceURI: htmlNamespace },
		{ name: 'script', namespaceURI: 'http://www.w3.org/2000/svg' },
		{ name: 'script', namespaceURI: htmlNamespace, props: { async: true, src: 'https://example.invalid/library.js' } },
	];
	for (const { name, namespaceURI, props } of variants) {
		const mount = { namespaceURI, nodeType: 1, nodeName: 'DIV', ownerDocument: document, addEventListener() {}, textContent: '' };
		const errors: unknown[] = [];
		const root = createRoot(mount as unknown as Element, { onUncaughtError: (error) => errors.push(error) });
		flushSync(() => root.render(createElement(name, props)));
		assert.equal(errors.length, 1);
		assert.match(String(errors[0]), disabled);
		root.unmount();
	}
});
