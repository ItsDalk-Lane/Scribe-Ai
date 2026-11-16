import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { createNodeFetchPlugin } from './node-fetch-plugin.mjs';

const outfile = path.join(tmpdir(), `scribe-communication-tests-${process.pid}.cjs`);
try {
	await esbuild.build({
		entryPoints: ['src/communication/tests/communication.test.ts'],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node22',
		plugins: [createNodeFetchPlugin()],
		external: ['obsidian', 'electron', ...builtinModules],
		outfile,
		logLevel: 'silent',
	});
	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--test', outfile], { stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => resolve(code ?? 1));
	});
	if (exitCode !== 0) process.exitCode = Number(exitCode);
} finally {
	await unlink(outfile).catch(() => {});
}
