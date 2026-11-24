import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

const storageMessage = '插件数据必须写入当前库的 .scribe-ai。请使用现有存储模块。';
const browserStorage = ['localStorage', 'sessionStorage', 'indexedDB'];
const pluginData = ['loadData', 'saveData'];
const oldLocalState = ['loadLocalStorage', 'saveLocalStorage'];
const storageProperties = (...properties: string[]) =>
	properties.map((property) => ({ property, message: storageMessage }));
const browserStorageReference = {
	selector: 'Identifier[name=/^(localStorage|sessionStorage|indexedDB)$/]:not(MemberExpression > Identifier.property, Property > Identifier.key)',
	message: storageMessage,
};
const runtimeStorageSyntax = [browserStorageReference, {
	selector: 'ImportDeclaration[source.value=/^(node:)?os$/] > ImportSpecifier[imported.name=tmpdir]',
	message: storageMessage,
}];

function restrictLegacyWrite(method: string, allowedCall: string, message: string) {
	return [
		{ selector: `MemberExpression:matches([property.name="${method}"], [property.value="${method}"]):not(${allowedCall})`, message },
		{ selector: `ObjectPattern > Property:matches([key.name="${method}"], [key.value="${method}"])`, message },
	];
}

export default defineConfig(
	globalIgnores([
		'node_modules',
		'.pi',
		'scripts',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['src/**/*.{ts,tsx}'],
		ignores: ['**/tests/**', '**/*.test.{ts,tsx}'],
		rules: {
			'no-restricted-properties': ['error', ...storageProperties(...browserStorage, ...pluginData, ...oldLocalState, 'tmpdir')],
			'no-restricted-syntax': ['error', ...runtimeStorageSyntax],
		},
	},
	{
		files: ['src/orchestration/storage/pluginStorage.ts'],
		rules: {
			'no-restricted-properties': ['error', ...storageProperties(...browserStorage, ...oldLocalState, 'tmpdir')],
			'no-restricted-syntax': ['error', ...runtimeStorageSyntax, ...restrictLegacyWrite('saveData',
				'CallExpression[arguments.length=1][arguments.0.type=ObjectExpression][arguments.0.properties.length=1]'
				+ '[arguments.0.properties.0.computed=false][arguments.0.properties.0.key.name=storageVersion]'
				+ '[arguments.0.properties.0.value.name=STORAGE_VERSION] > MemberExpression.callee[object.name=plugin][computed=false]',
				'插件的 data.json 只能由存储入口写入 { storageVersion: STORAGE_VERSION }。')],
		},
	},
	{
		files: ['src/orchestration/storage/localState.ts', 'src/interaction/slashPresets.ts'],
		rules: {
			'no-restricted-properties': ['error', ...storageProperties(...browserStorage, ...pluginData, 'tmpdir')],
			'no-restricted-syntax': ['error', ...runtimeStorageSyntax, ...restrictLegacyWrite('saveLocalStorage',
				'CallExpression[arguments.length=2][arguments.1.type=Literal][arguments.1.raw="null"]'
				+ ' > MemberExpression.callee[object.name=app][computed=false]',
				'旧的本机存储只用于迁移，写入仅允许传 null 清理旧记录。')],
		},
	},
	{
		// 启动时仍要按原保留期清理旧版产生的系统临时输出。
		files: ['src/tools/support/spillCleanup.ts'],
		rules: {
			'no-restricted-properties': ['error', ...storageProperties(...browserStorage, ...pluginData, ...oldLocalState)],
			'no-restricted-syntax': ['error', browserStorageReference],
		},
	},
);
