import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const assetNames = ['main.js', 'manifest.json', 'styles.css'];

export function isReleaseVersion(value) {
	return typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value);
}

function parseObject(content, name) {
	let value;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error(`${name} must contain valid JSON.`);
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${name} must contain a JSON object.`);
	}
	return value;
}

function checkManifest(content, expectedVersion) {
	const manifest = parseObject(content, 'manifest.json');
	if (manifest.id !== 'scribe-ai') throw new Error('manifest.json must retain the published plugin ID scribe-ai.');
	if (typeof manifest.name !== 'string' || !/^[A-Za-z0-9 +()-]+$/u.test(manifest.name) || !manifest.name.trim()
		|| /obsidian|\bobsi-|-sidian\b/iu.test(manifest.name)) {
		throw new Error('manifest.json must have a valid display name without the Obsidian trademark.');
	}
	if (typeof manifest.author !== 'string' || !manifest.author.trim()) {
		throw new Error('manifest.json must have an author.');
	}
	const description = typeof manifest.description === 'string' ? manifest.description : '';
	if (/\bobsidian\b/iu.test(description)) throw new Error('The manifest description must not include the word Obsidian.');
	if (description.length > 250 || !description.endsWith('.') || !/[\p{L}\p{N}]/u.test(description)
		|| /[\p{Extended_Pictographic}\r\n]/u.test(description)) {
		throw new Error('The manifest description must be a short sentence ending with a period (at most 250 characters, without emoji).');
	}
	if (!isReleaseVersion(manifest.minAppVersion)) throw new Error('The minimum Obsidian version must use x.y.z.');
	if (manifest.isDesktopOnly !== true) throw new Error('Scribe Ai uses Node.js APIs and must remain desktop-only.');
	if (!isReleaseVersion(manifest.version)) throw new Error('The manifest release version must use x.y.z.');
	if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
		throw new Error('The manifest version does not match the requested release version or tag.');
	}
	return manifest;
}

export function checkRelease(root, expectedVersion) {
	if (expectedVersion !== undefined && !isReleaseVersion(expectedVersion)) {
		throw new Error('The release version or tag must use x.y.z without a prefix or suffix.');
	}
	const read = (name) => readFileSync(join(root, name), 'utf8');
	const manifest = checkManifest(read('manifest.json'), expectedVersion);
	const pkg = parseObject(read('package.json'), 'package.json');
	const lock = parseObject(read('package-lock.json'), 'package-lock.json');
	const versions = parseObject(read('versions.json'), 'versions.json');
	if (pkg.version !== manifest.version) throw new Error('package.json version must match manifest.json.');
	if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) {
		throw new Error('Both package-lock.json versions must match manifest.json.');
	}
	if (versions[manifest.version] !== manifest.minAppVersion) {
		throw new Error('versions.json must map the release version to the minimum Obsidian version in manifest.json.');
	}
	for (const name of ['README.md', 'LICENSE']) {
		if (!read(name).trim()) throw new Error(`${name} must not be empty.`);
	}
	return manifest;
}

export function releaseAssetDigests(directory, expectedVersion) {
	if (!isReleaseVersion(expectedVersion)) throw new Error('The release version or tag must use x.y.z without a prefix or suffix.');
	return assetNames.map((name) => {
		const path = join(directory, name);
		const file = lstatSync(path, { throwIfNoEntry: false });
		if (!file?.isFile()) throw new Error(`Release asset ${name} must be a regular file.`);
		const contents = readFileSync(path);
		if (!contents.length) throw new Error(`Release asset ${name} must not be empty.`);
		if (name === 'manifest.json') checkManifest(contents.toString('utf8'), expectedVersion);
		return { name, size: contents.length, digest: `sha256:${createHash('sha256').update(contents).digest('hex')}` };
	});
}

if (import.meta.main) {
	const [version, ...extra] = process.argv.slice(2);
	if (extra.length) throw new Error('Usage: node scripts/check-release.mjs [version]');
	const manifest = checkRelease(process.cwd(), version);
	console.log(`Release metadata verified for ${manifest.version}.`);
}
