import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isReleaseVersion, releaseAssetDigests } from './check-release.mjs';

function runGitHub(args) {
	const result = spawnSync('gh', args, {
		encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const status = result.stderr?.match(/\bHTTP (\d{3})\b/u)?.[1] ?? result.error?.code ?? result.status;
		throw new Error(`GitHub ${args[0]} request failed (${status}). Check the tag, release access and network.`);
	}
	return result.stdout;
}

export function publishRelease(version, commit, directory, repository, run = runGitHub) {
	if (!isReleaseVersion(version) || !/^[a-f0-9]{40}$/u.test(commit ?? '') || !directory) {
		throw new Error('Expected a release version, a full commit SHA and an artifacts directory.');
	}
	if (!/^[a-z\d][a-z\d-]*\/[a-z\d_][a-z\d_.-]*$/iu.test(repository ?? '')) {
		throw new Error('Set GH_REPO or GITHUB_REPOSITORY to a GitHub owner/repository.');
	}
	const expected = releaseAssetDigests(directory, version);
	const repo = `repos/${repository}`;
	const tag = `${repo}/git/ref/tags/${version}`;
	const releases = `${repo}/releases`;
	const url = `https://github.com/${repository}/releases/tag/${version}`;
	const api = (endpoint, ...flags) => JSON.parse(run(['api', endpoint, ...flags]));
	const list = (endpoint) => api(`${endpoint}?per_page=100`, '--paginate', '--slurp').flat();

	function verifyPublicRepository() {
		const source = api(repo);
		if (source.full_name?.toLowerCase() !== repository.toLowerCase() || source.visibility !== 'public' || source.private !== false) {
			throw new Error('The release workflow requires the selected GitHub repository to be public.');
		}
	}

	function verifyTag() {
		let { object } = api(tag);
		while (object?.type === 'tag' && /^[a-f0-9]{40}$/u.test(object.sha)) {
			({ object } = api(`${repo}/git/tags/${object.sha}`));
		}
		if (object?.type !== 'commit' || object.sha !== commit) {
			throw new Error(`Remote tag ${version} must point to the reviewed commit ${commit}.`);
		}
	}

	function findRelease() {
		const matches = list(releases).filter(({ tag_name }) => tag_name === version);
		if (matches.length > 1) throw new Error(`GitHub returned more than one release for ${version}.`);
		return matches[0];
	}

	function checkRelease(release) {
		if (release?.tag_name !== version || release.prerelease !== false || typeof release.draft !== 'boolean'
			|| !Number.isSafeInteger(release.id) || release.id <= 0) {
			throw new Error(`GitHub release ${version} is missing or has incompatible metadata.`);
		}
	}

	function verifyAssets(id) {
		const missing = new Map(expected.map((asset) => [asset.name, asset]));
		for (const asset of list(`${releases}/${id}/assets`)) {
			const local = missing.get(asset.name);
			if (!local || asset.state !== 'uploaded' || asset.size !== local.size || asset.digest !== local.digest) {
				throw new Error('GitHub has an unexpected, incomplete or mismatched release asset. Inspect the release; existing assets were preserved.');
			}
			missing.delete(asset.name);
		}
		return [...missing.values()];
	}

	verifyPublicRepository();
	verifyTag();
	let release = findRelease();
	if (!release) {
		run(['release', 'create', version, '--repo', repository, '--verify-tag', '--draft', '--title', version, '--generate-notes']);
		release = findRelease();
	}
	checkRelease(release);
	const { id } = release;
	const missing = verifyAssets(id);
	if (!release.draft) {
		if (missing.length) throw new Error(`Published release ${version} is incomplete; it was left untouched.`);
		verifyTag();
		return url;
	}

	for (const { name } of missing) {
		const draft = api(`${releases}/${id}`);
		checkRelease(draft);
		if (draft.draft !== true || draft.id !== id) throw new Error(`Release ${version} changed during upload.`);
		api(`https://uploads.github.com/${releases}/${id}/assets?name=${encodeURIComponent(name)}`,
			'--method', 'POST', '--header', 'Content-Type: application/octet-stream', '--input', join(directory, name));
	}

	const draft = api(`${releases}/${id}`);
	checkRelease(draft);
	verifyPublicRepository();
	if (draft.draft !== true || draft.id !== id || verifyAssets(id).length) {
		throw new Error(`Release ${version} changed or its assets are incomplete. Publication was stopped.`);
	}

	verifyTag();
	const published = api(`${releases}/${id}`, '--method', 'PATCH', '-F', 'draft=false', '-f', 'make_latest=true');
	checkRelease(published);
	if (published.draft !== false || published.id !== id) throw new Error(`GitHub did not confirm publication of ${version}.`);
	verifyTag();
	if (verifyAssets(id).length) throw new Error(`Published release ${version} could not be verified. Inspect its assets.`);
	return url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [version, commit, directory, ...extra] = process.argv.slice(2);
		if (extra.length) throw new Error('Usage: node scripts/publish-release.mjs <version> <commit-sha> <artifacts-directory>');
		console.log(publishRelease(version, commit, directory, process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
