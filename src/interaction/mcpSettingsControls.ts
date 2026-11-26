import { setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { extractMcpArgumentSecrets } from '../tools/external/mcpArgumentSecrets';
import { confirmAction } from './ConfirmModal';
import type ScribeAiPlugin from '../main';
import { tr } from './skills/dialog';

export type McpSettingsManager = NonNullable<ScribeAiPlugin['services']['tools']['mcp']>;
export type McpServerView = ReturnType<McpSettingsManager['snapshot']>[number];

export const mcpTypeLabels = { stdio: 'STDIO', http: 'HTTP', sse: 'SSE' } as const;

export async function setMcpEnabled(app: App, manager: McpSettingsManager, server: McpServerView['server'], enabled: boolean) {
	if (enabled && server.type === 'stdio') {
		const preview = JSON.stringify({ command: server.command, args: extractMcpArgumentSecrets(server.args).args ?? [],
			cwd: server.cwd ?? '.', envVars: server.envVars, secretRefs: server.secretRefs }, null, 2)
			.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
		const approved = await new Promise<boolean>((answer) => confirmAction(app, {
			title: tr('允许在此设备启动本地服务', 'Allow this local service on this device'),
			message: tr('此程序将以你的账户权限运行。已批准的配置会在以后打开此库时自动启动。', 'This program will run with your account permissions. The approved configuration will start when this vault opens.') + '\n' + preview,
			confirmText: tr('允许启动', 'Allow startup'), cancelText: tr('取消', 'Cancel'),
			onConfirm: () => answer(true), onClose: () => answer(false),
		}));
		if (!approved) return;
	}
	await manager.setEnabled(server.id, enabled, server);
}

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
