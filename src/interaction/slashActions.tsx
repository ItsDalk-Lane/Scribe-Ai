import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { App, FileSystemAdapter } from 'obsidian';
import { createRoot } from 'react-dom/client';
import type ScribeAiPlugin from '../main';
import { BUILTIN_SUBAGENT_ROLES, normalizeSubagentSettings } from '../orchestration/settings/subagentSettings';
import { isWithinPath, normalizeVaultRelativePath } from '../tools/support/pathUtils';
import { stripGoalReport } from './chatGoal';
import { stripPlanMarkers } from './chatPlan';
import ChatMarkdown from './components/ChatMarkdown';
import FileChanges from './components/FileChanges';
import { mcpStatus, mcpTypeLabels, type McpServerView, type McpSettingsManager } from './mcpSettingsControls';
import type { SlashTargetChoice } from './slashCommands';
import { slashCommandText } from './slashCommandText';
import type { SlashUi } from './slashUi';
import { tr } from './skills/dialog';
import { uiText } from './uiText';
import type { NoteChange, RunState, SavedRun, TaskTarget } from '../types';

export async function showSlashSummary(app: App, ui: SlashUi, title: string, summary: string): Promise<boolean> {
	return ui.panel(title, (host) => {
		const root = createRoot(host);
		root.render(<ChatMarkdown app={app} content={summary} />);
		return () => root.unmount();
	});
}

export async function openSlashSettings(plugin: ScribeAiPlugin): Promise<boolean> {
	// Obsidian 的插件设置页使用宿主的设置管理器打开。
	const { setting } = plugin.app as App & {
		setting?: { open?: () => unknown; openTabById?: (id: string) => unknown };
	};
	if (typeof setting?.open !== 'function' || typeof setting.openTabById !== 'function') {
		throw new Error(tr('无法打开设置，请从 Obsidian 设置中打开 Scribe Ai。', 'Open Scribe Ai from Obsidian settings.'));
	}
	await setting.open();
	await setting.openTabById(plugin.manifest.id);
	return true;
}

export function showSlashMcp(plugin: ScribeAiPlugin, ui: SlashUi): Promise<boolean> {
	return ui.panel(slashCommandText().commandLabel('mcp'), (host) => drawSlashMcp(host, plugin.services.tools.mcp));
}

export function chooseSlashMcp(plugin: ScribeAiPlugin, ui: SlashUi): Promise<TaskTarget | undefined> {
	return ui.custom<TaskTarget>(slashCommandText().commandLabel('mcp'), (host, select) => drawSlashMcp(host, plugin.services.tools.mcp, select));
}

function mcpSlashTarget(view: McpServerView): SlashTargetChoice {
	const { server, state } = view;
	const status = mcpStatus(view, false);
	return {
		target: { kind: 'mcp', id: server.id, label: server.name },
		description: mcpTypeLabels[server.type],
		reason: state === 'ready' ? undefined : status,
	};
}

function agentSlashTargets(plugin: ScribeAiPlugin): SlashTargetChoice[] {
	const { settings } = plugin.services;
	const { mode, roles: custom } = normalizeSubagentSettings(settings.subagents);
	const roles = new Map([...BUILTIN_SUBAGENT_ROLES, ...custom].map((role) => [role.name, role]));
	return [...roles.values()].map(({ name, description, model }) => ({
		target: { kind: 'agent', id: name, label: name },
		description,
		reason: mode === 'off' ? tr('子 Agent 已关闭。', 'Subagents are off.')
			: model && !settings.providerModels[model.providerId]?.includes(model.model)
				? tr('所选模型已不可用。', 'Configured model unavailable.') : undefined,
	}));
}

export function getSlashTargets(plugin: ScribeAiPlugin): SlashTargetChoice[] {
	return [...(plugin.services.tools.mcp?.snapshot().map(mcpSlashTarget) ?? []), ...agentSlashTargets(plugin)];
}

function drawSlashMcp(host: HTMLElement, manager?: McpSettingsManager, select?: (value: TaskTarget) => void) {
	const draw = () => {
		const focused = host.ownerDocument.activeElement as HTMLElement | null;
		const activeId = host.contains(focused) ? focused?.dataset.targetId : undefined;
		host.empty();
		const servers = manager?.snapshot() ?? [];
		if (!servers.length) {
			host.createEl('p', { cls: 'scribe-slash-panel-message', text: tr('还没有配置 MCP 服务。', 'No MCP services configured yet.') });
			return;
		}
		const list = host.createDiv({ cls: 'scribe-slash-panel-list', attr: { role: 'list' } });
		for (const view of servers) {
			const { server, state } = view;
			const choice = mcpSlashTarget(view);
			const item = list.createDiv({ attr: { role: 'listitem' } });
			const button = select && item.createEl('button', { cls: 'scribe-slash-mcp-row', attr: { type: 'button' } });
			const row = button ?? item.createDiv({ cls: 'scribe-slash-mcp-row' });
			if (select && button) {
				button.disabled = Boolean(choice.reason);
				button.dataset.targetId = server.id;
				button.addEventListener('click', () => select(choice.target));
				if (activeId === server.id) button.focus({ preventScroll: true });
			}
			row.createSpan({ cls: 'scribe-mcp-status-dot', attr: { 'data-state': state, 'aria-hidden': 'true' } });
			row.createEl('strong', { text: server.name });
			row.createSpan({ cls: 'scribe-mcp-type', text: mcpTypeLabels[server.type] });
			row.createSpan({ cls: 'scribe-slash-mcp-status', text: mcpStatus(view, false) });
		}
	};
	draw();
	return manager?.subscribe(draw);
}

export function chooseSlashAgent(plugin: ScribeAiPlugin, ui: SlashUi): Promise<TaskTarget | undefined> {
	return ui.custom<TaskTarget>(slashCommandText().commandLabel('agents'), (host, select) => {
		const draw = () => {
			host.empty();
			const off = plugin.services.settings.subagents?.mode === 'off';
			if (off) host.createEl('p', { cls: 'scribe-slash-panel-message', text: tr('子 Agent 已关闭，可以在 Scribe Ai 设置中启用。', 'Subagents are off. Enable them in Scribe Ai settings.') });
			const list = host.createDiv({ cls: 'scribe-slash-panel-list', attr: { role: 'list' } });
			for (const { target, description, reason } of agentSlashTargets(plugin)) {
				const item = list.createDiv({ attr: { role: 'listitem' } });
				const button = item.createEl('button', { cls: 'scribe-slash-agent-row', attr: { type: 'button' } });
				button.disabled = Boolean(reason);
				button.createEl('strong', { text: target.label });
				button.createSpan({ cls: 'scribe-slash-agent-description', text: [description, off ? undefined : reason].filter(Boolean).join(' · ') });
				button.addEventListener('click', () => select(target));
			}
		};
		draw();
		return plugin.subscribeSettings(draw);
	});
}

export async function showSlashWarnings(plugin: ScribeAiPlugin, ui: SlashUi): Promise<boolean> {
	const rows = plugin.services.communication.transport.logs().filter(({ error, phase }) => error || phase === 'error').slice(-20).reverse();
	return ui.show(uiText().diagnostics, rows.length ? rows.map(({ at, error, status }) =>
		[new Date(at).toLocaleTimeString(), status, error].filter(Boolean).join(' · ')) : [uiText().noDiagnostics]);
}

export function writableNotePath(path: string, configDir: string): string | undefined {
	const normalized = normalizeVaultRelativePath(path);
	if (!normalized || path.includes('\\') || Array.from(path).some((value) => value.charCodeAt(0) < 32) || path.split('/').includes('..')
		|| normalized === configDir || normalized.startsWith(`${configDir}/`)) return;
	return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

export function transcriptMarkdown(runs: readonly SavedRun[]): string {
	return runs.flatMap(({ request, state }) => [
		`## ${tr('你', 'You')}\n\n${request.instruction}`,
		...state.messages.flatMap(({ role, content, incomplete, subagentActivity }, index) => {
			if (!content.trim() || incomplete || subagentActivity) return [];
			if (role === 'assistant') return [`## ${tr('助手', 'Assistant')}\n\n${stripPlanMarkers(stripGoalReport(content))}`];
			return role === 'user' && index > 0 ? [`## ${tr('你', 'You')}\n\n${content}`] : [];
		}),
	]).join('\n\n');
}

export async function exportSlash(app: App, runs: readonly SavedRun[], path: string, title: string, ui: SlashUi): Promise<boolean> {
	if (!runs.length) throw new Error(tr('暂无可导出的聊天。', 'There is no conversation to export.'));
	const safeTitle = Array.from(title, (value) => value.charCodeAt(0) < 32 ? ' ' : value).join('').replace(/[<>:"/\\|?*]/gu, ' ');
	const suggested = `${safeTitle.trim().slice(0, 80) || 'Scribe AI'}.md`;
	const root = await realpath((app.vault.adapter as FileSystemAdapter).getBasePath());
	let entered: string | undefined = path || await ui.prompt(tr('保存聊天到笔记库', 'Save conversation to vault'), suggested);
	while (entered !== undefined) {
		const target = writableNotePath(entered, app.vault.configDir);
		if (!target) throw new Error(tr('请输入笔记库内的 Markdown 路径。', 'Enter a Markdown path within the vault.'));
		const parent = resolve(root, dirname(target));
		if (!isWithinPath(root, parent) || await realpath(parent) !== parent) {
			throw new Error(tr('请选择笔记库内的普通文件夹。', 'Choose a regular folder within the vault.'));
		}
		if (!app.vault.getAbstractFileByPath(target)) {
			let file;
			try {
				file = await app.vault.create(target, `# ${title}\n\n${transcriptMarkdown(runs)}\n`);
			} catch (error) {
				if (!app.vault.getAbstractFileByPath(target)) throw error;
			}
			if (file) {
				await app.workspace.getLeaf('tab').openFile(file).catch(() => {});
				return true;
			}
		}
		entered = await ui.prompt(tr('笔记已存在，请另选名称', 'A note already exists. Choose another name.'), target);
	}
	return false;
}

export function slashNoteChanges(runs: readonly SavedRun[], live?: RunState | null) {
	return [...runs.map(({ state }) => state), ...(live ? [live] : [])].flatMap(({ messages }) =>
		messages.flatMap(({ noteChange }) => noteChange ? [noteChange] : []));
}

export async function showSlashDiff(changes: NoteChange[], ui: SlashUi): Promise<boolean> {
	if (!changes.length) throw new Error(tr('这个聊天暂无已记录的笔记改动。', 'No note changes have been recorded for this chat.'));
	return ui.panel(tr('本次聊天的笔记改动', 'Note changes in this chat'), (host) => {
		const root = createRoot(host);
		root.render(<>{changes.map((change, index) => <details key={index} open={index === changes.length - 1}>
			<summary>{change.path}</summary>
			{'omitted' in change ? <p>{tr('改动过长，未保存完整差异。', 'This change was too large to record in full.')}</p>
				: <FileChanges before={change.before} after={change.after} />}
		</details>)}</>);
		return () => root.unmount();
	});
}

export function reviewChanges(changes: NoteChange[]): string {
	const parts = changes.flatMap((change) => 'omitted' in change ? []
		: [createTwoFilesPatch(change.path, change.path, change.before ?? '', change.after, undefined, undefined, { context: 3 })]);
	const material = parts.join('\n');
	if (material.length > 28_000 || parts.length < changes.length) {
		throw new Error(tr('改动太多，无法一次检查。请选择要检查的笔记。', 'These changes are too large for one review. Choose a note to review.'));
	}
	return material;
}
