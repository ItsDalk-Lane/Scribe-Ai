import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Patch only dependency-local fetch calls; Obsidian's global fetch is never changed. */
export function createNodeFetchPlugin() {
	const nodeFetchPath = path.resolve('src/communication/nodeFetch.ts');
	let googlePatches = 0;
	return {
		name: 'scribe-node-fetch',
		setup(build) {
			build.onStart(() => { googlePatches = 0; });
			build.onLoad({ filter: /node_modules\/(?:@google\/genai|@earendil-works\/pi-ai)\/.*\.(?:js|mjs)$/ }, async (args) => {
				const source = await readFile(args.path, 'utf8');
				const matches = source.match(/(?:await|return) fetch\(/g);
				if (!matches) return;
				if (args.path.includes('@google/genai')) googlePatches += matches.length;
				const patched = source.replace(/(await|return) fetch\(/g, '$1 __scribeNodeFetch(');
				return {
					contents: `import { nodeFetch as __scribeNodeFetch } from ${JSON.stringify(nodeFetchPath)};\n${patched}`,
					loader: 'js',
				};
			});
			build.onEnd(() => {
				if (googlePatches !== 3) {
					throw new Error(`Expected 3 Google fetch call sites, found ${googlePatches}; review the pinned SDK before building.`);
				}
			});
		},
	};
}
