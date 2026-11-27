import { approvedPlanContent } from '../../interaction/chatPlan';
import { reportGoalToolName } from '../../interaction/chatGoal';
import { Buffer } from 'node:buffer';
import { planToolNames } from '../../tools/planTools';
import { memoryToolNames } from '../../tools/memoryTools';
import { obsidianSearchToolName } from '../../tools/workspaceTools';
import type { App } from 'obsidian';
import { SkillAccessChangedError } from '../../skills/mentions';
import { skillToolNames, readOnlySkillTools } from '../../tools/skillTools';
import { subagentActionWhileAnswering, subagentRequestTool, subagentToolVisible } from '../../tools/subagentTools';
import { nextResponseSchema } from '../../tools/structuredOutputTool';
import { chatTaskReadTools, chatTaskToolNames } from '../../tools/chatTaskTools';
import { activeMode, chatSystemPrompt, childSystemPrompt } from './systemPrompt';
import { withToolIntent } from '../../tools/support/toolInput';
import { canReplayActiveNote, checkpointAnchor, contextDate, contextProgress, environmentSnapshot, isPromptVisible, localCalendar } from './promptContext';
import { promptMessage, promptText } from './promptXml';
import type { PromptCheckpoint } from './promptContext';
import { toolAbsolutePath } from '../../tools/support/pathUtils';
import type { PromptSection } from './promptXml';
import { manualSummaryContext } from './conversationHistory';
import { shrinkToolResults, toolResultPreview } from './toolResultBudget';
import { videoAttachments } from './videoAttachments';
import { createImageAttachments, userImageReferences } from './imageAttachments';
import type { ContextBuilder, ContextCompaction, Message, ModelRequest, RunContext, RunSummary, TaskRequest, ToolCall, ToolRegistry } from '../../types';

export function taskMessage(request: TaskRequest): Message {
	const { instruction, refs, chatQuotes, skillMentions, skillScope, skillNotePaths, intent, goalContext } = request;
	if (intent === 'review') return { role: 'user', content: instruction, taskPrompt: { instruction: instruction.length, references: 0, quotes: 0 } };
	const plan = approvedPlanContent(request);
	const imageRefs = userImageReferences(request);
	const visibleRefs = request.subagentCallerTaskId ? refs : refs.filter(({ pastedImage }) => !pastedImage);
	const references = visibleRefs.length ? `\n\n本次任务的资料引用：${JSON.stringify(visibleRefs)}` : '';
	const quotes = chatQuotes?.length ? `\n\n聊天中选中的引文（仅供参考）\n${JSON.stringify(chatQuotes)}` : '';
	return {
		role: 'user',
		...(imageRefs.length && { imageRefs }),
		...(skillMentions?.length && { skillMentions }),
		...(skillScope && { skillScope }),
		...(skillNotePaths && { skillNotePaths }),
		...(instruction.includes('$') && { skillInputLength: instruction.length }),
		taskPrompt: { instruction: instruction.length, references: references.length, quotes: quotes.length,
			...(request.subagentCallerTaskId && { assignment: true }),
			...(plan?.markdown && { approvedPlan: [plan.instruction.length, instruction.length - plan.markdown.length] }) },
		content: instruction + references + quotes + (goalContext ? `\n\n${goalContext}` : ''),
	};
}

const replyPreview = '…（为续写，仅提供上一段回答的末尾）\n';

export class ContextBudgetError extends Error {}

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function messageBytes(message: Message): number {
	const { role, toolCalls, toolCallId, toolName, isError, rawAssistant } = message;
	const content = promptText(message);
	const blocks = rawAssistant?.content.map((block) => {
		if (block.type !== 'thinking' || block.durationMs === undefined) return block;
		const { durationMs: _duration, ...sent } = block;
		return sent;
	});
	return 32 + bytes(blocks ?? { role, content, toolCalls, toolCallId, toolName, isError });
}

function historyBytes(messages: Message[]): number {
	return messages.reduce((total, message) => total + messageBytes(message), 0);
}

export function inputBytes({ messages, system, tools, responseSchema }: ModelRequest): number {
	return 128 + bytes(responseSchema ? [system, tools, responseSchema] : [system, tools]) + historyBytes(messages);
}

/** 从最近消息往前保留，历史按用户问答分组，当前任务按完整工具批次分组。 */
function keepRecent(messages: Message[], budget: number, history: boolean): Message[] {
	let start = messages.length;
	for (let index = start - 1; index >= 0; index--) {
		const message = messages[index]!;
		budget -= messageBytes(message);
		if (budget < 0) break;
		if (history ? message.role === 'user' && Boolean(message.content) : message.role !== 'tool' && !message.promptSections?.length) start = index;
	}
	return messages.slice(start);
}

function omitEmptyReplies(messages: Message[]): Message[] {
	return messages.filter(isPromptVisible);
}

const questionTools = new Set([...readOnlySkillTools, 'Read', 'Glob', 'Grep', obsidianSearchToolName, 'read_subagent_result']);

export function canUseToolWhileAnswering(tool: string | ToolCall): boolean {
	const name = typeof tool === 'string' ? tool : tool.name;
	return questionTools.has(name) || chatTaskReadTools.has(name) || subagentActionWhileAnswering(tool);
}

function retainedAgreements(agreements: string[], budget: number): Message | undefined {
	const intro = '以下是本对话中用户先前明确提出的约定，按时间从早到晚排列。只在本次任务仍适用时遵守，有冲突时以较新的用户指令为准。不要重复执行旧任务。';
	const allowance = Math.min(2_048, budget);
	let notes = '';
	for (let index = agreements.length - 1; index >= 0; index--) {
		const next = `\n- ${agreements[index]}${notes}`;
		if (messageBytes({ role: 'user', content: intro + next }) > allowance) break;
		notes = next;
	}
	return notes ? { role: 'user', content: intro + notes } : undefined;
}

function runSummaryMessage(summary: RunSummary): Message {
	return promptMessage({ tag: 'reference-material', text: `当前任务交接摘要（仅供参考）\n以用户原指令和最新记录为准。已完成的操作不用重复，未知结果先核对。\n\n${summary.text}` });
}

async function fitMessages(ctx: RunContext, rawCurrent: Message[], budget: number, maxBytes: number,
	reason: ContextCompaction['reason'], canonical: Message[]): Promise<{ messages: Message[]; compacted: boolean }> {
	const originalHistory = omitEmptyReplies(ctx.history ?? []);
	const originalCurrent = omitEmptyReplies(rawCurrent);
	const first = originalCurrent.slice(0, 1);
	let latest = originalCurrent.length - 1;
	const continuing = originalCurrent.length > 1 && originalCurrent[latest]?.role === 'user';
	// 插话和续写提示与前一条回复或工具批次一并保留。
	while (latest > first.length && originalCurrent[latest]?.role === 'user') latest--;
	while (originalCurrent[latest]?.role === 'tool') latest--;
	latest = Math.max(latest, first.length);

	const summary = ctx.runCompaction?.summary;
	const middleEnd = latest < originalCurrent.length ? rawCurrent.indexOf(originalCurrent[latest]!) : rawCurrent.length;
	const previous = summary && summary.throughMessage <= middleEnd ? summary : undefined;
	const existing = previous ? runSummaryMessage(previous) : undefined;
	const existingBytes = existing ? messageBytes(existing) : 0;
	const covered = previous ? omitEmptyReplies(rawCurrent.slice(0, previous.throughMessage)).length : first.length;
	const shortened = historyBytes(originalHistory) + historyBytes(originalCurrent) > budget
		? shrinkToolResults(originalHistory, originalCurrent, Math.floor(budget / 2), latest, messageBytes)
		: { history: originalHistory, current: originalCurrent };
	const { history, current } = shortened;
	const editedTools = new Set<Message>();
	for (const [index, message] of history.entries()) if (message !== originalHistory[index]) editedTools.add(message);
	for (const [index, message] of current.entries()) if (message !== originalCurrent[index]) editedTools.add(message);

	let tail = current.slice(latest);
	const tailBudget = budget - historyBytes(first);
	if (historyBytes(tail) > tailBudget) {
		const reply = tail[0];
		const partial = continuing && reply?.role === 'assistant' && !reply.rawAssistant && !reply.toolCalls?.length ? reply : undefined;
		const previews = tail.map((message) => message.role === 'tool' && message.content ? toolResultPreview(message) : undefined);
		const limitMessage = (message: Message, index: number, keep: number): Message => {
			if (message === partial && message.content.length > keep) {
				const end = keep ? message.content.slice(-keep).replace(/^[\uDC00-\uDFFF]/u, '') : '';
				return { ...message, content: replyPreview + end };
			}
			const content = previews[index]?.render(keep);
			return content !== undefined && content !== message.content ? { ...message, content } : message;
		};
		const spare = tailBudget - historyBytes(tail.map((message, index) => limitMessage(message, index, 0)));
		const expandable = previews.filter((preview) => preview && preview.length > 0).length + Number(Boolean(partial?.content));
		if (spare < 0 || !expandable) throw new ContextBudgetError('本次指令、写作规则或工具请求过长，请缩小范围后重试。');
		// JSON 转义后一个字符最多占六字节，保留成对的工具请求和结果。
		const keep = Math.floor(spare / expandable / 6);
		tail = tail.map((message, index) => {
			const result = limitMessage(message, index, keep);
			if (result !== message && result.role === 'tool') editedTools.add(result);
			return result;
		});
	}

	const spare = tailBudget - historyBytes(tail);
	let runNote = existingBytes <= spare ? existing : undefined;
	let throughMessage = runNote ? previous?.throughMessage : undefined;
	let middle = current.slice(runNote ? covered : first.length, latest);
	let runStatus: ContextCompaction['summary'] = runNote ? 'reused' : 'none';
	const available = spare - (runNote ? existingBytes : 0);
	const agreements = ctx.agreements ?? [];
	const beforeAgreements = keepRecent(middle, available, false);
	const historyBeforeAgreements = available - historyBytes(beforeAgreements);
	const reservedAgreement = agreements.length && historyBytes(history) > historyBeforeAgreements
		? retainedAgreements(agreements, available) : undefined;
	const agreementBytes = reservedAgreement ? messageBytes(reservedAgreement) : 0;
	const summaryRoom = Math.min(4_600, Math.floor(budget / 4), Math.floor((spare - agreementBytes) / 2));
	if (ctx.runCompaction && summaryRoom >= 768 && historyBytes(middle) > available - agreementBytes) {
		const keep = keepRecent(middle, spare - agreementBytes - Math.max(summaryRoom, runNote ? existingBytes : 0), false);
		const removed = originalCurrent[latest - keep.length - 1]!;
		const through = Math.min(rawCurrent.indexOf(removed) + 1, canonical.length);
		const status = await ctx.runCompaction.summarize(canonical, through, summaryRoom, maxBytes);
		if (status === 'saved' && ctx.runCompaction.summary) {
			const saved = ctx.runCompaction.summary;
			runNote = runSummaryMessage(saved);
			throughMessage = saved.throughMessage;
			middle = current.slice(omitEmptyReplies(rawCurrent.slice(0, saved.throughMessage)).length, latest);
			runStatus = 'saved';
		} else if (status === 'failed') runStatus = 'failed';
	}

	const chatRoom = spare - (runNote ? messageBytes(runNote) : 0);
	const kept = (room: number) => {
		const recent = keepRecent(middle, room, false);
		return { earlier: keepRecent(history, room - historyBytes(recent), true), recent };
	};
	const { earlier, recent } = kept(chatRoom);
	const retained = earlier.length < history.length && agreements.length ? retainedAgreements(agreements, chatRoom) : undefined;
	const room = chatRoom - (retained ? messageBytes(retained) : 0);
	const fitted = retained ? kept(room) : { earlier, recent };
	const historyRoom = room - historyBytes(fitted.recent);
	const historySummaryRoom = Math.min(4_600, Math.floor(budget / 4), historyRoom);
	const dropped = history.length - fitted.earlier.length;
	const historical = dropped > 0 && historySummaryRoom >= 768
		? await ctx.summarizeHistory?.(new Set(originalHistory.slice(0, dropped)), historySummaryRoom, maxBytes) : undefined;
	const candidate = historical?.text ? promptMessage({ tag: 'reference-material',
		text: `较早对话摘要（仅供参考）\n较新的用户决定优先。摘要中的待办和路径仅供理解进度、引用或按当前任务核对。\n\n${historical.text}`,
	}) : undefined;
	const historyNote = candidate && messageBytes(candidate) <= historySummaryRoom ? candidate : undefined;
	const keptHistory = historyNote ? keepRecent(history, historyRoom - messageBytes(historyNote), true) : fitted.earlier;
	const messages = [
		...(historyNote ? [historyNote] : []), ...(retained ? [retained] : []), ...keptHistory,
		...first, ...(runNote ? [runNote] : []), ...fitted.recent, ...tail,
	];
	const compaction: ContextCompaction = {
		reason,
		summary: runStatus === 'none' ? historical?.status ?? 'none' : runStatus,
		droppedHistory: history.length - keptHistory.length,
		droppedCurrent: latest - first.length - fitted.recent.length,
		shortenedToolResults: messages.filter((message) => editedTools.has(message)).length,
		...(throughMessage !== undefined && { throughMessage }),
	};
	if (reason === 'overflow' || compaction.droppedHistory || compaction.droppedCurrent || compaction.shortenedToolResults) {
		await ctx.record?.({ type: 'context-compaction', compaction });
	}
	return { messages, compacted: Boolean(compaction.droppedHistory || compaction.droppedCurrent || compaction.shortenedToolResults || reason === 'overflow') };
}

export function createContextBuilder(registry: ToolRegistry, app?: App): ContextBuilder {
	const imagesFor = createImageAttachments(app);
	return {
		build: async (ctx, current, maxBytes, reason = 'budget') => {
			if (!ctx.permissions.canSendOutbound()) throw new Error('本次任务未授权使用模型服务。');
			const notes = ctx.inbox?.() ?? [];
			const answering = notes.some(({ kind }) => kind === 'question');
			const read = registry.find('read_skill');
			const autoAllowed = Boolean(read && ctx.permissions.canCallTool(read));
			const skills = await ctx.skillRun?.project(current, autoAllowed);
			const responseSchema = nextResponseSchema(current);
			const { intent, reviewMaterial } = ctx.task.request;
			const review = intent === 'review';
			const writingRules = ctx.writingRules && (!ctx.writingRulesCurrent || await ctx.writingRulesCurrent())
				? ctx.writingRules : undefined;
			const describe = (tool: Parameters<RunContext['permissions']['canCallTool']>[0]) =>
				(ctx.canDescribeTool ? ctx.canDescribeTool(tool) : ctx.permissions.canCallTool(tool));
			if (ctx.task.request.target?.kind === 'mcp' && !ctx.mcpRun) throw new Error('当前聊天无法调用 MCP 工具。');
			await ctx.mcpRun?.ready((tool) => ctx.permissions.canCallTool(tool), ctx.signal);
			const visibleTools = (responseSchema ? [] : registry.all())
				.filter((tool) => !skillToolNames.has(tool.name) || ctx.skillRun?.canUse(tool.name))
				.filter((tool) => !chatTaskToolNames.has(tool.name) || ctx.chatTasks)
				.filter((tool) => !planToolNames.has(tool.name) || ctx.plan)
				.filter(({ name }) => name !== reportGoalToolName || ctx.goalReport)
				.filter((tool) => !memoryToolNames.has(tool.name) || ctx.memory?.enabled())
				.filter((tool) => describe(tool) && subagentToolVisible(tool.name, ctx.subagents))
				.filter(({ name }) => !answering || canUseToolWhileAnswering(name));
			const tools = visibleTools.filter((tool) => !tool.mcp)
				.map((tool) => subagentRequestTool(tool, ctx.subagents, answering))
				.map(withToolIntent);
			const mcpTools = ctx.mcpRun?.project(visibleTools, maxBytes / 4, !responseSchema && !answering && ctx.mcpRun.canProject(describe)) ?? [];
			const mcpTarget = ctx.mcpRun?.targetName();
			const journal = ctx.promptContext;
			const after = Math.min(current.length, ctx.promptMessageCount ?? current.length);
			const now = new Date();
			const modeAtAssembly = ctx.permissions.executionMode;
			const mcpChanges = ctx.mcpRun?.changes() ?? [];
			const planAvailable = tools.some(({ name }) => name === 'SubmitPlan');
			const mode = activeMode(intent, modeAtAssembly, ctx.sideChat, ctx.task.request.goalRound,
				{ plan: planAvailable, goalReport: tools.some(({ name }) => name === 'ReportGoal') })
				+ (intent === 'plan' && planAvailable && ctx.plan?.path ? ` 计划文件：${ctx.plan.path}。` : '');
			const detached = !journal || review || ctx.sideChat;
			const prior = journal?.past ?? [];
			const saved = journal?.committed ?? [];
			const recorded = [...prior, ...saved];
			const latestRecorded = new Map(recorded.map((checkpoint) => [checkpoint.key, checkpoint]));
			const session = recorded.find(({ key }) => key === 'session');
			const initial = !session;
			const mainVault = !detached && !ctx.subagentId && !ctx.isolatedAgent && ctx.task.request.target?.kind !== 'agent';
			const openedNote = mainVault ? app?.workspace?.getActiveFile?.()?.path : undefined;
			const activeNote = openedNote && await canReplayActiveNote(ctx, openedNote) ? openedNote : undefined;
			const activePaths = new Set<string>();
			if (activeNote) activePaths.add(activeNote);
			if (mainVault) for (const path of new Set(recorded.flatMap(({ section: { scopePath } }) => scopePath ? [scopePath] : []))) {
				if (path !== activeNote && await canReplayActiveNote(ctx, path)) activePaths.add(path);
			}
			const projects = [
				{ key: 'rules', tag: 'project-rules', text: writingRules },
				{ key: 'skills', tag: 'available-skills', text: skills?.guidance },
				{ key: 'agents', tag: 'available-subagents', text: ctx.subagentCatalog },
				{ key: 'mcp', tag: 'mcp-context', text: ctx.mcpRun?.instructions?.().map(({ server, instructions }) =>
					`MCP 服务器 ${server} 的参考说明：\n${instructions}`).join('\n\n') },
			] as const;
			const values: PromptCheckpoint[] = [];
			for (const { key, tag, text } of projects) {
				if (text) values.push({ key, after: initial ? 0 : after, section: { tag, text } });
				else if (recorded.some((item) => item.key === key)) values.push({ key, after, section: {
					tag: 'system-reminder', text: `先前交付的${key === 'rules' ? '项目规则' : key === 'skills' ? '技能目录' : key === 'agents' ? '子助手目录' : 'MCP 说明'}已撤销。`,
				} });
			}
			if (initial) values.push({ key: 'session', after: 0, section: { tag: 'session-snapshot', text: environmentSnapshot(now, mainVault ? app : undefined, ctx) } });
			if (session?.section.tag === 'session-context' && !latestRecorded.has('session-supplement')) {
				values.push({ key: 'session-supplement', after, section: { tag: 'system-reminder', text: environmentSnapshot(now, mainVault ? app : undefined, ctx, true) } });
			}
			const lastDate = latestRecorded.get('date') ?? session;
			if (lastDate && !lastDate.section.text.includes(`日期 ${contextDate(now)}`)) {
				values.push({ key: 'date', after, section: { tag: 'system-reminder', text: `当前日期 ${localCalendar(now)}。` } });
			}
			if (activeNote || recorded.some(({ key }) => key === 'active-note')) values.push({ key: 'active-note', after: initial ? 0 : after,
				section: { tag: 'system-reminder', ...(activeNote && { scopePath: activeNote }), text: activeNote
					? `当前打开的笔记 ${JSON.stringify(activeNote)}。` : '当前没有获准交付的打开笔记。' },
			});
			if (ctx.subagentInstructions) values.push({ key: 'subagent-instructions', after: initial ? 0 : after,
				section: { tag: 'subagent-assignment', text: ctx.subagentInstructions } });
			if (ctx.subagentPrompt || recorded.some(({ key }) => key === 'subagent-state')) values.push({ key: 'subagent-state', after,
				section: { tag: 'subagent-state', text: ctx.subagentPrompt ?? '当前任务没有额外协作状态。' } });
			const peers = notes.filter(({ from }) => from !== 'user');
			for (const peer of peers) values.push({ key: `collaboration:${peer.id}`, after,
				section: { tag: 'collaboration-update', text: '协作资料\n' + JSON.stringify([peer]) } });
			values.push({ key: 'mode', after, section: { tag: 'system-reminder', text: mode } });
			if (mcpTarget) values.push({ key: 'mcp-target', after, section: { tag: 'system-reminder',
				text: `用户本次点选的 MCP 服务器是 ${JSON.stringify(mcpTarget)}。MCP 操作限于这台服务器可用的工具。` } });
			if (mcpChanges.length) values.push({ key: 'mcp-activity', after, section: { tag: 'system-reminder', text: mcpChanges.join('\n') } });
			const changedDirectories: Array<{ path: string; text: string }> = [];
			if (journal && ctx.directoryRules?.trusted()) {
				const checked = new Map<string, string>();
				for (const path of [...journal.directories, ...journal.known]) {
					if (!ctx.permissions.canRead(toolAbsolutePath(ctx.cwd, path))) continue;
					for (const rule of await ctx.directoryRules.forPath(path)) checked.set(rule.path, rule.text);
				}
				for (const [path, text] of checked) {
					changedDirectories.push({ path, text });
					values.push({ key: `directory:${path}`, after, section: { tag: 'project-rules', text: `${path}\n${text}` } });
				}
			}
			const allowCheckpoint = ({ key, section }: PromptCheckpoint): boolean => {
				if (section.scopePath && !activePaths.has(section.scopePath)) return false;
				if (key === 'date' && session?.section.tag === 'session-context' && section.text.startsWith('当前日期 ')
					&& session.section.text.includes(section.text.slice(2))) return false;
				if (key === 'subagent-instructions') return ctx.subagentInstructions === section.text;
				if (key.startsWith('directory:')) return changedDirectories.some(({ path, text }) =>
					key === `directory:${path}` && section.text === `${path}\n${text}`);
				if (key === 'mcp-target') return Boolean(mcpTarget) && section.text.includes(JSON.stringify(mcpTarget));
				const description = projects.find((item) => item.key === key);
				if (!description || section.tag === 'system-reminder') return true;
				if (!description.text) return false;
				if (key === 'rules' || description.text === section.text) return true;
				if (key !== 'skills' || section.tag !== 'available-skills') return false;
				const currentLines = new Set(description.text.split('\n'));
				return section.text.split('\n').every((line) => currentLines.has(line));
			};
			const updates = detached ? [] : journal.updates(values);
			const baseline = [...prior, ...saved, ...updates].filter((item) => item.after === 0 && allowCheckpoint(item));
			const openedAtStart = baseline.find(({ key }) => key === 'active-note')?.section.text;
			const start: PromptSection[] = detached
				? projects.flatMap(({ tag, text }) => !review && text ? [{ tag, text }] : [])
				: baseline.flatMap(({ key, section }) => key === 'active-note' ? [] : [{ ...section,
					tag: key === 'session' ? 'session-snapshot' : section.tag,
					text: key === 'session' ? [section.text.replace(/需要当前 Git 状态时按任务权限查询。$/u, ''), openedAtStart].filter(Boolean).join('\n') : section.text,
				}]);
			const memoryVersion = ctx.memory?.version();
			const memoryIndex = !review && !ctx.sideChat ? await ctx.memory?.index() : undefined;
			if (memoryIndex) start.push({ tag: 'memory-index', text: memoryIndex });
			const prefix = start.length ? [promptMessage(...start)] : [];
			const currentUpdates = [...saved, ...updates].filter((item) => item.after > 0 && allowCheckpoint(item));
			const tail: PromptSection[] = [];
			if (review || ctx.sideChat || (!journal && Boolean(intent || ctx.permissions.executionMode || ctx.task.request.goalRound))) {
				tail.push({ tag: 'system-reminder', text: mode });
			}
			if (detached) tail.push(...values.filter(({ key }) => key === 'mcp-target' || key === 'mcp-activity'
				|| key === 'subagent-state' || key === 'subagent-instructions' || key.startsWith('collaboration:')).map(({ section }) => section));
			if (ctx.promptResuming) tail.push({ tag: 'system-reminder', text: '已从本地记录恢复。' + mode });
			if (answering) tail.push({ tag: 'system-reminder',
				text: '先回答子 Agent 等待中的提问。可读取回答所需资料，用 contact_subagent 的 answer 操作提交，然后继续原任务。' });
			if (review && reviewMaterial) tail.push({ tag: 'selected-material', text: '本次选中的笔记改动记录\n' + reviewMaterial });
			const matches = memoryIndex ? await ctx.memory?.search(ctx.task.request.instruction) : undefined;
			const additions: PromptSection[] = [];
			if (matches?.length) additions.push({ tag: 'reference-material', text: '本轮匹配的记忆索引\n' + JSON.stringify(matches) });
			const videoAnalysis = await ctx.videoAnalysis?.read();
			if (videoAnalysis) additions.push({ tag: 'reference-material', text: '视频模型的带时间戳解析\n' + videoAnalysis });
			const plan = !current[0]?.taskPrompt?.approvedPlan && approvedPlanContent(ctx.task.request);
			if (plan) additions.push({ tag: 'approved-plan', text: plan.markdown });
			const skilled = skills?.messages ?? current;
			const supplied = await ctx.memory?.project(skilled) ?? skilled;
			const outgoing = supplied.map((message, index) => {
				const explicit = skills?.instructionsByMessage?.get(index === 0 ? '' : message.id ?? '-');
				const sections: PromptSection[] = [...message.promptSections ?? []];
				if (explicit) sections.push({ tag: 'skill-instructions', text: explicit });
				if (index === 0 && message.role === 'user') sections.push(...additions);
				if (message.role === 'tool' && message.toolName === 'search_mcp_tools' && !ctx.mcpRun?.canReplay(message.content, (tool) => ctx.permissions.canCallTool(tool))) {
					return { ...message, content: 'MCP 工具定义已变化或不再获准，请重新搜索。' };
				}
				if (!sections.length) return message;
				const content = index === 0 && plan && message.content.startsWith(ctx.task.request.instruction)
					? plan.instruction + message.content.slice(ctx.task.request.instruction.length) : message.content;
				return { ...message, content, promptSections: sections };
			});
			const directed = notes.filter(({ from }) => from === 'user').map(({ text }): Message => ({ role: 'user', content: text,
				taskPrompt: { instruction: text.length, references: 0, quotes: 0 } }));
			const replayHistory = ctx.history?.flatMap((message): Message[] => {
				if (message.role === 'system') return [promptMessage({ tag: 'reference-material', text: message.content })];
				if (message.promptSections?.length && !message.content) {
					const sections = message.promptSections.filter((section) => {
						if (section.scopePath && !activePaths.has(section.scopePath)) return false;
						const checkpoint = prior.find((item) => item.section === section);
						return !checkpoint || allowCheckpoint(checkpoint);
					});
					return sections.length ? [promptMessage(...sections)] : [];
				}
				if (message.role === 'tool' && (['MemoryRead', 'MemorySearch', 'HistorySearch'].includes(message.toolName ?? '')
					|| message.toolName === 'search_mcp_tools' && !ctx.mcpRun?.canReplay(message.content, (tool) => ctx.permissions.canCallTool(tool)))) {
					return [{ ...message, content: '历史资料需要按当前授权重新查询。' }];
				}
				return [message];
			});
			const request: ModelRequest = {
				...ctx.model,
				system: ctx.isolatedAgent || ctx.subagentId ? childSystemPrompt : chatSystemPrompt,
				messages: [],
				tools: [...tools, ...mcpTools],
				...(responseSchema && { responseSchema }),
				signal: ctx.signal,
				sessionId: review ? ctx.task.id : ctx.subagentId ?? ctx.task.request.conversationId,
				async beforeSend() {
					if (ctx.task.request.intent !== intent || ctx.permissions.executionMode !== modeAtAssembly) {
						throw new SkillAccessChangedError('发送前执行模式已变化。');
					}
					if (autoAllowed && read && !ctx.permissions.canCallTool(read)) throw new SkillAccessChangedError('发送前技能工具已停用。');
					await skills?.beforeSend?.();
					ctx.mcpRun?.beforeSend();
					if (writingRules && ctx.writingRulesCurrent && !await ctx.writingRulesCurrent()) {
						throw new SkillAccessChangedError('发送前写作规则已变化。');
					}
					if (memoryVersion !== ctx.memory?.version()) throw new SkillAccessChangedError('发送前记忆设置或内容已变化。');
					for (const { path, text } of changedDirectories) {
						if (!(await ctx.directoryRules?.forPath(path) ?? []).some((rule) => rule.path === path && rule.text === text)) {
							throw new SkillAccessChangedError('发送前目录规则或信任已变化。');
						}
					}
					for (const path of activePaths) if (!await canReplayActiveNote(ctx, path)) {
						throw new SkillAccessChangedError('发送前打开笔记的授权或位置已变化。');
					}
					await journal?.record(updates);
					for (const { path, text } of changedDirectories) journal?.deliveredRules.set(path, text);
				},
			};
			const tailNote = tail.length ? promptMessage(...tail) : undefined;
			const checkpoints = new Map<number, PromptSection[]>();
			for (const { after: position, section } of currentUpdates) {
				const anchor = checkpointAnchor(outgoing, position);
				const sections = checkpoints.get(anchor) ?? [];
				sections.push(section);
				checkpoints.set(anchor, sections);
			}
			const checkpointMessages = new Map([...checkpoints].map(([position, sections]) => [outgoing[position - 1], promptMessage(...sections)]));
			const recovery: PromptSection | undefined = journal && !review
				? { tag: 'system-reminder', text: [mode, contextProgress(ctx)].filter(Boolean).join('\n') }
				: undefined;
			const modeInProtectedMessages = currentUpdates.some((item) => item.key === 'mode'
				&& (item.after === 1 || item.after === outgoing.length));
			const recoveryBytes = recovery && !modeInProtectedMessages ? messageBytes(promptMessage(recovery)) : 0;
			const available = maxBytes - inputBytes(request) - historyBytes(prefix) - historyBytes([...checkpointMessages.values()])
				- (tailNote ? messageBytes(tailNote) : 0) - recoveryBytes;
			if (reviewMaterial && available < messageBytes(outgoing[0] ?? promptMessage())) throw new ContextBudgetError('选中的笔记改动超出模型容量，请减少检查内容或更换模型。');
			if (skills?.instructionsByMessage?.size && available < messageBytes(outgoing[0] ?? promptMessage())) throw new ContextBudgetError('选中的技能说明超出模型容量，请减少同时选用的技能或更换模型。');
			const fitted = await fitMessages({ ...ctx, history: replayHistory }, [...outgoing, ...directed], available, maxBytes, reason, current);
			// A checkpoint after a tool result goes after the entire result batch, without changing the recorded tool message.
			const placed = fitted.messages.flatMap((message, index, messages) => {
				const checkpoint = checkpointMessages.get(message) ?? (message.toolCallId
					? [...checkpointMessages].find(([source]) => source?.toolCallId === message.toolCallId)?.[1] : undefined);
				if (!checkpoint || messages[index + 1]?.role === 'tool') return [message];
				return [message, checkpoint];
			});
			request.messages = [...prefix, ...placed, ...(tailNote ? [tailNote] : [])];
			if (fitted.compacted && !review) {
				const latestStates = new Map([...recorded, ...values].filter(({ after }) => after > 0).map((item) => [item.key, item]));
				const restore = [
					...(recovery ? [recovery] : []),
					...['date', 'active-note', 'subagent-state'].flatMap((state) => {
						const latest = latestStates.get(state);
						return latest && allowCheckpoint(latest) ? [latest.section] : [];
					}),
					...projects.flatMap(({ tag, text }) => text ? [{ tag, text }] : []),
					...changedDirectories.map(({ path, text }) => ({ tag: 'project-rules' as const, text: `${path}\n${text}` })),
					...supplied.filter((message) => message.toolCallId && !placed.some(({ toolCallId }) => toolCallId === message.toolCallId))
						.flatMap((message) => message.promptSections?.filter(({ tag }) => tag === 'skill-instructions') ?? []),
				];
				const included = new Set(request.messages.flatMap(({ promptSections }) => promptSections?.map(({ text }) => text) ?? []));
				let room = maxBytes - inputBytes(request);
				for (const section of restore) {
					if (included.has(section.text)) continue;
					const message = promptMessage(section);
					const size = messageBytes(message);
					if (size <= room) { request.messages.push(message); room -= size; included.add(section.text); }
				}
			}
			const first = outgoing[0];
			const userIndex = first?.role === 'user' ? request.messages.indexOf(first) : -1;
			if (userIndex >= 0 && first && ctx.manualSummary) {
				const withSummary: Message = { ...first, promptSections: [...first.promptSections ?? [],
					{ tag: 'reference-material', text: manualSummaryContext(ctx.manualSummary) }] };
				if (inputBytes(request) + messageBytes(withSummary) - messageBytes(first) <= maxBytes) request.messages[userIndex] = withSummary;
			}
			const video = videoAttachments(ctx, userIndex);
			if (video) request.video = video;
			const images = imagesFor(ctx, request.messages, outgoing);
			if (images) request.images = images;
			return request;
		},
	};
}
