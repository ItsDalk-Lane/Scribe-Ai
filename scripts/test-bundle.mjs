import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { glob, mkdtemp, rm } from 'node:fs/promises';
import { createNodeFetchPlugin } from './node-fetch-plugin.mjs';

const suite = process.argv[2] ?? 'all';
if (!['all', 'agent', 'communication'].includes(suite)) throw new Error(`Unknown test suite: ${suite}`);
const tests = [];
for await (const file of glob('src/**/*.test.{ts,tsx}')) {
	const communication = file.startsWith(path.join('src', 'communication') + path.sep);
	if (suite === 'all' || suite === (communication ? 'communication' : 'agent')) tests.push(file);
}
tests.sort();
if (!tests.length) throw new Error(`No tests found for suite: ${suite}`);
const outdir = await mkdtemp(path.join(tmpdir(), 'scribe-tests-'));
try {
	await esbuild.build({
		entryPoints: tests,
		outbase: 'src',
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node22',
		plugins: [createNodeFetchPlugin()],
		external: ['obsidian', 'electron', ...builtinModules],
		outdir,
		outExtension: { '.js': '.cjs' },
		entryNames: '[dir]/[name]',
		logLevel: 'silent',
	});
	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--test', ...tests.map((file) => path.join(outdir, path.relative('src', file).replace(/\.tsx?$/u, '.cjs')))], { stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => resolve(code ?? 1));
	});
	if (exitCode !== 0) process.exitCode = Number(exitCode);
} finally {
	await rm(outdir, { recursive: true, force: true });
}
