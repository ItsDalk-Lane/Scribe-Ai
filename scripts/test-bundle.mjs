import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createNodeFetchPlugin } from './node-fetch-plugin.mjs';

const suites = {
	communication: ['src/communication/tests/communication.test.ts'],
	agent: [
		'src/runtime/tests/agent.test.ts',
		'src/tools/tests/fileTools.test.ts',
		'src/tools/tests/searchShell.test.ts',
		'src/orchestration/tests/conversationStore.test.ts',
		'src/orchestration/tests/sessionController.test.ts',
		'src/orchestration/tests/contextBudget.test.ts',
		'src/orchestration/tests/selection.test.ts',
		'src/interaction/tests/approvalDiff.test.ts',
		'src/interaction/tests/chatTurnContent.test.ts',
		'src/interaction/tests/chatTimeline.test.ts',
		'src/interaction/tests/workingRow.test.ts',
		'src/interaction/tests/chatModel.test.ts',
		'src/interaction/tests/chatTabWorkspace.test.ts',
		'src/interaction/tests/markdownBlocks.test.ts',
		'src/interaction/tests/toolCardDetails.test.ts',
		'src/interaction/tests/composerKeyboard.test.ts',
		'src/interaction/tests/externalReferencePicker.test.ts',
	],
};
const suite = process.argv[2];
if (!Object.hasOwn(suites, suite)) throw new Error(`Unknown test suite: ${suite}`);
const outdir = await mkdtemp(path.join(tmpdir(), 'scribe-tests-'));
try {
	await esbuild.build({
		entryPoints: suites[suite],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node22',
		plugins: [createNodeFetchPlugin()],
		external: ['obsidian', 'electron', ...builtinModules],
		outdir,
		outExtension: { '.js': '.cjs' },
		entryNames: '[name]',
		logLevel: 'silent',
	});
	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--test', ...suites[suite].map((file) => path.join(outdir, path.basename(file, '.ts') + '.cjs'))], { stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => resolve(code ?? 1));
	});
	if (exitCode !== 0) process.exitCode = Number(exitCode);
} finally {
	await rm(outdir, { recursive: true, force: true });
}
