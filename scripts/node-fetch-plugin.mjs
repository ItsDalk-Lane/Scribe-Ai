import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Patch only dependency-local fetch calls; Obsidian's global fetch is never changed. */
export function createNodeFetchPlugin() {
	const nodeFetchPath = path.resolve('src/communication/nodeFetch.ts');
	const confirmationPath = path.resolve('src/communication/modelRequestConfirmation.ts');
	let googlePatches = 0;
	let bedrockPatches = 0;
	return {
		name: 'scribe-node-fetch',
		setup(build) {
			build.onStart(() => { googlePatches = 0; bedrockPatches = 0; });
			build.onLoad({ filter: /node_modules\/(?:@google\/genai|@earendil-works\/pi-ai)\/.*\.(?:js|mjs)$/ }, async (args) => {
				const source = await readFile(args.path, 'utf8');
				if (args.path.endsWith('/@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js')) {
					const client = 'const client = new BedrockRuntimeClient(config);';
					bedrockPatches += source.split(client).length - 1;
					const middleware = `client.middlewareStack.add((next) => async (args) => {
						await __scribeConfirmBedrock(args.request);
						return next(args);
					}, { step: 'finalizeRequest', priority: 'low', name: 'scribeConfirmDestination' });`;
					return {
						contents: `import { confirmBedrockRequest as __scribeConfirmBedrock } from ${JSON.stringify(confirmationPath)};\n${source.replace(client, `${client}\n${middleware}`)}`,
						loader: 'js',
					};
				}
				const matches = source.match(/(?:await|return) fetch\(/g);
				if (!matches) return;
				const google = args.path.includes('@google/genai');
				if (google) googlePatches += matches.length;
				const patched = source.replace(/(await|return) fetch\(/g, '$1 __scribeNodeFetch(');
				return {
					contents: `import { ${google ? 'modelNodeFetch' : 'nodeFetch'} as __scribeNodeFetch } from ${JSON.stringify(nodeFetchPath)};\n${patched}`,
					loader: 'js',
				};
			});
			build.onEnd(() => {
				if (googlePatches !== 3) {
					throw new Error(`Expected 3 Google fetch call sites, found ${googlePatches}; review the pinned SDK before building.`);
				}
				if (bedrockPatches !== 1) {
					throw new Error(`Expected 1 Bedrock request hook, found ${bedrockPatches}; review the pinned SDK before building.`);
				}
			});
		},
	};
}
