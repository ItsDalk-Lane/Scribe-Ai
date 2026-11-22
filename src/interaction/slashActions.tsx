import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { Notice } from 'obsidian';
import type { App, FileSystemAdapter } from 'obsidian';
import { createRoot } from 'react-dom/client';
import type ScribeAiPlugin from '../main';
import { writingRulePath } from '../orchestration/context/writingRules';
import { isWithinPath } from '../tools/support/pathUtils';
import type { ConversationMetrics } from './chatMetrics';
import ChatMarkdown from './components/ChatMarkdown';
import FileChanges from './components/FileChanges';
import { ScribeAiSettingTab } from './SettingsTab';
import { copyableMarkdownParts } from './slashCopy';
import type { SlashUi } from './slashUi';
import { tr } from './skills/dialog';
import { uiText } from './uiText';
import { renderWritingRulesSettings } from './WritingRulesSettings';
import type { NoteChange, RunState, SavedRun } from '../types';

export async function showSlashSummary(app: App, ui: SlashUi, title: string, summary: string): Promise<boolean> {
	return ui.panel(title, (host) => {
		const root = createRoot(host);
		root.render(<ChatMarkdown app={app} content={summary} />);
		return () => root.unmount();
	});
}

export async function openSlashSettings(plugin: ScribeAiPlugin, ui: SlashUi, writingRules = false): Promise<boolean> {
	const text = uiText();
	return ui.panel(writingRules ? text.writingRules : plugin.manifest.name, (host) => {
		if (writingRules) {
			renderWritingRulesSettings(plugin.app, host, text, true);
			return;
		}
		const tab = new ScribeAiSettingTab(plugin.app, plugin);
		tab.renderInto(host);
		return () => tab.hide();
	});
}

export async function showSlashWarnings(plugin: ScribeAiPlugin, ui: SlashUi): Promise<boolean> {
	const rows = plugin.services.communication.transport.logs().filter(({ error, phase }) => error || phase === 'error').slice(-20).reverse();
	return ui.show(uiText().diagnostics, rows.length ? rows.map(({ at, error, status }) =>
		[new Date(at).toLocaleTimeString(), status, error].filter(Boolean).join(' · ')) : [uiText().noDiagnostics]);
}

export async function showSlashUsage(metrics: ConversationMetrics, ui: SlashUi): Promise<boolean> {
	const usage = metrics.usage;
	const lines = usage ? [
		tr(`模型请求 ${usage.count} 次`, `${usage.count} model requests`),
		...([
			[tr('输入', 'Input'), usage.input], [tr('输出', 'Output'), usage.output], [tr('总计', 'Total'), usage.total],
			[tr('缓存读取', 'Cache read'), usage.cacheRead], [tr('缓存写入', 'Cache write'), usage.cacheWrite],
		] as const).flatMap(([label, value]) => value === undefined ? [] : [`${label} · ${value.toLocaleString()}`]),
	] : [tr('暂无已记录的用量。', 'No usage has been recorded yet.')];
	return ui.show(tr('聊天用量', 'Chat usage'), lines);
}

export function writableNotePath(path: string, configDir: string): string | undefined {
	const normalized = writingRulePath(path);
	if (!normalized || path.includes('\\') || Array.from(path).some((value) => value.charCodeAt(0) < 32) || path.split('/').includes('..')
		|| normalized === configDir || normalized.startsWith(`${configDir}/`)) return;
	return normalized.endsWith('.md') ? normalized : `${normalized}.md`;
}

export function transcriptMarkdown(runs: readonly SavedRun[]): string {
	return runs.flatMap(({ request, state }) => [
		`## ${tr('你', 'You')}\n\n${request.instruction}`,
		...state.messages.flatMap(({ role, content, incomplete, subagentActivity }, index) => {
			if (!content.trim() || incomplete || subagentActivity) return [];
			if (role === 'assistant') return [`## ${tr('助手', 'Assistant')}\n\n${cleanGoalMarker(content)}`];
			return role === 'user' && index > 0 ? [`## ${tr('你', 'You')}\n\n${content}`] : [];
		}),
	]).join('\n\n');
}

function cleanGoalMarker(content: string) {
	return content.replace(/<!-- scribe-goal-complete:[^\r\n]*? -->/gu, '').trimEnd();
}

export async function copySlash(runs: readonly SavedRun[], live: RunState | null | undefined, ui: SlashUi): Promise<boolean> {
	const latest = [...runs.map(({ state }) => state), ...(live ? [live] : [])].reverse()
		.flatMap(({ messages }) => [...messages].reverse())
		.find(({ role, content, incomplete, subagentActivity, toolCalls }) =>
			role === 'assistant' && content.trim() && !incomplete && !subagentActivity && !toolCalls?.length);
	if (!latest) throw new Error(tr('暂无可复制的回答。', 'There is no response to copy.'));
	const body = cleanGoalMarker(latest.content);
	const { snippets, quotes } = copyableMarkdownParts(body);
	const items = [
		{ label: tr('完整回答', 'Full response'), body },
		...snippets.map((body, index) => ({ label: tr(`代码块 ${index + 1}`, `Code block ${index + 1}`), body })),
		...quotes.map((body, index) => ({ label: tr(`引用 ${index + 1}`, `Quote ${index + 1}`), body })),
	];
	const target = items.length === 1 ? items[0] : await ui.choose(tr('复制回答', 'Copy response'), items, ({ label }) => label);
	if (!target) return false;
	await navigator.clipboard.writeText(target.body);
	new Notice(uiText().chatMessageCopied);
	return true;
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
