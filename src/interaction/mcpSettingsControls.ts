import { setIcon } from 'obsidian';
import type ScribeAiPlugin from '../main';
import { tr } from './skills/dialog';

export type McpSettingsManager = NonNullable<ScribeAiPlugin['services']['tools']['mcp']>;
export type McpServerView = ReturnType<McpSettingsManager['snapshot']>[number];

export const mcpTypeLabels = { stdio: 'STDIO', http: 'HTTP', sse: 'SSE' } as const;

export function mcpButton(parent: HTMLElement, label: string, cls = '', icon?: string): HTMLButtonElement {
	const button = parent.createEl('button', { cls, attr: { type: 'button' } });
	if (icon) setIcon(button.createSpan({ cls: 'scribe-icon-text-icon', attr: { 'aria-hidden': 'true' } }), icon);
	button.createSpan({ text: label });
	return button;
}

export function mcpSegments<T extends string>(parent: HTMLElement, label: string, options: readonly (readonly [T, string])[], change: (value: T) => void): (value: T) => void {
	const group = parent.createDiv({ cls: 'scribe-mcp-group', attr: { role: 'group', 'aria-label': label } });
	const controls = options.map(([value, name]) => {
		const button = mcpButton(group, name);
		button.addEventListener('click', () => change(value));
		return { button, value };
	});
	return (selected) => controls.forEach(({ button, value }) => button.setAttribute('aria-pressed', String(value === selected)));
}

export function mcpSearch(parent: HTMLElement, label: string, change: (query: string) => void): HTMLInputElement {
	const container = parent.createDiv({ cls: 'search-input-container' });
	const input = container.createEl('input', { attr: { type: 'search', placeholder: label, 'aria-label': label } });
	input.addEventListener('input', () => change(input.value.trim().toLowerCase()));
	return input;
}

export function mcpSwitch(parent: HTMLElement, label: string, value: boolean, change: (enabled: boolean) => void): HTMLButtonElement {
	const button = parent.createEl('button', { attr: { type: 'button', role: 'switch', 'aria-checked': String(value), 'aria-label': label } });
	button.addEventListener('click', () => change(button.getAttribute('aria-checked') !== 'true'));
	return button;
}

export function mcpStatus(view?: McpServerView, includeError = true): string {
	const state = view?.state ?? 'disabled';
	const status = {
		disabled: tr('已停用', 'Disabled'), connecting: tr('正在连接', 'Connecting'),
		ready: tr('已连接', 'Connected'), auth: tr('需要登录', 'Sign-in required'),
		error: tr('连接失败', 'Connection failed'),
	}[state];
	return includeError && view?.error ? status + ' · ' + view.error : status;
}
