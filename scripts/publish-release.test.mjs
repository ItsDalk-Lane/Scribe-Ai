import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishRelease } from './publish-release.mjs';

const version = '1.0.4';
const commit = 'a'.repeat(40);
const annotatedTag = 'b'.repeat(40);
const repository = 'owner/scribe-ai';
const releases = `repos/${repository}/releases`;
const id = 42;
const contents = {
	'main.js': 'const app = {};\n',
	'manifest.json': JSON.stringify({ id: 'scribe-ai', name: 'Scribe Ai', version,
		minAppVersion: '1.11.4', description: 'Read, search, and edit notes.', author: 'Scribe', isDesktopOnly: true }),
	'styles.css': '.scribe {}\n',
};

function fakeRelease(t, { existing, annotated = false, corruptUpload = false, moveTagWhileCheckingAssets = false, corruptAfterPublish = false } = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'scribe-publish-test-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const asset = (name, value = contents[name]) => ({
		name, state: 'uploaded', size: Buffer.byteLength(value),
		digest: 'sha256:' + createHash('sha256').update(value).digest('hex'),
	});
	for (const [name, value] of Object.entries(contents)) writeFileSync(join(directory, name), value);
	const changes = [];
	const state = {
		commit,
		visibility: 'public',
		release: existing && { id, tag_name: version, prerelease: false, draft: existing !== 'public' },
		assets: [],
	};
	const output = (value) => JSON.stringify(value);
	const run = (args) => {
		const [command, endpoint, ...flags] = args;
		if (command === 'release') {
			assert.deepEqual(args.slice(1, 7), ['create', version, '--repo', repository, '--verify-tag', '--draft']);
			assert.equal(state.release, undefined);
			changes.push('draft');
			state.release = { id, tag_name: version, prerelease: false, draft: true };
			return 'created';
		}
		assert.equal(command, 'api');
		if (endpoint === `repos/${repository}`) {
			return output({ full_name: repository, visibility: state.visibility, private: state.visibility === 'private' });
		}
		if (endpoint === `repos/${repository}/git/ref/tags/${version}`) {
			return output({ object: annotated ? { type: 'tag', sha: annotatedTag } : { type: 'commit', sha: state.commit } });
		}
		if (endpoint === `repos/${repository}/git/tags/${annotatedTag}`) {
			return output({ object: { type: 'commit', sha: state.commit } });
		}
		if (endpoint === `${releases}?per_page=100`) return output([state.release ? [state.release] : []]);
		if (endpoint === `${releases}/${id}/assets?per_page=100`) {
			if (moveTagWhileCheckingAssets && state.release.draft && state.assets.length === 3) state.commit = 'd'.repeat(40);
			return output([state.assets]);
		}
		if (endpoint.startsWith(`https://uploads.github.com/${releases}/${id}/assets?name=`)) {
			assert.equal(state.release.draft, true);
			assert.equal(flags[1], 'POST');
			const name = new URL(endpoint).searchParams.get('name');
			assert.ok(Object.hasOwn(contents, name));
			assert.equal(state.assets.some((current) => current.name === name), false);
			changes.push(name);
			const uploaded = asset(name, readFileSync(flags.at(-1)));
			if (corruptUpload && name === 'main.js') uploaded.digest = null;
			state.assets.push(uploaded);
			return output(uploaded);
		}
		assert.equal(endpoint, `${releases}/${id}`);
		if (flags.length) {
			assert.deepEqual(flags, ['--method', 'PATCH', '-F', 'draft=false', '-f', 'make_latest=true']);
			assert.equal(state.release.draft, true);
			assert.deepEqual(state.assets.slice().sort((a, b) => a.name.localeCompare(b.name)),
				Object.keys(contents).map((name) => asset(name)).sort((a, b) => a.name.localeCompare(b.name)));
			state.release.draft = false;
			changes.push('published');
			if (corruptAfterPublish) state.assets.pop();
		}
		return output(state.release);
	};
	return { state, changes, asset, publish: () => publishRelease(version, commit, directory, repository, run) };
}

test('creates a draft for an annotated tag and publishes only the exact build files', (t) => {
	const github = fakeRelease(t, { annotated: true });
	assert.equal(github.publish(), `https://github.com/${repository}/releases/tag/${version}`);
	assert.deepEqual(github.changes, ['draft', 'main.js', 'manifest.json', 'styles.css', 'published']);
});

test('rejects a tag pointing to a different commit without changing a release', (t) => {
	const github = fakeRelease(t);
	github.state.commit = 'c'.repeat(40);
	assert.throws(github.publish, /reviewed commit/u);
	assert.deepEqual(github.changes, []);
});

test('refuses to create a release for a private or internal GitHub repository', (t) => {
	for (const visibility of ['private', 'internal']) {
		const github = fakeRelease(t);
		github.state.visibility = visibility;
		assert.throws(github.publish, /repository to be public/u);
		assert.deepEqual(github.changes, []);
	}
});

test('resumes an interrupted draft without replacing its matching asset', (t) => {
	const github = fakeRelease(t, { existing: 'draft' });
	github.state.assets.push(github.asset('manifest.json'));
	github.publish();
	assert.deepEqual(github.changes, ['main.js', 'styles.css', 'published']);
});

test('refuses to touch incompatible or duplicate draft assets', (t) => {
	for (const name of ['same-size mismatch', 'missing digest', 'extra asset', 'duplicate asset']) {
		const github = fakeRelease(t, { existing: 'draft' });
		const main = github.asset('main.js');
		if (name === 'same-size mismatch') main.digest = 'sha256:' + 'f'.repeat(64);
		if (name === 'missing digest') delete main.digest;
		github.state.assets.push(main);
		if (name === 'extra asset') github.state.assets.push({ ...main, name: 'unrelated.zip' });
		if (name === 'duplicate asset') github.state.assets.push(main);
		assert.throws(github.publish, /mismatched release asset/u, name);
		assert.deepEqual(github.changes, [], name);
		assert.equal(github.state.release.draft, true, name);
	}
});

test('keeps a draft private when GitHub cannot confirm an uploaded asset hash', (t) => {
	const github = fakeRelease(t, { corruptUpload: true });
	assert.throws(github.publish, /mismatched release asset/u);
	assert.equal(github.state.release.draft, true);
	assert.deepEqual(github.changes, ['draft', 'main.js', 'manifest.json', 'styles.css']);
});

test('rechecks the tag after the final asset comparison and stops if it was moved', (t) => {
	const github = fakeRelease(t, { moveTagWhileCheckingAssets: true });
	assert.throws(github.publish, /reviewed commit/u);
	assert.equal(github.state.release.draft, true);
	assert.deepEqual(github.changes, ['draft', 'main.js', 'manifest.json', 'styles.css']);
});

test('a published release is checked in place and never changed on retry', (t) => {
	const github = fakeRelease(t, { existing: 'public' });
	assert.throws(github.publish, /incomplete/u);
	github.state.assets.push(...Object.keys(contents).map((name) => github.asset(name)));
	assert.equal(github.publish(), `https://github.com/${repository}/releases/tag/${version}`);
	assert.deepEqual(github.changes, []);
});

test('reports a changed public asset after publication without overriding anything', (t) => {
	const github = fakeRelease(t, { corruptAfterPublish: true });
	assert.throws(github.publish, /Published release 1\.0\.4 could not be verified/u);
	assert.deepEqual(github.changes, ['draft', 'main.js', 'manifest.json', 'styles.css', 'published']);
});
