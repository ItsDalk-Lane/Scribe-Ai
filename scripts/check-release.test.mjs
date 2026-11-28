import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRelease, releaseAssetDigests } from './check-release.mjs';

const manifest = {
	id: 'scribe-ai', name: 'Scribe Ai', author: 'Scribe Ai', version: '1.0.3', minAppVersion: '1.11.4',
	description: 'Read and edit notes with your configured model.', isDesktopOnly: true,
};
const versionFiles = {
	'manifest.json': manifest,
	'package.json': { version: manifest.version },
	'package-lock.json': { version: manifest.version, packages: { '': { version: manifest.version } } },
	'versions.json': { '1.0.2': '1.11.4', [manifest.version]: manifest.minAppVersion },
};

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'scribe-release-test-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (name, value) => writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
	Object.entries(versionFiles).forEach(([name, value]) => write(name, value));
	write('README.md', '# Scribe Ai');
	write('LICENSE', 'Release test license fixture');
	return { root, write };
}

test('blocks the description rejected by the 1.0.2 market review and invalid required metadata', (t) => {
	const { root, write } = fixture(t);
	assert.deepEqual(checkRelease(root), manifest);
	for (const [replacement, error] of [
		[{ description: 'Run AI agent tasks in Obsidian with your configured model.' }, /description must not include the word Obsidian/],
		[{ description: 'Read notes with obsidian.' }, /description must not include the word Obsidian/],
		[{ name: 'Obsi-Scribe' }, /valid display name/],
		[{ author: ' ' }, /must have an author/],
		[{ id: 'scribe-ai-other' }, /published plugin ID/],
		[{ description: 'Invalid because the period is missing' }, /description must be a short sentence/],
		[{ minAppVersion: '1.11' }, /minimum Obsidian version must use/],
		[{ isDesktopOnly: false }, /must remain desktop-only/],
	]) {
		write('manifest.json', { ...manifest, ...replacement });
		assert.throws(() => checkRelease(root), error);
	}
});

test('requires exact equality among release, manifest, package, and both lock versions', (t) => {
	const { root, write } = fixture(t);
	assert.equal(checkRelease(root, '1.0.3').version, '1.0.3');
	assert.throws(() => checkRelease(root, '1.0.4'), /does not match/);
	for (const invalid of ['v1.0.3', '1.0.3-beta.1', '01.0.3']) {
		assert.throws(() => checkRelease(root, invalid), /without a prefix or suffix/);
	}
	for (const [fileName, replacement, error] of [
		['package.json', { version: '1.0.4' }, /package\.json version/],
		['package-lock.json', { ...versionFiles['package-lock.json'], version: '1.0.4' }, /Both package-lock/],
		['package-lock.json', { version: '1.0.3', packages: { '': { version: '1.0.4' } } }, /Both package-lock/],
		['versions.json', {}, /versions\.json must map/],
		['versions.json', { '1.0.3': '1.11.5' }, /versions\.json must map/],
	]) {
		write(fileName, replacement);
		assert.throws(() => checkRelease(root, '1.0.3'), error);
		write(fileName, versionFiles[fileName]);
	}
});

test('hashes only the three release files and rejects missing, empty or mismatched assets', (t) => {
	const { root, write } = fixture(t);
	write('main.js', 'exports.ready = true;');
	assert.throws(() => releaseAssetDigests(root, '1.0.3'), /styles\.css must be a regular file/);
	mkdirSync(join(root, 'styles.css'));
	assert.throws(() => releaseAssetDigests(root, '1.0.3'), /styles\.css must be a regular file/);
	rmSync(join(root, 'styles.css'), { recursive: true });
	write('styles.css', '');
	assert.throws(() => releaseAssetDigests(root, '1.0.3'), /styles\.css must not be empty/);
	write('styles.css', '.scribe {}');
	const before = releaseAssetDigests(root, '1.0.3');
	assert.deepEqual(before.map(({ name }) => name), ['main.js', 'manifest.json', 'styles.css']);
	assert.equal(before[0].size, Buffer.byteLength('exports.ready = true;'));
	assert.match(before[0].digest, /^sha256:[a-f0-9]{64}$/);
	write('main.js', 'exports.ready = null;');
	const after = releaseAssetDigests(root, '1.0.3');
	assert.equal(after[0].size, before[0].size);
	assert.notEqual(after[0].digest, before[0].digest);
	write('manifest.json', { ...manifest, version: '1.0.4' });
	assert.throws(() => releaseAssetDigests(root, '1.0.3'), /does not match/);
});

test('the npm version hook refreshes a stale minimum-version mapping and preserves older mappings', (t) => {
	const { root, write } = fixture(t);
	write('versions.json', { '1.0.2': '1.11.4', '1.0.4': '1.11.3' });
	const script = fileURLToPath(new URL('../version-bump.mjs', import.meta.url));
	const processResult = spawnSync(process.execPath, [script], {
		cwd: root, env: { ...process.env, npm_package_version: '1.0.4' }, encoding: 'utf8',
	});
	assert.equal(processResult.status, 0, processResult.stderr);
	assert.equal(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version, '1.0.4');
	assert.deepEqual(JSON.parse(readFileSync(join(root, 'versions.json'), 'utf8')), { '1.0.2': '1.11.4', '1.0.4': '1.11.4' });
});
