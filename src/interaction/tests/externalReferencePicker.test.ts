import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { externalReferenceAt, pickExternalReference } from '../externalReferencePicker';

void test('external picker passes the composer window and returns only approved absolute paths', async () => {
	const owner = {};
	let canceled = false;
	let selectedPath = __filename;
	const calls: unknown[] = [];
	const document = {
		defaultView: { electronWindow: owner, electron: { remote: { dialog: {
			showOpenDialog(parent: unknown, options: unknown) {
				calls.push([parent, options]);
				return Promise.resolve({ canceled, filePaths: [selectedPath] });
			},
		} } } },
	} as unknown as Document;

	assert.deepEqual(await pickExternalReference(document, 'file', 'Choose file'), { path: selectedPath, kind: 'file' });
	selectedPath = dirname(__filename);
	assert.deepEqual(await pickExternalReference(document, 'folder', 'Choose folder'), { path: selectedPath, kind: 'folder' });
	selectedPath = __filename;
	assert.deepEqual(await pickExternalReference(document, 'path', 'Choose path'), { path: selectedPath, kind: 'file' });
	selectedPath = dirname(__filename);
	assert.deepEqual(await pickExternalReference(document, 'path', 'Choose path'), { path: selectedPath, kind: 'folder' });
	assert.deepEqual(calls, [
		[owner, { title: 'Choose file', properties: ['openFile', 'dontAddToRecent'] }],
		[owner, { title: 'Choose folder', properties: ['openDirectory', 'dontAddToRecent'] }],
		[owner, { title: 'Choose path', properties: ['openFile', 'openDirectory', 'dontAddToRecent'] }],
		[owner, { title: 'Choose path', properties: ['openFile', 'openDirectory', 'dontAddToRecent'] }],
	]);

	canceled = true;
	assert.equal(await pickExternalReference(document, 'path', ''), null);
	canceled = false;
	selectedPath = 'relative';
	await assert.rejects(pickExternalReference(document, 'file', ''));
	await assert.rejects(pickExternalReference(document, 'path', ''));
	await assert.rejects(pickExternalReference({ defaultView: null } as unknown as Document, 'folder', ''));
	await assert.rejects(externalReferenceAt(__filename, 'folder'));
	await assert.rejects(externalReferenceAt(dirname(__filename), 'file'));
	await assert.rejects(externalReferenceAt(resolve(__filename, 'missing'), 'file'));
});
