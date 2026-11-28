import type { ModelService, ScribeSettings, VideoSourceKind } from '../../types';
import { configuredModelType } from './mediaSettings';

export function videoModelFor(settings: ScribeSettings, source: VideoSourceKind) {
	return source === 'file' ? settings.videoModel : settings.videoLinkModel;
}

export function isProviderEnabled(settings: ScribeSettings, providerId: string): boolean {
	return !settings.disabledProviderIds.includes(providerId);
}

export function isTextModel(settings: Pick<ScribeSettings, 'modelOverrides'>, { providerId, model }: Pick<ScribeSettings, 'providerId' | 'model'>,
	modelType?: ModelService['modelType']): boolean {
	return (modelType?.(providerId, model) ?? configuredModelType(settings, providerId, model)) === 'text';
}

export function isModelAvailable(settings: ScribeSettings, { providerId, model }: Pick<ScribeSettings, 'providerId' | 'model'>,
	modelType?: ModelService['modelType']): boolean {
	return isProviderEnabled(settings, providerId) && settings.providerModels[providerId]?.includes(model) === true
		&& isTextModel(settings, { providerId, model }, modelType);
}

export function isPdfAnalysisModelAvailable(settings: ScribeSettings, selection: ScribeSettings['pdfModel'],
	models: Pick<ModelService, 'modelType' | 'modelCapabilities'>): boolean {
	return Boolean(selection && isModelAvailable(settings, selection, models.modelType)
		&& models.modelCapabilities?.(selection.providerId, selection.model).pdfAnalysis);
}

export function reconcileDefaultModel(settings: ScribeSettings, modelType?: ModelService['modelType']): void {
	if (isModelAvailable(settings, settings, modelType)) return;
	const eligible = Object.entries(settings.providerModels).flatMap(([providerId, models]) => {
		const model = models.find((model) => isModelAvailable(settings, { providerId, model }, modelType));
		return model ? [{ providerId, model }] : [];
	});
	const next = eligible.find(({ providerId }) => providerId === settings.providerId) ?? eligible[0];
	settings.providerId = next?.providerId ?? '';
	settings.model = next?.model ?? '';
}

export function setProviderEnabled(settings: ScribeSettings, providerId: string, enabled: boolean, modelType?: ModelService['modelType']): void {
	if (!settings.providerModels[providerId]?.length || enabled === isProviderEnabled(settings, providerId)) return;
	settings.disabledProviderIds = enabled
		? settings.disabledProviderIds.filter((id) => id !== providerId)
		: [...settings.disabledProviderIds, providerId];
	reconcileDefaultModel(settings, modelType);
}
