import type { ModelOverride } from '../types';

export interface ModelDraftChange {
	model: string;
	previousModel: string;
	override: ModelOverride;
}

/** 更新模型列表和覆盖项，由调用方决定何时提交。 */
export function applyModelDraft(
	models: string[],
	overrides: Record<string, ModelOverride>,
	change: ModelDraftChange,
): { models: string[]; overrides: Record<string, ModelOverride> } {
	const nextModels = [...new Set(models.map((entry) => entry === change.previousModel ? change.model : entry))];
	if (!nextModels.includes(change.model)) nextModels.push(change.model);
	const nextOverrides = { ...overrides };
	if (change.previousModel !== change.model) delete nextOverrides[change.previousModel];
	if (Object.keys(change.override).length) nextOverrides[change.model] = change.override;
	else delete nextOverrides[change.model];
	return { models: nextModels, overrides: nextOverrides };
}
