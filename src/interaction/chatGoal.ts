import { TOOL_NOT_APPROVED } from '../types';
import type { Message, NoteRef, RunState, SkillMention } from '../types';
import { isSkillMentionAt } from '../skills/mentions';
import { safeResourcePath } from '../skills/library/vaultAdapter';
import { isCachedImagePath } from '../orchestration/storage/paths';

export const DEFAULT_GOAL_ROUNDS = 5;
export const MAX_GOAL_ROUNDS = 50;
export const MAX_GOAL_LENGTH = 8_000;
export const MAX_GOAL_CRITERIA = 20;
export const MAX_GOAL_PLAN_LENGTH = 16_000;

const maxEvidenceLength = 600;
const maxNotePaths = 100;
const reportStart = '<!-- scribe-goal-report: ';
const reportEnd = ' -->';

export type GoalPause = 'manual' | 'plan' | 'closed' | 'limit' | 'failed' | 'blocked';

export interface GoalCheck {
	criterion: string;
	evidence: string;
	notePaths?: string[];
}

export interface GoalProgress {
	checks: GoalCheck[];
	remaining: string[];
	blocked?: string;
}

export interface ChatGoal {
	objective: string;
	status: 'active' | 'paused' | 'complete';
	maxRounds: number;
	usedRounds: number;
	totalRounds: number;
	workedMs?: number;
	reason?: GoalPause;
	evidence?: string;
	criteria?: string[];
	refs?: NoteRef[];
	imageSourcePath?: string;
	chatQuotes?: string[];
	skillMentions?: SkillMention[];
	skillScope?: string[];
	skillNotePaths?: string[];
	plan?: string;
	progress?: GoalProgress;
}

export interface GoalWorkClock {
	workedMs: number;
	startedAt?: number;
}

export function setGoalWorkClock(clock: GoalWorkClock, active: boolean, now: number): GoalWorkClock {
	if (active) return clock.startedAt === undefined ? { ...clock, startedAt: now } : clock;
	return clock.startedAt === undefined ? clock : { workedMs: clock.workedMs + Math.max(0, Math.round(now - clock.startedAt)) };
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length <= max && Boolean(value.trim()) && !value.includes('\0');
}

function textList(value: unknown, maxItems: number, maxLength: number): value is string[] {
	return Array.isArray(value) && value.length <= maxItems && value.every((item: unknown) => text(item, maxLength));
}

function count(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function vaultPath(value: unknown): value is string {
	return text(value, 4_096) && !/^[A-Za-z]:|[\\\r\n]/u.test(value)
		&& value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function notePath(value: unknown): value is string {
	return vaultPath(value) && value.toLowerCase().endsWith('.md');
}

function notePaths(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= maxNotePaths && value.every(notePath);
}

export function validGoalRef(ref: unknown): ref is NoteRef {
	return record(ref) && vaultPath(ref.path)
		&& (ref.kind === undefined || ref.kind === 'file' || ref.kind === 'folder') && ref.addedExternal === undefined
		&& (ref.pastedImage === undefined || (ref.pastedImage === true && isCachedImagePath(ref.path)))
		&& (ref.lines === undefined || (Array.isArray(ref.lines) && ref.lines.length === 2
			&& count(ref.lines[0]) && count(ref.lines[1]) && ref.lines[0] >= 1 && ref.lines[0] <= ref.lines[1]));
}

export function validGoalCriteria(value: unknown): value is string[] {
	return textList(value, MAX_GOAL_CRITERIA, MAX_GOAL_LENGTH) && value.length > 0
		&& value.reduce((total, criterion) => total + criterion.length, 0) <= MAX_GOAL_LENGTH
		&& new Set(value).size === value.length;
}

function savedProgress(value: unknown, criteria: string[]): value is GoalProgress {
	return record(value) && Array.isArray(value.checks) && value.checks.length <= criteria.length
		&& value.checks.every((check: unknown) => record(check) && typeof check.criterion === 'string'
			&& criteria.includes(check.criterion) && text(check.evidence, maxEvidenceLength)
			&& (check.notePaths === undefined || notePaths(check.notePaths)))
		&& textList(value.remaining, MAX_GOAL_CRITERIA * 2, MAX_GOAL_LENGTH)
		&& (value.blocked === undefined || text(value.blocked, maxEvidenceLength));
}

export function validGoalRounds(value: unknown): value is number {
	return count(value) && value > 0 && value <= MAX_GOAL_ROUNDS;
}

function goalSkillMentions(value: unknown, objective: string): value is SkillMention[] {
	if (!Array.isArray(value) || value.length > objective.length / 2) return false;
	const starts = new Set<number>();
	return value.every((item: unknown) => {
		if (!record(item) || !text(item.id, 4_096) || !text(item.name, MAX_GOAL_LENGTH)
			|| !count(item.start) || !count(item.end) || starts.has(item.start)
			|| (item.sourceLabel !== undefined && !text(item.sourceLabel, 4_096))
			|| !isSkillMentionAt(objective, { id: item.id, name: item.name, start: item.start, end: item.end })) return false;
		starts.add(item.start);
		return true;
	});
}

export function parseChatGoal(value: unknown): ChatGoal | undefined {
	if (!record(value)) return;
	const { objective, maxRounds, usedRounds, totalRounds, workedMs, status, reason, evidence, criteria,
		refs, imageSourcePath, chatQuotes, skillMentions, skillScope, skillNotePaths, plan, progress } = value;
	if (!text(objective, MAX_GOAL_LENGTH) || !validGoalRounds(maxRounds) || !count(totalRounds) || !count(usedRounds)
		|| (workedMs !== undefined && !count(workedMs))
		|| (status !== 'active' && status !== 'paused' && status !== 'complete')
		|| (criteria !== undefined && !validGoalCriteria(criteria))
		|| (refs !== undefined && (!Array.isArray(refs) || !refs.every(validGoalRef)))
		|| (imageSourcePath !== undefined && !vaultPath(imageSourcePath))
		|| (chatQuotes !== undefined && !textList(chatQuotes, 100, MAX_GOAL_PLAN_LENGTH))
		|| (skillMentions !== undefined && !goalSkillMentions(skillMentions, objective))
		|| (skillScope !== undefined && (!Array.isArray(skillScope)
			|| !skillScope.every((folder: unknown): folder is string => text(folder, 4_096) && safeResourcePath(folder))))
		|| (skillNotePaths !== undefined && (!Array.isArray(skillNotePaths)
			|| !skillNotePaths.every((path: unknown): path is string => text(path, 4_096) && safeResourcePath(path.replace(/\/$/u, '')))))
		|| (plan !== undefined && !text(plan, MAX_GOAL_PLAN_LENGTH))
		|| (progress !== undefined && !savedProgress(progress, criteria ?? [objective]))) return;
	return {
		objective, maxRounds, usedRounds, totalRounds, status,
		...(workedMs !== undefined && { workedMs }),
		...(reason === 'manual' || reason === 'plan' || reason === 'closed' || reason === 'limit' || reason === 'failed' || reason === 'blocked' ? { reason } : {}),
		...(typeof evidence === 'string' && { evidence: evidence.slice(0, maxEvidenceLength) }),
		...(criteria && { criteria }), ...(refs && { refs }), ...(chatQuotes && { chatQuotes }),
		...(imageSourcePath && { imageSourcePath }),
		...(skillMentions && { skillMentions }), ...(skillScope && { skillScope }), ...(skillNotePaths && { skillNotePaths }),
		...(plan && { plan }), ...(progress && { progress }),
	};
}

export function restoreChatGoal(value: unknown): ChatGoal | undefined {
	const saved = parseChatGoal(value);
	return saved?.status === 'active' ? { ...saved, status: 'paused', reason: 'closed' } : saved;
}

export function goalRoundInstruction(goal: ChatGoal): string {
	const criteria = (goal.criteria ?? [goal.objective]).map((criterion, index) => `${index + 1}. ${criterion}`);
	const progress = goal.progress;
	return [
		['验收条件（报告按编号对应）', ...criteria].join('\n'),
		goal.plan && ['已确认的计划（执行参考，以当前目标与验收条件为准）', goal.plan].join('\n'),
		progress?.checks.length && ['上轮已核对（如结果有变，重新检查）',
			...progress.checks.map(({ criterion, evidence }) => `- ${criterion}：${evidence}`)].join('\n'),
		progress?.remaining.length && ['上轮未完成', ...progress.remaining.map((item) => `- ${item}`)].join('\n'),
		progress?.blocked && `上次遇阻：${progress.blocked}`,
	].filter(Boolean).join('\n\n');
}

export function stripGoalReport(content: string): string {
	return content.replace(/^<!-- scribe-goal-report: [^\r\n]* -->[ \t]*(?:\r?\n|$)/gmu, '')
		.replace(/<!-- scribe-goal-(?:complete:[^\r\n]*?|blocked) -->/gu, '').trimEnd();
}

function readReport(line: string | undefined, criteria: string[]): GoalProgress | undefined {
	if (!line?.startsWith(reportStart) || !line.endsWith(reportEnd) || line.length > 125_000) return;
	let value: unknown;
	try { value = JSON.parse(line.slice(reportStart.length, -reportEnd.length)); } catch { return; }
	if (!record(value) || !Array.isArray(value.checks) || value.checks.length > criteria.length
		|| !textList(value.remaining, MAX_GOAL_CRITERIA, maxEvidenceLength)
		|| (value.blocked !== undefined && !text(value.blocked, maxEvidenceLength))) return;
	const checks: GoalCheck[] = [];
	for (const check of value.checks as unknown[]) {
		if (!record(check) || !count(check.criterion) || !text(check.evidence, maxEvidenceLength)
			|| (check.notePaths !== undefined && !notePaths(check.notePaths))) return;
		const criterion = criteria[check.criterion - 1];
		if (!criterion || checks.some((saved) => saved.criterion === criterion)) return;
		checks.push({ criterion, evidence: check.evidence.trim(), ...(check.notePaths && { notePaths: check.notePaths }) });
	}
	return { checks, remaining: value.remaining.map((item) => item.trim()), ...(value.blocked && { blocked: value.blocked.trim() }) };
}

function successfulNoteReceipts(messages: Message[]) {
	const read = new Set<string>();
	const changed = new Set<string>();
	for (const message of messages) {
		if (message.role !== 'tool' || message.isError !== false || message.skipped) continue;
		if (message.noteChange) changed.add(message.noteChange.path);
		if (message.toolName === 'Read') {
			const path = /^([^\r\n]+)（(?:第 \d+–\d+ 行|空文件)）(?:\r?\n|$)/u.exec(message.content)?.[1];
			if (notePath(path)) read.add(path);
		}
	}
	return { read, changed };
}

function citedPaths(criterion: string, evidence: string): string[] {
	return [...`${criterion}\n${evidence}`.matchAll(/\[\[([^#|\]\r\n]+)(?:[#|][^\]\r\n]*)?\]\]/gu)]
		.map((match) => match[1]).filter(notePath);
}

function settleProgress(goal: ChatGoal, result: RunState | undefined, report: GoalProgress | undefined): GoalProgress {
	const { read, changed } = successfulNoteReceipts(result?.messages ?? []);
	const criteria = goal.criteria ?? [goal.objective];
	const checks = new Map(goal.progress?.checks.filter(({ notePaths }) => !notePaths?.some((path) => changed.has(path)))
		.map((check) => [check.criterion, check] as const));
	for (const check of report?.checks ?? []) {
		const paths = [...new Set([...(check.notePaths ?? []), ...citedPaths(check.criterion, check.evidence)])];
		if (paths.length > maxNotePaths) continue;
		if (paths.some((path) => !read.has(path) && !changed.has(path))) continue;
		checks.set(check.criterion, paths.length ? { ...check, notePaths: paths } : check);
	}
	const missing = criteria.filter((criterion) => !checks.has(criterion));
	const outstanding = report?.remaining ?? goal.progress?.remaining ?? [];
	const remaining = [...new Set([...missing, ...outstanding.filter((item) => !checks.has(item))])].slice(0, MAX_GOAL_CRITERIA * 2);
	return { checks: Array.from(checks.values()), remaining, ...(report?.blocked && { blocked: report.blocked }) };
}

export function finishGoalRound(goal: ChatGoal, result: RunState | undefined): ChatGoal {
	if (goal.status !== 'active') return goal;
	const criteria = goal.criteria ?? [goal.objective];
	const successful = result?.status === 'done' || result?.status === 'file-changes-done';
	const answer = successful && result.messages.filter((message) => message.role === 'assistant' && !message.local
		&& !message.subagentActivity).at(-1);
	const lastLine = answer && !answer.incomplete && !answer.truncated && !answer.toolCalls?.length
		? answer.content.trimEnd().split('\n').at(-1) : undefined;
	const report = readReport(lastLine, criteria);
	const denied = result?.messages.some(({ role, content, approvalReview }) => role === 'tool'
		&& (content === TOOL_NOT_APPROVED || approvalReview === 'denied'));
	const next = goal.criteria || goal.progress || report ? { ...goal, progress: settleProgress(goal, result, successful && !denied ? report : undefined) } : goal;
	if (denied) {
		const progress = next.progress && { ...next.progress, blocked: TOOL_NOT_APPROVED };
		return { ...next, status: 'paused', reason: 'blocked', ...(progress && { progress }) };
	}
	if (!successful) {
		return { ...next, status: 'paused', reason: result?.status === 'limit' ? 'limit' : result?.status === 'cancelled' ? 'manual' : 'failed' };
	}
	if (answer && answer.toolCalls?.length) return { ...next, status: 'paused', reason: 'failed' };
	if (report?.blocked || lastLine === '<!-- scribe-goal-blocked -->') return { ...next, status: 'paused', reason: 'blocked' };
	if (report && next.progress?.remaining.length === 0 && report.remaining.length === 0) return { ...next, status: 'complete' };
	if (!goal.criteria && !goal.progress) {
		// 已保存的旧轮次仍按原格式恢复。
		const evidence = lastLine?.match(/^<!-- scribe-goal-complete: ([^<>\r\n]{1,600}) -->$/u)?.[1]?.trim();
		if (evidence && evidence !== '实际的完成依据') return { ...next, status: 'complete', evidence };
	}
	return next.usedRounds < next.maxRounds ? next : { ...next, status: 'paused', reason: 'limit' };
}
