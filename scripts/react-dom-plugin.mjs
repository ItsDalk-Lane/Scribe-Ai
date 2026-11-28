import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const reactDomPath = /[\\/]react-dom[\\/]cjs[\\/]react-dom-client\.production\.js$/;
const reviewedDigest = 'a319b413b7a19ee34422d9a12a8e7afd003c07846716d278ba1a0898e8cb6251';
const rejectScripts = 'throw Error("Script loading is disabled in the Scribe renderer");';

export function createReactDomPlugin() {
	return {
		name: 'disable-react-dom-scripts',
		setup(build) {
			build.onLoad({ filter: reactDomPath }, async ({ path }) => {
				let contents = await readFile(path, 'utf8');
				if (createHash('sha256').update(contents).digest('hex') !== reviewedDigest) {
					throw new Error('React DOM has changed. Review its script-loading paths before updating the build patch.');
				}
				const replace = (before, after, replacement) => {
					const start = contents.indexOf(before);
					const end = contents.indexOf(after, start + before.length);
					if (start < 0 || end < 0 || contents.indexOf(before, start + 1) !== -1) {
						throw new Error(`Unexpected React DOM source while disabling scripts near ${before.trim()}`);
					}
					contents = contents.slice(0, start) + replacement + contents.slice(end);
				};
				// React's resource dispatcher can append executable script elements to the document head.
				replace('function preinitScript(src, options) {', 'function preinitModuleScript', `function preinitScript() { ${rejectScripts} }\n`);
				replace('function preinitModuleScript(src, options) {', 'function getResource', `function preinitModuleScript() { ${rejectScripts} }\n`);
				replace('    case "script":\n      return (\n        (currentProps = pendingProps.async),', '    default:', `    case "script":\n      ${rejectScripts}\n`);
				replace('      case "script":\n        instance$274 = getScriptKey(props.src);', '      case "void":', `      case "script":\n        ${rejectScripts}\n`);
				// Refuse regular script elements before the renderer chooses an HTML or SVG namespace.
				const host = '    case 5:\n      popHostContext(workInProgress);\n      type = workInProgress.type;\n';
				replace(host, '      if (null !== current && null != workInProgress.stateNode)', `${host}      if (type.toLowerCase() === "script") ${rejectScripts}\n`);
				replace('                case "script":\n                  nextResource = ownerDocument.createElement("div");', '                case "select":', '');
				return { contents, resolveDir: dirname(path) };
			});
		},
	};
}
