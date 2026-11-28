import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = parse(readFileSync(join(root, '.github/workflows/publish-release.yml'), 'utf8'));
const steps = workflow.jobs.publish.steps;
const commit = '1'.repeat(40);
const useBash = { skip: process.platform === 'win32' };

function run(step, github, env) {
	const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', github + '\n' + step.run], {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, GH_REPO: 'owner/scribe-ai', REVIEWED_COMMIT: commit, ...env },
	});
	assert.ifError(result.error);
	return result;
}

test('the publish workflow requires a completed review and finds a successful build for exactly the reviewed tag and commit', useBash, () => {
	const step = steps.find(({ id }) => id === 'candidate');
	assert.ok(step);
	const github = `gh() { printf 'lookup: %s\n' "$*" >&2; printf '%s\n' "$MOCK_RUN_ID"; }`;
	const base = { GITHUB_REF: 'refs/heads/main', DEFAULT_BRANCH: 'main', RELEASE_VERSION: '1.0.3',
		REVIEW_PASSED: 'true', MOCK_RUN_ID: '99999', GITHUB_OUTPUT: '/dev/stdout' };
	for (const input of [{ REVIEW_PASSED: 'false' }, { GITHUB_REF: 'refs/heads/draft' },
		{ REVIEWED_COMMIT: '1234567' }, { RELEASE_VERSION: 'v1.0.3' }]) {
		const rejected = run(step, github, { ...base, ...input });
		assert.equal(rejected.status, 1);
		assert.doesNotMatch(rejected.stderr, /lookup:/u);
	}
	assert.equal(run(step, github, { ...base, MOCK_RUN_ID: '' }).status, 1);
	const accepted = run(step, github, base);
	assert.equal(accepted.status, 0, accepted.stderr);
	assert.equal(accepted.stdout, 'run_id=99999\n');
	assert.match(accepted.stderr, new RegExp(`--event push --status success --branch 1\\.0\\.3 --commit ${commit}`, 'u'));
});

test('the publish workflow verifies all three files against the tag, SHA and build workflow before publishing', useBash, (t) => {
	const step = steps.find(({ name }) => name === 'Verify the signed installer files');
	assert.ok(step);
	assert.equal(steps[steps.indexOf(step) + 1]?.name, 'Publish the verified GitHub release');
	const directory = mkdtempSync(join(tmpdir(), 'scribe-release-workflow-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const fixtures = join(directory, 'fixtures');
	mkdirSync(fixtures);
	copyFileSync(join(root, 'manifest.json'), join(fixtures, 'manifest.json'));
	writeFileSync(join(fixtures, 'main.js'), 'module.exports = {};\n');
	writeFileSync(join(fixtures, 'styles.css'), '.scribe {}\n');
	const version = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8')).version;
	const github = `gh() {
		if [[ "$1 $2" == 'run download' ]]; then
			[[ "$3" == 77 && "$4" == --name && "$5" == "scribe-ai-$RELEASE_VERSION-verified" && "$6" == --dir ]] || return 2
			mkdir -p -- "$7"
			cp -- "$FIXTURES/"* "$7/"
		else
			[[ "$1 $2" == 'attestation verify' && "$4 $5" == "--repo $GH_REPO" &&
			   "$6 $7" == "--source-ref refs/tags/$RELEASE_VERSION" && "$8 $9" == "--source-digest $REVIEWED_COMMIT" &&
			   "\${10} \${11}" == "--signer-workflow $GH_REPO/.github/workflows/release-artifacts.yml" ]] || return 2
			printf '%s\n' "\${3##*/}"
			[[ "\${3##*/}" != "$UNSIGNED" ]] || return 1
		fi
	}`;
	const base = { RUN_ID: '77', RUNNER_TEMP: directory, RELEASE_VERSION: version, FIXTURES: fixtures };
	const signed = run(step, github, { ...base, UNSIGNED: '' });
	assert.equal(signed.status, 0, signed.stderr);
	assert.equal(signed.stdout, 'main.js\nmanifest.json\nstyles.css\n');
	const unsigned = run(step, github, { ...base, UNSIGNED: 'manifest.json' });
	assert.equal(unsigned.status, 1);
	assert.equal(unsigned.stdout, 'main.js\nmanifest.json\n');
});
