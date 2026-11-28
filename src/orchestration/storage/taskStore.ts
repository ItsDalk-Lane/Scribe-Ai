import { isPromptCheckpoint } from '../context/promptContext';
import { Buffer } from 'node:buffer';
import { MAX_REVIEW_MATERIAL_BYTES } from '../../constants';
import type { ConversationEntry, ConversationSnapshot, MainConversationEntry, QueuedMessage, SavedRun, SavedSubagentEntry, TaskRequest } from '../../types';
import { SAVED_SHELL_JOB_LIMIT } from '../../tools/external/shellJobs';
import type { SavedShellJob } from '../../tools/external/shellJobs';
import { assistantMessageId } from '../../runtime/runState';
import { isThinkingLevel } from '../settings/thinking';
import { createSubagentRecordIndex } from './subagentRecords';
import { validNoteChange } from '../../tools/support/noteChange';
import { isCachedImagePath, isGeneratedMediaRef, isGeneratedVideoJobId } from './paths';
import { isChatTaskEvent } from './chatTasks';

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
	return typeof value === 'string';
}

function count(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function duration(value: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function modelMetrics(value: unknown): boolean {
	return record(value) && count(value.endedAt) && duration(value.modelMs)
		&& (value.firstDeltaMs === undefined || duration(value.firstDeltaMs))
		&& (value.decodeMs === undefined || duration(value.decodeMs))
		&& (value.contextWindow === undefined || count(value.contextWindow));
}

function call(value: unknown): boolean {
	return record(value) && text(value.id) && text(value.name);
}

function thinkingBlock(block: Record<string, unknown>): boolean {
	return block.type === 'thinking' && text(block.thinking) && (block.durationMs === undefined || count(block.durationMs));
}

function retryBlock(value: unknown): boolean {
	return record(value) && count(value.contentIndex)
		&& (value.type === 'text' ? text(value.text) : thinkingBlock(value));
}

function reportedUsage(value: unknown): boolean {
	return record(value) && ['prompt', 'input', 'cacheRead', 'cacheWrite', 'output', 'total', 'videoInput']
		.every((key) => value[key] === undefined || count(value[key]));
}
function estimatedUsage(value: unknown): boolean {
	return record(value) && ['prompt', 'output', 'total'].every((key) => value[key] === undefined || count(value[key]));
}

function rawAssistant(value: unknown): boolean {
	return record(value) && value.role === 'assistant' && text(value.api) && text(value.provider) && text(value.model)
		&& text(value.stopReason) && count(value.timestamp) && record(value.usage) && Array.isArray(value.content)
		&& value.content.every((block: unknown) => record(block) && (
			(block.type === 'text' && text(block.text))
			|| thinkingBlock(block)
			|| (block.type === 'toolCall' && call(block) && record(block.arguments))
		));
}

const roles = new Set<unknown>(['system', 'user', 'assistant', 'tool']);
const shellStatuses = new Set<unknown>(['success', 'failed', 'timed-out', 'stopped', 'start-failed']);
const approvalReviewStatuses = new Set<unknown>(['approved', 'denied', 'incomplete']);
const shellJobId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const shellJobContentLimit = 30_000;
export const SAVED_SHELL_JOBS_FILE_LIMIT = SAVED_SHELL_JOB_LIMIT * (shellJobContentLimit * 7 + 512) + 256;

export function isSavedShellJob(value: unknown): value is SavedShellJob {
	return record(value) && text(value.id) && shellJobId.test(value.id)
		&& (value.subagentId === undefined || identifier(value.subagentId))
		&& (value.name === 'Bash' || value.name === 'PowerShell') && shellStatuses.has(value.status)
		&& (value.unread === undefined || value.unread === true)
		&& text(value.content) && value.content.length <= shellJobContentLimit
		&& (value.command === undefined || (text(value.command) && value.command.length <= shellJobContentLimit))
		&& (value.startedAt === undefined || count(value.startedAt))
		&& (value.finishedAt === undefined || count(value.finishedAt))
		&& (value.exitCode === undefined || value.exitCode === null
			|| (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)));
}

export function parseSavedShellJobs(content: string, conversationId: string): SavedShellJob[] {
	try {
		const value: unknown = JSON.parse(content);
		if (!record(value) || value.conversationId !== conversationId || !Array.isArray(value.jobs)
			|| value.jobs.length > SAVED_SHELL_JOB_LIMIT || !value.jobs.every(isSavedShellJob)
			|| new Set(value.jobs.map(({ id }) => id)).size !== value.jobs.length) throw new Error('后台任务记录格式无效。');
		return value.jobs;
	} catch (cause) {
		throw Object.assign(new Error('无法读取已保存的后台任务。'), { cause });
	}
}
const terminalStates = new Set<unknown>(['done', 'file-changes-done', 'partial', 'failed', 'cancelled', 'limit', 'interrupted']);
const runStates = new Set<unknown>([...terminalStates, 'idle', 'running', 'awaiting-approval']);
const phases = new Set<unknown>(['starting', 'model', 'tool', 'approval', 'tool-result']);

function subagentActivity(value: unknown): boolean {
	return record(value) && identifier(value.id) && identifier(value.agentId) && identifier(value.agentName)
		&& (value.kind === 'result' || value.kind === 'instruction' || value.kind === 'question');
}

function validSkillMentions(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every((item: unknown) => record(item)
		&& text(item.id) && text(item.name) && (item.sourceLabel === undefined || text(item.sourceLabel)) && count(item.start) && count(item.end) && Number(item.end) > Number(item.start)));
}

function validSkillScope(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every(text));
}

function message(value: unknown): boolean {
	return record(value) && roles.has(value.role) && text(value.content) && validSkillMentions(value.skillMentions) && validSkillScope(value.skillScope)
		&& validSkillScope(value.skillNotePaths)
		&& (value.taskPrompt === undefined || (value.role === 'user' && record(value.taskPrompt)
			&& count(value.taskPrompt.instruction) && count(value.taskPrompt.references) && count(value.taskPrompt.quotes)
			&& Number(value.taskPrompt.instruction) + Number(value.taskPrompt.references) + Number(value.taskPrompt.quotes) <= value.content.length
			&& (value.taskPrompt.approvedPlan === undefined || (Array.isArray(value.taskPrompt.approvedPlan) && value.taskPrompt.approvedPlan.length === 2
				&& value.taskPrompt.approvedPlan.every(count) && Number(value.taskPrompt.approvedPlan[0]) < Number(value.taskPrompt.approvedPlan[1])
				&& Number(value.taskPrompt.approvedPlan[1]) < Number(value.taskPrompt.instruction)))
			&& (value.taskPrompt.assignment === undefined || value.taskPrompt.assignment === true)))
		&& (value.skillInputLength === undefined || (count(value.skillInputLength) && Number(value.skillInputLength) <= value.content.length))
		&& (value.subagentActivity === undefined || (value.local === true && (value.role === 'assistant' || value.role === 'user')
			&& subagentActivity(value.subagentActivity)))
		&& (value.local === undefined || ((value.role === 'assistant' || value.subagentActivity !== undefined) && value.local === true
			&& value.toolCalls === undefined && value.rawAssistant === undefined && value.thinkingBlocks === undefined
			&& value.metrics === undefined && value.usage === undefined && value.reportedUsage === undefined
			&& value.estimatedUsage === undefined && value.usageStatus === undefined
			&& value.incomplete === undefined && value.truncated === undefined))
		&& (value.deliveryAgents === undefined || (value.local === true && value.subagentActivity === undefined && deliveryAgentIds(value.deliveryAgents)))
		&& (value.id === undefined || (text(value.id) && (value.role === 'assistant'
			|| (value.role === 'user' && (value.id.startsWith('steer:') || value.subagentActivity !== undefined)))))
		&& (value.textIndex === undefined || (value.role === 'assistant' && count(value.textIndex)))
		&& (value.thinkingBlocks === undefined || (value.role === 'assistant' && Array.isArray(value.thinkingBlocks)
			&& value.thinkingBlocks.every((block: unknown) => record(block) && thinkingBlock(block) && count(block.contentIndex))))
		&& (value.role !== 'tool' || text(value.toolCallId))
		&& (value.toolName === undefined || text(value.toolName))
		&& (value.isError === undefined || typeof value.isError === 'boolean')
		&& (value.imageRefs === undefined || (Array.isArray(value.imageRefs) && value.imageRefs.every((ref: unknown) =>
			record(ref) && text(ref.path) && (value.role === 'tool' ? ref.kind === 'tool' && isCachedImagePath(ref.path)
				: value.role === 'user' && (ref.kind === 'file' || ref.kind === 'url'
					|| (ref.kind === 'pasted' && isCachedImagePath(ref.path))
					|| (ref.kind === 'vault-link' && (ref.sourcePath === undefined || text(ref.sourcePath))))))))
		&& (value.generatedMedia === undefined || (value.role === 'tool' && value.isError !== true && value.skipped === undefined
			&& Array.isArray(value.generatedMedia) && value.generatedMedia.every(isGeneratedMediaRef)))
		&& (value.generatedVideoJobId === undefined || (value.role === 'tool' && value.skipped === undefined
			&& isGeneratedVideoJobId(value.generatedVideoJobId)))
		&& (value.skipped === undefined || (value.role === 'tool' && value.skipped === true))
		&& (value.truncated === undefined || (value.role === 'assistant' && value.truncated === true))
		&& (value.metrics === undefined || (value.role === 'assistant' && modelMetrics(value.metrics)))
		&& (value.usage === undefined || (value.role === 'assistant' && record(value.usage)))
		&& (value.reportedUsage === undefined || (value.role === 'assistant' && reportedUsage(value.reportedUsage)))
		&& (value.estimatedUsage === undefined || (value.role === 'assistant' && estimatedUsage(value.estimatedUsage)))
		&& (value.usageStatus === undefined || (value.role === 'assistant' && (value.usageStatus === 'provisional' || value.usageStatus === 'final')))
		&& (value.toolDurationMs === undefined || (value.role === 'tool' && duration(value.toolDurationMs)))
		&& (value.shellStatus === undefined || (value.role === 'tool' && shellStatuses.has(value.shellStatus)))
		&& (value.approvalReview === undefined || (value.role === 'tool' && approvalReviewStatuses.has(value.approvalReview)))
		&& (value.noteChange === undefined || (value.role === 'tool' && value.isError === false && value.skipped === undefined
			&& (value.toolName === 'Write' || value.toolName === 'Edit') && validNoteChange(value.noteChange)))
		&& (value.incomplete === undefined || (value.role === 'assistant' && value.incomplete === true
			&& value.toolCalls === undefined && value.rawAssistant === undefined))
		&& (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(call)))
		&& (value.goalReportRequired === undefined || (value.role === 'assistant' && value.goalReportRequired === true && !value.local && !value.incomplete))
		&& (value.rawAssistant === undefined || (value.role === 'assistant' && rawAssistant(value.rawAssistant)));
}

function request(value: unknown): value is TaskRequest {
	return record(value) && text(value.conversationId) && text(value.instruction) && Array.isArray(value.refs)
		&& (value.imageSourcePath === undefined || text(value.imageSourcePath))
		&& (value.imageLinkEnd === undefined || (count(value.imageLinkEnd) && Number(value.imageLinkEnd) <= value.instruction.length))
		&& (value.intent === undefined || value.intent === 'plan' || value.intent === 'review')
		&& (value.approvedPlanTaskId === undefined || (value.intent === undefined && text(value.approvedPlanTaskId)
			&& value.approvedPlanTaskId.length > 0 && value.approvedPlanTaskId.length <= 128))
		&& (value.approvedPlanMode === undefined || (value.approvedPlanTaskId !== undefined
			&& (value.approvedPlanMode === 'continue' || value.approvedPlanMode === 'fresh')))
		&& (value.approvedPlanRevision === undefined || (value.approvedPlanTaskId !== undefined
			&& text(value.approvedPlanRevision) && /^[a-f0-9]{64}$/u.test(value.approvedPlanRevision)))
		&& (value.revisesPlanTaskId === undefined || (value.intent === 'plan' && text(value.revisesPlanTaskId)
			&& value.revisesPlanTaskId.length > 0 && value.revisesPlanTaskId.length <= 128))
		&& (value.target === undefined || (value.intent === undefined && record(value.target)
			&& (value.target.kind === 'mcp' || value.target.kind === 'agent')
			&& text(value.target.id) && Boolean(value.target.id.trim()) && text(value.target.label) && Boolean(value.target.label.trim())))
		&& (value.goalRound === undefined || (value.goalRound === true && value.intent === undefined))
		&& (value.goalContext === undefined || (value.goalRound === true && text(value.goalContext) && value.goalContext.length <= 128_000))
		&& (value.reviewMaterial === undefined || (value.intent === 'review' && text(value.reviewMaterial)
			&& Buffer.byteLength(value.reviewMaterial) <= MAX_REVIEW_MATERIAL_BYTES))
		&& validSkillMentions(value.skillMentions) && validSkillScope(value.skillScope) && validSkillScope(value.skillNotePaths) && validSkillScope(value.inheritedSkillIds)
		&& (value.inheritedSkills === undefined || (Array.isArray(value.inheritedSkills)
			&& value.inheritedSkills.every((skill: unknown) => record(skill) && text(skill.name) && text(skill.id))))
		&& value.refs.every((ref: unknown) => record(ref) && text(ref.path)
			&& (ref.kind === undefined || ref.kind === 'file' || ref.kind === 'folder')
			&& (ref.addedExternal === undefined || ref.addedExternal === true)
			&& (ref.pastedImage === undefined || (ref.pastedImage === true && isCachedImagePath(ref.path)))
			&& (ref.lines === undefined || (Array.isArray(ref.lines) && ref.lines.length === 2 && ref.lines.every(count))))
		&& (value.approvalSource === undefined || text(value.approvalSource))
		&& (value.subagentCallerTaskId === undefined || identifier(value.subagentCallerTaskId))
		&& (value.selection === undefined || validSelection(value.selection))
		&& (value.chatQuotes === undefined || (Array.isArray(value.chatQuotes) && value.chatQuotes.every(text)));
}

function validSelection(value: unknown): boolean {
	if (!record(value) || !text(value.path) || !text(value.title) || !text(value.text) || !value.text.trim()
		|| !Array.isArray(value.lines) || value.lines.length !== 2) return false;
	const [first, last] = value.lines as unknown[];
	return count(first) && count(last) && first > 0 && last >= first;
}

function step(value: unknown): boolean {
	return record(value) && phases.has(value.phase) && count(value.turn)
		&& (value.call === undefined || call(value.call));
}

function model(value: unknown): boolean {
	return record(value) && text(value.providerId) && text(value.model)
		&& (value.reasoning == null || isThinkingLevel(value.reasoning));
}

function queueDestination(value: unknown): boolean {
	return value === undefined || (record(value) && model(value) && text(value.baseUrl) && Boolean(value.baseUrl)
		&& text(value.api) && Boolean(value.api) && text(value.fingerprint) && /^[a-f0-9]{64}$/u.test(value.fingerprint));
}

export function isMainEntry(value: unknown): value is MainConversationEntry {
	if (!record(value)) return false;
	switch (value.type) {
		case 'queue-add':
			return record(value.message) && text(value.message.id) && value.message.id.length > 0
				&& queueDestination(value.message.destination)
				&& queueDestination(value.message.pdfDestination)
				&& request(value.message.request) && Boolean(value.message.request.instruction.trim());
		case 'queue-edit':
			return text(value.messageId) && text(value.instruction) && Boolean(value.instruction.trim()) && validSkillMentions(value.skillMentions);
		case 'queue-delete':
			return text(value.messageId);
	}
	const consumed = value.consumedQueueIds;
	if (consumed !== undefined && (!Array.isArray(consumed) || !consumed.every(text)
		|| (value.type !== 'start' && value.type !== 'messages'))) return false;
	if (value.type === 'start') {
		return record(value.task) && text(value.task.id) && request(value.task.request) && model(value.model);
	}
	if (!text(value.taskId)) return false;
	switch (value.type) {
		case 'messages':
			return Array.isArray(value.messages) && value.messages.every(message)
				&& (value.step === undefined || step(value.step));
		case 'step':
			return step(value.step);
		case 'plan-enter':
			return true;
		case 'history-summary':
			return record(value.summary) && text(value.summary.throughTaskId) && value.summary.throughTaskId.length > 0
				&& text(value.summary.text) && Buffer.byteLength(value.summary.text) <= 4_096;
		case 'prompt-context':
			return isPromptCheckpoint(value.checkpoint);
		case 'run-summary':
			return record(value.summary) && count(value.summary.throughMessage) && value.summary.throughMessage > 1
				&& text(value.summary.text) && Boolean(value.summary.text.trim()) && Buffer.byteLength(value.summary.text) <= 4_096;
		case 'video-item':
		case 'pdf-item':
			return record(value.item) && text(value.item.key) && /^[a-f0-9]{64}$/u.test(value.item.key)
				&& text(value.item.content) && Boolean(value.item.content.trim()) && Buffer.byteLength(value.item.content) <= 16_384;
		case 'video-analysis':
			return text(value.content) && Boolean(value.content.trim()) && Buffer.byteLength(value.content) <= 16_384
				&& (value.sources === undefined || (Array.isArray(value.sources) && value.sources.length > 0 && value.sources.length <= 2
					&& value.sources.every((item) => item === 'file' || item === 'link') && new Set(value.sources).size === value.sources.length));
		case 'context-compaction': {
			const item = value.compaction;
			return record(item) && (item.reason === 'budget' || item.reason === 'overflow')
				&& (item.summary === 'none' || item.summary === 'saved' || item.summary === 'reused' || item.summary === 'failed')
				&& count(item.droppedHistory) && count(item.droppedCurrent) && count(item.shortenedToolResults)
				&& (item.throughMessage === undefined || (count(item.throughMessage) && item.throughMessage > 1));
		}
		case 'auxiliary-usage':
			return record(value.usage) && (value.usage.kind === 'review' || value.usage.kind === 'goal-review' || value.usage.kind === 'summary'
				|| value.usage.kind === 'video' || value.usage.kind === 'pdf' || value.usage.kind === 'main-attempt')
				&& (value.usage.id === undefined || identifier(value.usage.id))
				&& (value.usage.usageStatus === undefined || value.usage.usageStatus === 'provisional' || value.usage.usageStatus === 'final')
				&& (value.usage.reportedUsage === undefined || reportedUsage(value.usage.reportedUsage))
				&& (value.usage.estimatedUsage === undefined || estimatedUsage(value.usage.estimatedUsage))
				&& (value.usage.cost === undefined || duration(value.usage.cost));
		case 'retry': {
			const retry = value.retry;
			return record(retry) && count(retry.beforeMessage) && record(retry.event)
				&& retry.event.type === 'model-retry' && text(retry.event.messageId) && typeof retry.event.waiting === 'boolean'
				&& (retry.event.reason === undefined || retry.event.reason === 'context')
				&& (retry.blocks === undefined || (Array.isArray(retry.blocks) && retry.blocks.every(retryBlock)))
				&& (retry.draft === undefined || (record(retry.draft) && message({ ...retry.draft, role: 'assistant' })));
		}
		case 'finish':
			return terminalStates.has(value.status) && count(value.turn)
				&& (value.finishedAt === undefined || count(value.finishedAt))
				&& (value.resumed === undefined || typeof value.resumed === 'boolean')
				&& (value.error === undefined || text(value.error)) && (value.partial === undefined || text(value.partial));
		default:
			return false;
	}
}

function identifier(value: unknown): value is string {
	return text(value) && value.length > 0;
}

function deliveryAgentIds(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0
		&& value.every((id: unknown) => text(id) && Boolean(id.trim()))
		&& new Set(value).size === value.length;
}

export function isSubagentReportEntry(value: unknown): value is Extract<ConversationEntry, { type: 'subagent-report' }> {
	return record(value) && value.type === 'subagent-report' && identifier(value.taskId) && record(value.report)
		&& text(value.report.content) && Boolean(value.report.content.trim())
		&& count(value.report.sentAt) && value.report.sentAt > 0;
}

export function isSubagentEntry(value: unknown): value is Extract<ConversationEntry, { type: 'subagent' }> {
	if (!record(value) || value.type !== 'subagent' || !identifier(value.agentId) || !record(value.record)) return false;
	const item = value.record;
	switch (item.kind) {
		case 'create': {
			const agent = item.agent;
			return record(agent) && agent.id === value.agentId && identifier(agent.rootTaskId)
				&& (agent.parentId === undefined || identifier(agent.parentId)) && text(agent.name) && text(agent.role) && model(agent.model)
				&& (agent.parentTaskId === undefined || identifier(agent.parentTaskId))
				&& (item.history === undefined || (Array.isArray(item.history) && item.history.every(message)))
				&& (item.instructions === undefined || text(item.instructions))
				&& (item.readOnly === undefined || typeof item.readOnly === 'boolean')
				&& (item.planning === undefined || (item.planning === true && item.readOnly === true && item.history === undefined))
				&& (item.allowProvider === undefined || typeof item.allowProvider === 'boolean')
				&& (item.modelOrigin === undefined || identifier(item.modelOrigin)) && queueDestination(item.reportDestination);
		}
		case 'run':
			return isMainEntry(item.entry) && !isQueueEntry(item.entry)
				&& (!('consumedQueueIds' in item.entry) || item.entry.consumedQueueIds === undefined)
				&& (item.entry.type !== 'messages' || !item.entry.messages.some(({ deliveryAgents }) => deliveryAgents !== undefined));
		case 'visibility':
			return typeof item.closed === 'boolean';
		case 'note': {
			const note = item.note;
			return record(note) && identifier(note.id) && identifier(note.from) && identifier(note.to) && text(note.text)
				&& (note.kind === 'message' || note.kind === 'result' || note.kind === 'question' || note.kind === 'answer')
				&& (note.status === undefined || runStates.has(note.status))
				&& (note.agentName === undefined || identifier(note.agentName))
				&& (note.questionId === undefined || identifier(note.questionId))
				&& (note.path === undefined || identifier(note.path))
				&& (note.review === undefined || (note.kind === 'result' && identifier(note.path) && record(note.review)
					&& note.review.status === 'pending' && note.review.reason === undefined))
				&& (note.inline === undefined || typeof note.inline === 'boolean');
		}
		case 'review':
			return identifier(item.noteId)
				&& (item.disposition === 'use' || item.disposition === 'defer' || item.disposition === 'revise' || item.disposition === 'blocked')
				&& (item.reason === undefined || text(item.reason)) && (item.errorKey === undefined || identifier(item.errorKey));
		case 'delivered':
			return Array.isArray(item.ids) && item.ids.length > 0 && item.ids.every(identifier);
		default:
			return false;
	}
}

export function parseConversationEntry(line: string, number: number): ConversationEntry {
	try {
		const value: unknown = JSON.parse(line);
		if (!isMainEntry(value) && !isSubagentEntry(value) && !isSubagentReportEntry(value) && !isChatTaskEvent(value)) throw new Error('对话记录格式无效。');
		return value;
	} catch (error) {
		throw Object.assign(new ConversationRecordError(`无法读取对话记录的第 ${number} 行。`), { cause: error });
	}
}

export class ConversationRecordError extends Error {}

export function isQueueEntry(item: ConversationEntry): item is Extract<ConversationEntry, { type: 'queue-add' | 'queue-edit' | 'queue-delete' }> {
	return item.type === 'queue-add' || item.type === 'queue-edit' || item.type === 'queue-delete';
}

export function replayQueueEntry(id: string, queue: Map<string, QueuedMessage>, item: ConversationEntry): void {
	if (item.type === 'start' && item.task.request.conversationId !== id) throw new ConversationRecordError('任务不属于此对话。');
	switch (item.type) {
		case 'queue-add':
			if (item.message.request.conversationId !== id || queue.has(item.message.id)) {
				throw new ConversationRecordError('排队消息不属于此对话或编号重复。');
			}
			queue.set(item.message.id, item.message);
			break;
		case 'queue-edit': {
			const previous = queue.get(item.messageId);
			if (!previous) throw new ConversationRecordError('找不到要编辑的排队消息。');
			queue.set(item.messageId, { ...previous, request: { ...previous.request, instruction: item.instruction, ...(item.skillMentions ? { skillMentions: item.skillMentions } : previous.request.skillMentions ? { skillMentions: [] } : {}) } });
			break;
		}
		case 'queue-delete':
			if (!queue.delete(item.messageId)) throw new ConversationRecordError('找不到要删除的排队消息。');
			break;
		case 'start':
		case 'messages':
			for (const messageId of item.consumedQueueIds ?? []) {
				if (!queue.delete(messageId)) throw new ConversationRecordError('找不到已发送的排队消息。');
			}
	}
}

/** 恢复历史和停留位置。未写入结束状态的任务显示为中断。 */
export async function replayConversation(id: string, entries: AsyncIterable<ConversationEntry> | Iterable<ConversationEntry>): Promise<ConversationSnapshot> {
	const runs = new Map<string, SavedRun>();
	const queue = new Map<string, QueuedMessage>();
	const finished = new Set<string>();
	const subagents: SavedSubagentEntry[] = [];
	const index = createSubagentRecordIndex(id);
	for await (const item of entries) {
		index.observe(item);
		if (item.type === 'subagent') {
			subagents.push({ agentId: item.agentId, record: item.record });
			continue;
		}
		replayQueueEntry(id, queue, item);
		if (isQueueEntry(item) || item.type === 'chat-tasks') continue;
		if (item.type === 'start') {
			const { task, model } = item;
			if (runs.has(task.id)) throw new Error('对话中的任务编号无效或重复。');
			runs.set(task.id, {
				request: task.request,
				model,
				state: { taskId: task.id, turn: 0, messages: [], pendingCalls: [], status: 'interrupted',
					...(count(task.createdAt) && task.createdAt > 0 ? { createdAt: task.createdAt } : {}) },
				step: { phase: 'starting', turn: 0 },
			});
			continue;
		}
		const run = runs.get(item.taskId);
		if (!run) throw new Error('对话中的任务记录顺序无效。');
		if (item.type === 'subagent-report') {
			run.subagentReport = item.report;
			continue;
		}
		// 用户可以在任务结束后手动整理聊天，摘要用量仍归入这段记录。
		if (finished.has(item.taskId) && !(item.type === 'auxiliary-usage' && item.usage.kind === 'summary')) {
			throw new Error('对话中的任务记录顺序无效。');
		}
		const { state } = run;
		switch (item.type) {
			case 'messages': {
				const last = state.messages.at(-1);
				const currentReplyId = assistantMessageId(state);
				// 流式思考可能先于插话写入。同轮的回复仍需排在插话之后。
				const draft = last?.incomplete && item.messages.some(({ role, id }) => role === 'user' && id?.startsWith('steer:'))
					&& (last.id === currentReplyId || last.id?.startsWith(`${currentReplyId}:retry:`))
					? state.messages.pop() : undefined;
				for (const message of item.messages) {
					const previous = state.messages.at(-1);
					if (message.id && previous?.id === message.id && previous.incomplete) state.messages[state.messages.length - 1] = message;
					else state.messages.push(message);
					if (message.role === 'assistant' && !message.incomplete && !message.local) state.pendingCalls = message.toolCalls ?? [];
					if (message.role === 'tool') {
						state.pendingCalls = state.pendingCalls.filter((tool) => tool.id !== message.toolCallId);
					}
				}
				if (draft) state.messages.push(draft);
				if (item.step) {
					run.step = item.step;
					state.turn = item.step.turn;
				}
				break;
			}
			case 'step':
				run.step = item.step;
				state.turn = item.step.turn;
				break;
			case 'plan-enter':
				if (run.request.intent || run.request.approvedPlanTaskId || run.request.goalRound || run.request.target) {
					throw new ConversationRecordError('无效的计划模式切换。');
				}
				run.request = { ...run.request, intent: 'plan' };
				break;
			case 'history-summary': {
				const taskIds = [...runs.keys()];
				const through = taskIds.indexOf(item.summary.throughTaskId);
				if (through === -1 || through >= taskIds.indexOf(item.taskId)) throw new ConversationRecordError('聊天摘要超出原对话范围。');
				run.historySummary = item.summary;
				break;
			}
			case 'prompt-context':
				if (item.checkpoint.after > state.messages.length) throw new ConversationRecordError('上下文检查点超出已保存的消息范围。');
				(run.promptCheckpoints ??= []).push(item.checkpoint);
				break;
			case 'run-summary':
				if (item.summary.throughMessage > state.messages.length || item.summary.throughMessage <= (run.runSummary?.throughMessage ?? 1)) {
					throw new ConversationRecordError('任务交接摘要超出已保存的进度范围。');
				}
				run.runSummary = item.summary;
				break;
			case 'context-compaction':
				if (item.compaction.throughMessage !== undefined && item.compaction.throughMessage !== run.runSummary?.throughMessage) {
					throw new ConversationRecordError('压缩记录与任务交接摘要的范围不符。');
				}
				state.contextCompaction = item.compaction;
				break;
			case 'video-item':
				(run.videoItems ??= []).push(item.item);
				break;
			case 'pdf-item':
				(run.pdfItems ??= []).push(item.item);
				break;
			case 'video-analysis':
				run.videoAnalysis = item.content;
				run.videoAnalysisSources = item.sources;
				break;
			case 'auxiliary-usage':
				(state.auxiliaryUsage ??= []).push(item.usage);
				break;
			case 'retry': {
				const retry = { ...item.retry };
				const checkpoint = state.messages.at(-1);
				if (checkpoint?.incomplete && checkpoint.id === retry.event.messageId && !checkpoint.content) {
					state.messages.pop();
					if (!retry.blocks && checkpoint.thinkingBlocks?.length) {
						// 旧记录把已完成的思考和重试前的正文分开保存。
						const draft = retry.draft ?? { content: '' };
						retry.draft = { ...draft, thinkingBlocks: [...checkpoint.thinkingBlocks, ...(draft.thinkingBlocks ?? [])] };
					}
				}
				(run.retries ??= []).push({ ...retry, beforeMessage: state.messages.length });
				break;
			}
			case 'finish': {
				state.status = item.status;
				state.turn = item.turn;
				state.error = item.error;
				if (item.finishedAt !== undefined) state.finishedAt = item.finishedAt;
				if (item.resumed) state.resumed = true;
				run.partial = item.partial;
				run.finalized = true;
				finished.add(item.taskId);
				const plan = run.request.approvedPlanTaskId ? runs.get(run.request.approvedPlanTaskId) : undefined;
				if (plan?.request.intent === 'plan' && (item.status === 'done' || item.status === 'file-changes-done')) plan.planArchived = true;
				break;
			}
		}
	}
	return { id, runs: [...runs.values()], ...(queue.size ? { queue: [...queue.values()] } : {}),
		...(subagents.length ? { subagents } : {}) };
}
