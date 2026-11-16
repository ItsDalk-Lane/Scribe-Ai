#!/usr/bin/env node
// Copies build artifacts into the Obsidian test vault. data.json stays untouched.
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target =
	process.env.SCRIBE_VAULT_PLUGIN_DIR ??
	join(homedir(), 'Desktop/Scribe/.obsidian/plugins/scribe-ai');
const artifacts = ['main.js', 'manifest.json', 'styles.css'];

await mkdir(target, { recursive: true });
const synced = [];
for (const name of artifacts) {
	const source = join(root, name);
	try {
		await access(source, constants.F_OK);
	} catch {
		continue;
	}
	// remove first: the vault previously held symlinks pointing at the old build dir
	await rm(join(target, name), { force: true });
	await copyFile(source, join(target, name));
	synced.push(name);
}
if (synced.length === 0) throw new Error(`No build artifacts found in ${root}; run the build first.`);
console.log(`Synced ${synced.join(', ')} -> ${target}`);
