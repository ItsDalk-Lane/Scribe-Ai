import { readFile } from 'node:fs/promises';

export function createMcpValidationPlugin() {
	return {
		name: 'mcp-interpreted-schema-validation',
		setup(build) {
			build.onLoad({ filter: /[\\/]@modelcontextprotocol[\\/]sdk[\\/]dist[\\/]esm[\\/]client[\\/]index\.js$/ }, async ({ path }) => {
				const source = await readFile(path, 'utf8');
				const ajvImport = "import { AjvJsonSchemaValidator } from '../validation/ajv-provider.js';";
				const ajvDefault = 'new AjvJsonSchemaValidator()';
				if (source.split(ajvImport).length !== 2 || source.split(ajvDefault).length !== 2) {
					throw new Error('MCP SDK client changed. Recheck its default JSON Schema validator before bundling.');
				}
				// The SDK eagerly imports Ajv even when callers supply a validator, so replace that default at the source.
				return { contents: source
					.replace(ajvImport, "import { CfWorkerJsonSchemaValidator } from '../validation/cfworker-provider.js';")
					.replace(ajvDefault, 'new CfWorkerJsonSchemaValidator()'), loader: 'js' };
			});
		},
	};
}
