import type { UiText } from './uiText';

export function formatWorkingElapsed(ms: number, text: Pick<UiText, 'chatWorkingSeconds' | 'chatWorkingMinutes' | 'chatWorkingHours'>): string {
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor(ms / 60_000) % 60;
	const seconds = ((ms % 60_000) / 1000).toFixed(1);
	const template = hours ? text.chatWorkingHours : minutes ? text.chatWorkingMinutes : text.chatWorkingSeconds;
	return template.replace('{h}', String(hours)).replace('{m}', String(minutes)).replace('{s}', seconds);
}
