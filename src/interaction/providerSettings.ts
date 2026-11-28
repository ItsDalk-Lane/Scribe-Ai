import type { ModelService, ScribeSettings } from '../types';
import { reconcileDefaultModel } from '../orchestration/settings/modelAvailability';

export function removeProviderSettings(settings: ScribeSettings, providerId: string, modelType?: ModelService['modelType']): void {
	delete settings.providerModels[providerId];
	delete settings.modelOverrides[providerId];
	delete settings.customProviders[providerId];
	delete settings.communication.credentialIds[providerId];
	delete settings.communication.providerNames[providerId];
	delete settings.communication.baseUrls[providerId];
	delete settings.communication.protocols[providerId];
	settings.disabledProviderIds = settings.disabledProviderIds.filter((id) => id !== providerId);
	if (settings.providerId === providerId) reconcileDefaultModel(settings, modelType);
}
