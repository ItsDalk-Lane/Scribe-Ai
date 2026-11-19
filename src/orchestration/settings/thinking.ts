import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelService, ScribeSettings } from '../../types';

const levels = new Set<unknown>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return levels.has(value);
}

export function chatModelKey(providerId: string, model: string): string {
	return JSON.stringify([providerId, model]);
}

export function updateChatThinking(
	settings: ScribeSettings,
	selection: Pick<ScribeSettings, 'providerId' | 'model'> & { thinkingLevel?: ModelThinkingLevel },
	options: ModelService['thinkingOptions'],
): ScribeSettings['thinkingByModel'] {
	const key = chatModelKey(selection.providerId, selection.model);
	const current = settings.thinkingByModel[key];
	const level = options(selection, selection.thinkingLevel ?? current).level;
	if (level === current) return settings.thinkingByModel;
	const values = { ...settings.thinkingByModel };
	if (level) values[key] = level;
	else delete values[key];
	return values;
}
