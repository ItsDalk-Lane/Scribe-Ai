import type { ScribeSettings, VideoSourceKind } from '../../types';

export function videoModelFor(settings: ScribeSettings, source: VideoSourceKind) {
	return source === 'file' ? settings.videoModel : settings.videoLinkModel;
}

export function isProviderEnabled(settings: ScribeSettings, providerId: string): boolean {
	return !settings.disabledProviderIds.includes(providerId);
}

export function isModelAvailable(settings: ScribeSettings, { providerId, model }: Pick<ScribeSettings, 'providerId' | 'model'>): boolean {
	return isProviderEnabled(settings, providerId) && settings.providerModels[providerId]?.includes(model) === true;
}

export function reconcileDefaultModel(settings: ScribeSettings): void {
	if (isModelAvailable(settings, settings)) return;
	const eligible = Object.entries(settings.providerModels)
		.filter(([id, models]) => models.length && isProviderEnabled(settings, id));
	const next = eligible.find(([id]) => id === settings.providerId) ?? eligible[0];
	settings.providerId = next?.[0] ?? '';
	settings.model = next?.[1][0] ?? '';
}

export function setProviderEnabled(settings: ScribeSettings, providerId: string, enabled: boolean): void {
	if (!settings.providerModels[providerId]?.length || enabled === isProviderEnabled(settings, providerId)) return;
	settings.disabledProviderIds = enabled
		? settings.disabledProviderIds.filter((id) => id !== providerId)
		: [...settings.disabledProviderIds, providerId];
	reconcileDefaultModel(settings);
}
