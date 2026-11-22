import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { patchYamlField } from './skillFormat';
import type { SkillUiMetadata } from './skillFormat';
import type { LibraryDependency } from './contracts';

const names = { displayName: 'display_name', shortDescription: 'short_description', icon: 'icon_small',
	brandColor: 'brand_color', defaultPrompt: 'default_prompt' } as const;
export function parseOpenAiMetadata(source: string) {
	const doc = parseDocument(source, { intAsBigInt: true, keepSourceTokens: true });
	if (doc.errors.length || !isMap(doc.contents)) throw new Error('技能的界面说明文件格式不正确。');
	const ui = doc.get('interface', true);
	const fields: SkillUiMetadata = {};
	let iconKey: string = names.icon;
	if (isMap(ui)) {
		if (!ui.has(iconKey) && ui.has('icon_large')) iconKey = 'icon_large';
		for (const key of Object.keys(names) as Array<keyof typeof names>) {
			const value = ui.get(key === 'icon' ? iconKey : names[key]);
			if (typeof value === 'string' && value.trim()) fields[key] = value.trim();
		}
	}
	const policy = doc.get('policy', true);
	const deps = doc.get('dependencies', true);
	const tools = isMap(deps) ? deps.get('tools', true) : undefined;
	const dependencies: LibraryDependency[] = [];
	if (isSeq(tools)) {
		for (const entry of tools.items) {
			if (!isMap(entry) || entry.get('type') !== 'mcp') continue;
			const name = entry.get('value', true);
			if (!isScalar(name) || typeof name.value !== 'string' || !name.value.trim()) continue;
			const note = entry.get('description');
			dependencies.push({ type: 'mcp', name: name.value, note: typeof note === 'string' ? note : undefined });
		}
	}
	return { fields, iconKey, dependencies, implicit: !isMap(policy) || policy.get('allow_implicit_invocation') !== false };
}
export function editOpenAiMetadata(source: string, patch: SkillUiMetadata, iconKey: string) {
	let next = source;
	for (const key of Object.keys(patch) as Array<keyof typeof names>) {
		const value = patch[key]?.trim() || undefined;
		next = patchYamlField(next, ['interface', key === 'icon' ? iconKey : names[key]], value);
		if (key === 'icon' && !value && iconKey !== 'icon_large') next = patchYamlField(next, ['interface', 'icon_large'], undefined);
	}
	parseOpenAiMetadata(next);
	return next;
}
