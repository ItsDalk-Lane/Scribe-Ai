import { isThinkingLevel } from '../orchestration/settings/thinking';
import { catalogVideoInput } from '../communication/modelVideo';
import type { ModelCatalogDetails, ModelInputModality, ModelOverride, ProviderModelInfo } from '../types';

const DEFAULT_THINKING = ['minimal', 'low', 'medium', 'high'];
const INPUT_MODALITIES = new Set<string>(['text', 'image', 'audio', 'video', 'pdf']);

function tokenLimit(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function inputModalities(value: unknown): ModelInputModality[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return [...new Set(value.filter((entry: unknown): entry is ModelInputModality => typeof entry === 'string' && INPUT_MODALITIES.has(entry)))];
}

/** 只按当前连接的模型资料补齐缺失字段，保留已保存的值和明确的 false。 */
export function prefillModelConfiguration(
	override: ModelOverride | undefined, details?: ModelCatalogDetails, bundled?: ProviderModelInfo,
) {
	const catalogContext = tokenLimit(details?.contextWindow) ?? tokenLimit(bundled?.contextWindow);
	const catalogOutput = tokenLimit(details?.maxTokens) ?? tokenLimit(bundled?.maxTokens);
	const knownInput = inputModalities(details?.evidence?.inputModalities?.conflict ? undefined : details?.inputModalities)
		?? inputModalities(bundled?.input);
	const video = catalogVideoInput(details);
	const catalogInput: ModelInputModality[] | undefined = video === undefined || video === knownInput?.includes('video')
		? knownInput : video ? [...(knownInput ?? ['text']), 'video'] : knownInput?.filter((value) => value !== 'video');
	const nativeLevels = bundled?.thinkingLevels ?? [];
	const reportedLevels = Array.isArray(details?.reportedThinkingLevels) ? details.reportedThinkingLevels.filter(isThinkingLevel) : undefined;
	const catalogLevels = reportedLevels ?? (details?.thinkingLevels?.length ? details.thinkingLevels.filter(isThinkingLevel) : undefined)
		?? (nativeLevels.length ? nativeLevels : undefined);
	const savedLevels = Array.isArray(override?.thinkingLevels) ? override.thinkingLevels.filter(isThinkingLevel)
		: isThinkingLevel(override?.thinkingLevel) ? [override.thinkingLevel] : undefined;
	const requiresReasoning = bundled?.requiresReasoning === true;
	const thinkingLevels = [...new Set(savedLevels ?? catalogLevels ?? DEFAULT_THINKING)].filter((level) => level !== 'off' || !requiresReasoning);
	return {
		contextWindow: tokenLimit(override?.contextWindow) ?? catalogContext ?? 128000,
		maxTokens: tokenLimit(override?.maxTokens) ?? catalogOutput ?? 8000,
		input: inputModalities(override?.input) ?? catalogInput ?? ['text' as const],
		reasoning: requiresReasoning || (override?.capabilities?.reasoning ?? details?.reasoning ?? bundled?.reasoning ?? false),
		tools: override?.capabilities?.tools ?? details?.tools ?? true,
		structuredOutput: override?.capabilities?.structuredOutput ?? (!details?.evidence?.structuredOutput?.conflict && details?.structuredOutput === true),
		requiresReasoning,
		thinkingLevels,
		literalThinkingLevels: override?.literalThinkingLevels === true || (savedLevels === undefined && reportedLevels !== undefined
			&& reportedLevels.some((level) => level !== 'off' && level !== 'minimal' && !nativeLevels.some((native) => native === level))),
	};
}

export function modelConfigurationOverride(
	draft: Pick<ReturnType<typeof prefillModelConfiguration>, 'contextWindow' | 'maxTokens' | 'input' | 'reasoning' | 'tools' | 'structuredOutput' | 'thinkingLevels'>,
	initial: ReturnType<typeof prefillModelConfiguration>, saved?: ModelOverride,
): ModelOverride {
	const override: ModelOverride = {};
	if (saved?.contextWindow !== undefined || draft.contextWindow !== initial.contextWindow) override.contextWindow = draft.contextWindow;
	if (saved?.maxTokens !== undefined || draft.maxTokens !== initial.maxTokens) override.maxTokens = draft.maxTokens;
	if (saved?.input || draft.input.length !== initial.input.length
		|| draft.input.some((modality) => !initial.input.includes(modality))) override.input = [...draft.input];
	// 旧配置中的输出模态和额外能力字段继续保存。
	if (saved?.output) override.output = saved.output;
	const capabilities = { ...saved?.capabilities };
	if (capabilities.reasoning !== undefined || draft.reasoning !== initial.reasoning) capabilities.reasoning = draft.reasoning;
	if (capabilities.tools !== undefined || draft.tools !== initial.tools) capabilities.tools = draft.tools;
	if (capabilities.structuredOutput !== undefined || draft.structuredOutput !== initial.structuredOutput) capabilities.structuredOutput = draft.structuredOutput;
	if (Object.keys(capabilities).length) override.capabilities = capabilities;
	const thinkingChanged = draft.thinkingLevels.join() !== initial.thinkingLevels.join();
	if (saved?.thinkingLevels || saved?.thinkingLevel || thinkingChanged) {
		override.thinkingLevels = [...draft.thinkingLevels];
		if (initial.literalThinkingLevels || thinkingChanged) override.literalThinkingLevels = true;
	}
	return override;
}

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
