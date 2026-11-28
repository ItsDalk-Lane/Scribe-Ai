import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const stdioDigest = '298514feae7875117a119a2598b40f2346ef07c30152fa7ad2ffb6cfb51782bc';

export function createMcpValidationPlugin() {
	return {
		name: 'mcp-sdk-safety',
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
			build.onLoad({ filter: /[\\/]@modelcontextprotocol[\\/]sdk[\\/]dist[\\/]esm[\\/]client[\\/]stdio\.js$/ }, async ({ path }) => {
				const source = await readFile(path, 'utf8');
				if (createHash('sha256').update(source).digest('hex') !== stdioDigest) {
					throw new Error('MCP SDK stdio changed. Recheck its environment inheritance before bundling.');
				}
				const defaultsStart = source.indexOf('/**\n * Environment variables to inherit by default');
				const clientStart = source.indexOf('/**\n * Client transport for stdio');
				// The SDK merges its defaults at spawn time even when the caller supplies an environment.
				const contents = (source.slice(0, defaultsStart) + source.slice(clientStart))
					.replace(/\/\/ merge default env with server env[^\n]*\n\s*env: \{[^}]*\},/, 'env: this._serverParams.env ?? {},');
				return { contents, loader: 'js' };
			});
		},
	};
}
