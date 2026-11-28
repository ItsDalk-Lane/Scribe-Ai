import { readFile } from 'node:fs/promises';

export function createAnthropicResourcesPlugin() {
	return {
		name: 'anthropic-chat-resources',
		setup(build) {
			build.onLoad({ filter: /[\\/]@anthropic-ai[\\/]sdk[\\/]resources[\\/]beta[\\/]beta\.mjs$/ }, async ({ path }) => {
				// The chat adapter uses Messages. The default client also wires up a self-hosted worker.
				let contents = await readFile(path, 'utf8');
				for (const line of [
					'import * as EnvironmentsAPI from "./environments/environments.mjs";',
					'import { Environments, } from "./environments/environments.mjs";',
					'            this.environments = new EnvironmentsAPI.Environments(this._client);',
					'    Beta.Environments = Environments;',
				]) {
					const exact = line + '\n';
					if (contents.split(exact).length !== 2) {
						throw new Error('Anthropic SDK resources changed. Review the self-hosted environment imports before bundling.');
					}
					contents = contents.replace(exact, '');
				}
				return { contents, loader: 'js' };
			});
		},
	};
}
