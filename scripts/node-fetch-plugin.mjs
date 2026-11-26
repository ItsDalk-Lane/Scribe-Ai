import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Patch only dependency-local fetch calls; Obsidian's global fetch is never changed. */
export function createNodeFetchPlugin() {
	const nodeFetchPath = path.resolve('src/communication/nodeFetch.ts');
	const confirmationPath = path.resolve('src/communication/modelRequestConfirmation.ts');
	let bedrockPatches = 0;
	return {
		name: 'scribe-node-fetch',
		setup(build) {
			build.onStart(() => { bedrockPatches = 0; });
			build.onLoad({ filter: /node_modules\/@earendil-works\/pi-ai\/.*\.(?:js|mjs)$/ }, async (args) => {
				const source = await readFile(args.path, 'utf8');
				// The SDK also reads model URLs and keys directly during payload preparation.
				if (args.path.endsWith('/@earendil-works/pi-ai/dist/utils/provider-env.js')) {
					const signature = 'export function getProviderEnvValue(name, env) {';
					if (!source.includes(signature)) throw new Error('Review provider environment handling after upgrading pi-ai.');
					return { contents: source.replace(signature,
						signature + '\n    if (!/^(?:https?|all|no)_proxy$/i.test(name)) return env?.[name] || undefined;'), loader: 'js' };
				}
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
				const patched = source.replace(/(await|return) fetch\(/g, '$1 __scribeNodeFetch(');
				if (patched === source) return;
				return {
					contents: `import { nodeFetch as __scribeNodeFetch } from ${JSON.stringify(nodeFetchPath)};\n${patched}`,
					loader: 'js',
				};
			});
			build.onEnd(() => {
				if (bedrockPatches !== 1) {
					throw new Error(`Expected 1 Bedrock request hook, found ${bedrockPatches}; review the pinned SDK before building.`);
				}
			});
		},
	};
}
