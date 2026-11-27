import { Buffer } from 'node:buffer';
import { platform } from 'node:os';
import type { App } from 'obsidian';
import { normalizeVaultRelativePath, resolveToolPath, toolAbsolutePath } from '../../tools/support/pathUtils';
import type { Message, ModelRequest, ReportedUsage, RunContext, SavedRun, ToolCall } from '../../types';
import { runProgressFilename, SCRIBE_DATA_DIRECTORY } from '../storage/paths';
import { promptMessage } from './promptXml';
import type { PromptSection } from './promptXml';

export interface PromptCheckpoint {
	after: number;
	key: string;
	section: PromptSection;
}

const projectTags = new Set(['project-context', 'project-rules', 'available-skills', 'available-subagents', 'mcp-context']);
const sessionTags = new Set(['session-context', 'session-snapshot', 'memory-index']);
const journalTags = new Set([...projectTags, ...sessionTags, 'system-reminder', 'subagent-state', 'subagent-assignment', 'collaboration-update']);
const maxBytes = 64 * 1024;

export function isPromptCheckpoint(value: unknown): value is PromptCheckpoint {
	if (!value || typeof value !== 'object') return false;
	const { after, key, section } = value as PromptCheckpoint;
	return Number.isSafeInteger(after) && after >= 0 && typeof key === 'string' && key.length <= 240
		&& typeof section?.text === 'string' && Buffer.byteLength(section.text) <= maxBytes && journalTags.has(section.tag)
		&& (section.scopePath === undefined || (key === 'active-note' && typeof section.scopePath === 'string'
			&& section.scopePath.length <= 4_096 && relativeVaultPath(section.scopePath)));
}

export function isPromptVisible(message: Message): boolean {
	return !message.subagentActivity && (message.role !== 'assistant'
		|| Boolean(message.content || message.rawAssistant || message.toolCalls?.length));
}

/** Match persisted raw indices to messages still sent to the model after filtering UI rows. */
export function checkpointAnchor(messages: Message[], after: number): number {
	let anchor = Math.min(after, messages.length);
	while (anchor > 0 && !isPromptVisible(messages[anchor - 1]!)) anchor--;
	if (anchor === 0) return anchor;
	for (let index = anchor; index < messages.length; index++) {
		const next = messages[index]!;
		if (!isPromptVisible(next)) continue;
		if (next.role !== 'tool') break;
		anchor = index + 1;
	}
	return anchor;
}

export function insertPromptCheckpoints(messages: Message[], checkpoints: PromptCheckpoint[], include: (item: PromptCheckpoint) => boolean): Message[] {
	if (!checkpoints.length) return messages;
	const byPosition = new Map<number, PromptSection[]>();
	for (const item of checkpoints) if (include(item)) {
		const anchor = checkpointAnchor(messages, item.after);
		const sections = byPosition.get(anchor) ?? [];
		sections.push(item.section);
		byPosition.set(anchor, sections);
	}
	const at = (index: number) => {
		const sections = byPosition.get(index);
		return sections?.length ? [promptMessage(...sections)] : [];
	};
	return [...at(0), ...messages.flatMap((message, index) => [message, ...at(index + 1)])];
}

export function contextDate(now: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function createRunPromptContext(
	history: SavedRun[], restored: SavedRun | undefined,
	save: (checkpoint: PromptCheckpoint) => Promise<void>,
) {
	const past = history.flatMap(({ promptCheckpoints }) => promptCheckpoints ?? []);
	const committed = [...restored?.promptCheckpoints ?? []];
	const latest = new Map([...past, ...committed].map((checkpoint) => [checkpoint.key, checkpoint.section.text]));
	const directories = new Set<string>();
	const deliveredRules = new Map<string, string>();
	const modelInput: { last?: { request: ModelRequest; address: string; fingerprint?: string } } = {};
	const directoryKey = 'directory:';
	const known = new Set([...past, ...committed].filter(({ key }) => key.startsWith(directoryKey)).map(({ key }) => key.slice(directoryKey.length)));

	return {
		committed,
		past,
		directories,
		deliveredRules,
		modelInput,
		known,
		updates(values: PromptCheckpoint[]) {
			return values.filter((item) => isPromptCheckpoint(item) && latest.get(item.key) !== item.section.text);
		},
		async record(items: PromptCheckpoint[]) {
			for (const item of items) {
				if (latest.get(item.key) === item.section.text) continue;
				await save(item);
				committed.push(item);
				latest.set(item.key, item.section.text);
			}
		},
	};
}

export type RunPromptContext = ReturnType<typeof createRunPromptContext>;

function localWeekdayAndZone(now: Date): string {
	const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now);
	const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
	return `${weekday}，本机时区 ${timeZone}`;
}

export function localCalendar(now: Date): string {
	return `${contextDate(now)}（${localWeekdayAndZone(now)}）`;
}

function relativeVaultPath(path: string): boolean {
	return !path.includes('\\') && normalizeVaultRelativePath(path) === path;
}

export async function canReplayActiveNote(ctx: RunContext, path: string): Promise<boolean> {
	if (!relativeVaultPath(path) || !/\.md$/iu.test(path)) return false;
	const target = await resolveToolPath(ctx, path, 'read').catch(() => undefined);
	ctx.signal.throwIfAborted();
	return target?.vaultPath === path && target.stat?.isFile() === true;
}

interface CorePluginSettings {
	enabled?: boolean;
	instance?: { options?: Record<string, unknown> };
}

export function environmentSnapshot(now: Date, app: App | undefined, ctx: RunContext, supplement = false): string {
	const snapshot = supplement ? [`当前为${localWeekdayAndZone(now)}，每周从星期一开始。`]
		: [`操作系统 ${platform()}，工作目录为库根（.）。`, `日期 ${localCalendar(now)}，每周从星期一开始。`];
	if (!app) return snapshot.join('\n');
	const vault = app.vault as App['vault'] & { getConfig?(key: string): unknown };
	const internal = (app as App & { internalPlugins?: { getPluginById?(id: string): CorePluginSettings | undefined } }).internalPlugins;
	const enabledOptions = (id: string) => {
		const plugin = internal?.getPluginById?.(id);
		return plugin?.enabled ? plugin.instance?.options : undefined;
	};
	const folder = (value: unknown): string | undefined => {
		if (typeof value !== 'string') return;
		if (value === '' || value === '/') return '.（库根）';
		if (relativeVaultPath(value) && ctx.permissions.canRead(toolAbsolutePath(ctx.cwd, value))) return JSON.stringify(value);
		return undefined;
	};
	const daily = enabledOptions('daily-notes');
	const dailyFolder = folder(daily?.folder);
	if (dailyFolder) snapshot.push(`日记目录 ${dailyFolder}。`);
	if (daily) snapshot.push(`日记命名格式 ${JSON.stringify(typeof daily.format === 'string' && daily.format || 'YYYY-MM-DD')}。`);
	const templateOptions = enabledOptions('templates');
	const templates = folder(templateOptions?.folder ?? templateOptions?.templates_folder);
	if (templates) snapshot.push(`模板目录 ${templates}。`);
	const attachment = vault?.getConfig?.('attachmentFolderPath');
	const attachmentFolder = attachment === './' || attachment === '.' ? '当前笔记所在目录'
		: typeof attachment === 'string' && attachment.startsWith('./') && relativeVaultPath(attachment.slice(2))
			? `${JSON.stringify(attachment)}（相对于当前笔记）` : folder(attachment);
	if (attachmentFolder) snapshot.push(`附件目录 ${attachmentFolder}。`);
	const linkFormat = vault?.getConfig?.('newLinkFormat');
	const useMarkdownLinks = vault?.getConfig?.('useMarkdownLinks');
	const linkStyle = linkFormat === 'relative' ? '相对路径' : linkFormat === 'absolute' ? '库根相对路径' : linkFormat === 'shortest' ? '最短路径' : '';
	const linkSyntax = useMarkdownLinks === true ? 'Markdown 链接' : useMarkdownLinks === false ? '维基链接' : '';
	if (linkSyntax || linkStyle) snapshot.push(`新建笔记链接默认使用${[linkSyntax, linkStyle].filter(Boolean).join('、')}。`);
	return snapshot.join('\n');
}

export function contextProgress(ctx: RunContext): string {
	return [
		ctx.chatTasks && '继续复杂任务前用 TaskList 核对当前清单与认领状态。',
		ctx.task.request.approvedPlanTaskId && '当前任务已有用户批准的执行计划，以本任务开头的批准内容为准。',
		ctx.readFiles.size && '已有读取记录；需要作出修改或精确引用时，用工具核对当前文件。',
		!ctx.subagentId && ctx.runCompaction?.summary && `当前任务的交接记录已保存到 ${SCRIBE_DATA_DIRECTORY}/conversations/${runProgressFilename(ctx.task.request.conversationId, ctx.task.id)}，本次交接摘要载有相关进度。`,
	].filter(Boolean).join('\n');
}

export async function directoryWriteGuard(ctx: RunContext, call: ToolCall): Promise<string | undefined> {
	if (!ctx.promptContext || !ctx.directoryRules?.trusted()) return;
	const key = call.name === 'NotebookEdit' ? 'notebook_path'
		: call.name === 'Edit' || call.name === 'Write' ? 'file_path' : undefined;
	if (!key) return;
	const input = (call.input as Record<string, unknown> | null)?.[key];
	if (typeof input !== 'string') return;
	const target = await resolveToolPath(ctx, input, 'write', { allowMissing: true }).catch(() => undefined);
	ctx.signal.throwIfAborted();
	if (!target?.vaultPath || !ctx.permissions.canRead(target.absolutePath)) return;
	ctx.promptContext.directories.add(target.vaultPath);
	const rules = await ctx.directoryRules.forPath(target.vaultPath);
	if (rules.some(({ path: rule, text }) => ctx.promptContext?.deliveredRules.get(rule) !== text)) {
		return '尚未交付此目录的项目规则。本次写入未执行，收到规则后按规则重新发起。';
	}
	return undefined;
}

export function contextUsage(request: ModelRequest, usage?: ReportedUsage) {
	const estimate = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);
	const totals = { system: estimate(request.system ?? ''), tools: estimate(JSON.stringify(request.tools)), project: 0, session: 0, dialog: 0 };
	for (const message of request.messages) {
		totals.dialog += estimate(message.content);
		for (const { tag, text } of message.promptSections ?? []) {
			const key = projectTags.has(tag) ? 'project' : sessionTags.has(tag) ? 'session' : 'dialog';
			totals[key] += estimate(text);
		}
	}
	return { ...totals, ...(usage?.cacheRead !== undefined && { cacheRead: usage.cacheRead }),
		...(usage?.cacheWrite !== undefined && { cacheWrite: usage.cacheWrite }) };
}
