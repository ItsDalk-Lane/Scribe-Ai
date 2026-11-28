import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelService, ScribeSettings } from '../../types';

export const THINKING_LEVEL_PRESETS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function isThinkingLevel(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z][a-z0-9_-]*$/i.test(value);
}

export function isBuiltInThinkingLevel(value: string): value is ModelThinkingLevel {
	return THINKING_LEVEL_PRESETS.some((level) => level === value);
}

export function chatModelKey(providerId: string, model: string): string {
	return JSON.stringify([providerId, model]);
}

export function chatReasoningForRequest(thinking: { levels: readonly string[]; level?: string }, preferred?: string): string | null | undefined {
	if (preferred === 'off') return null;
	const level = thinking.level ?? preferred;
	return level === 'off' || (level === undefined && thinking.levels[0] === 'off') ? null : level;
}

export function updateChatThinking(
	settings: ScribeSettings,
	selection: Pick<ScribeSettings, 'providerId' | 'model'> & { thinkingLevel?: string },
	options: ModelService['thinkingOptions'],
): ScribeSettings['thinkingByModel'] {
	const key = chatModelKey(selection.providerId, selection.model);
	const current = settings.thinkingByModel[key];
	const preferred = selection.thinkingLevel ?? current;
	const thinking = options(selection, preferred);
	const level = thinking.level ?? (!thinking.levels.length && isThinkingLevel(preferred) ? preferred : undefined);
	if (level === current) return settings.thinkingByModel;
	const values = { ...settings.thinkingByModel };
	if (level) values[key] = level;
	else delete values[key];
	return values;
}
