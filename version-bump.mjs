import { readFileSync, writeFileSync } from 'node:fs';
import { isReleaseVersion } from './scripts/check-release.mjs';

const targetVersion = process.env.npm_package_version;
if (!isReleaseVersion(targetVersion)) throw new Error('The release version must use x.y.z.');

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
if (!isReleaseVersion(minAppVersion)) throw new Error('The minimum Obsidian version must use x.y.z.');
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));

manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t'));

if (versions[targetVersion] !== minAppVersion) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}
