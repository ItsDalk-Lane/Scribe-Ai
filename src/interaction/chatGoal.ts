import { TOOL_NOT_APPROVED } from '../types';
import { goalNoteObservations, localNoteCondition, noteConditionMet } from './goalNoteEvidence';
import type { Message, NoteRef, RunState, SkillMention } from '../types';
import { isSkillMentionAt } from '../skills/mentions';
import { safeResourcePath } from '../skills/library/vaultAdapter';
import { isCachedImagePath } from '../orchestration/storage/paths';

export const MAX_GOAL_LENGTH = 8_000;
export const MAX_GOAL_CRITERIA = 20;
export const MAX_GOAL_PLAN_LENGTH = 16_000;

const maxEvidenceLength = 600;
const maxNotePaths = 100;
const maxObservationDigests = 256;
const reportStart = '<!-- scribe-goal-report: ';
const reportEnd = ' -->';
export const reportGoalToolName = 'ReportGoal';

export type GoalPause = 'manual' | 'plan' | 'closed' | 'stalled' | 'failed' | 'blocked' | 'verification';

export interface GoalCheck {
	criterion: string;
	evidence: string;
	notePaths?: string[];
}

export interface GoalProgress {
	observations?: string[];
	checks: GoalCheck[];
	remaining: string[];
	blocked?: string;
}

interface NumberedGoalReport extends Omit<GoalProgress, 'checks' | 'observations'> {
	checks: (Omit<GoalCheck, 'criterion'> & { criterion: number })[];
}

export interface ChatGoal {
	objective: string;
	status: 'active' | 'paused' | 'complete';
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
		&& (value.observations === undefined || (Array.isArray(value.observations) && value.observations.length <= maxObservationDigests
			&& value.observations.every((item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))))
		&& textList(value.remaining, MAX_GOAL_CRITERIA * 2, MAX_GOAL_LENGTH)
		&& (value.blocked === undefined || text(value.blocked, maxEvidenceLength));
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
	const { objective, usedRounds, totalRounds, workedMs, status, reason, evidence, criteria,
		refs, imageSourcePath, chatQuotes, skillMentions, skillScope, skillNotePaths, plan, progress } = value;
	if (!text(objective, MAX_GOAL_LENGTH) || !count(totalRounds) || !count(usedRounds)
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
		objective, usedRounds, totalRounds, status,
		...(workedMs !== undefined && { workedMs }),
		...(reason === 'limit' ? { reason: 'manual' } :
			(reason === 'manual' || reason === 'plan' || reason === 'closed' || reason === 'stalled' || reason === 'failed' || reason === 'blocked' || reason === 'verification') && { reason }),
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

export function parseNumberedGoalReport(value: unknown, criterionCount: number): NumberedGoalReport | undefined {
	if (!record(value) || !Array.isArray(value.checks) || value.checks.length > criterionCount
		|| !textList(value.remaining, MAX_GOAL_CRITERIA, maxEvidenceLength)
		|| (value.blocked !== undefined && !text(value.blocked, maxEvidenceLength))) return;
	const checks: NumberedGoalReport['checks'] = [];
	for (const check of value.checks as unknown[]) {
		if (!record(check) || !count(check.criterion) || check.criterion < 1 || check.criterion > criterionCount
			|| !text(check.evidence, maxEvidenceLength) || (check.notePaths !== undefined && !notePaths(check.notePaths))
			|| checks.some((saved) => saved.criterion === check.criterion)) return;
		checks.push({ criterion: check.criterion, evidence: check.evidence.trim(), ...(check.notePaths && { notePaths: check.notePaths }) });
	}
	return { checks, remaining: value.remaining.map((item) => item.trim()), ...(value.blocked && { blocked: value.blocked.trim() }) };
}

export function confirmedGoalReport(messages: readonly Message[], criterionCount: number): NumberedGoalReport | undefined {
	const receipts = new Set<string>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		if (msg.local) continue;
		if (msg.role === 'user') return;
		if (msg.role === 'tool' && msg.toolName === reportGoalToolName && msg.toolCallId && msg.isError === false && !msg.skipped) {
			receipts.add(msg.toolCallId);
		}
		if (msg.role !== 'assistant') continue;
		const call = !msg.incomplete && !msg.truncated && msg.toolCalls?.find(({ name, id }) => name === reportGoalToolName && receipts.has(id));
		if (call) return parseNumberedGoalReport(call.input, criterionCount);
		receipts.clear();
	}
	return undefined;
}

function goalProgress(report: NumberedGoalReport, criteria: string[]): GoalProgress {
	return { ...report, checks: report.checks.map((check) => ({ ...check, criterion: criteria[check.criterion - 1]! })) };
}

function readLegacyReport(line: string | undefined, criteria: string[], legacyGoal: boolean): GoalProgress | undefined {
	if (legacyGoal) {
		const evidence = line?.match(/^<!-- scribe-goal-complete: ([^<>\r\n]{1,600}) -->$/u)?.[1]?.trim();
		if (evidence && evidence !== '实际的完成依据') {
			return { checks: [{ criterion: criteria[0]!, evidence }], remaining: [] };
		}
	}
	if (!line?.startsWith(reportStart) || !line.endsWith(reportEnd) || line.length > 125_000) return;
	let value: unknown;
	try { value = JSON.parse(line.slice(reportStart.length, -reportEnd.length)); } catch { return; }
	const report = parseNumberedGoalReport(value, criteria.length);
	return report && goalProgress(report, criteria);
}

function citedPaths(criterion: string, evidence: string): string[] {
	return [...`${criterion}\n${evidence}`.matchAll(/\[\[([^#|\]\r\n]+)(?:[#|][^\]\r\n]*)?\]\]/gu)]
		.map((match) => match[1]).filter(notePath);
}

function settleProgress(goal: ChatGoal, answer: string, report: GoalProgress | undefined,
	{ latest, changed }: ReturnType<typeof goalNoteObservations>): GoalProgress {
	const criteria = goal.criteria ?? [goal.objective];
	const checks = new Map<string, GoalCheck>();
	const relevantPaths = new Set(criteria.flatMap((criterion) => {
		const local = localNoteCondition(criterion);
		return local ? [local.path] : citedPaths(criterion, '');
	}));
	for (const check of goal.progress?.checks ?? []) {
		const local = localNoteCondition(check.criterion);
		if (local) {
			// 在宣告全部完成之前，使用本轮最新观察复核，即使该项是从旧版本的目标记录恢复的。
			if ((latest.has(local.path) || report?.remaining.length === 0) && !noteConditionMet(local, latest.get(local.path))) continue;
		} else if (check.notePaths?.some((path) => changed.has(path))) continue;
		checks.set(check.criterion, check);
	}
	for (const check of report?.checks ?? []) {
		const local = localNoteCondition(check.criterion);
		const paths = local ? [local.path] : [...new Set([...(check.notePaths ?? []), ...citedPaths(check.criterion, check.evidence)])];
		if (paths.length > maxNotePaths || paths.some((path) => !latest.has(path))) continue;
		if (local && !noteConditionMet(local, latest.get(local.path))) continue;
		checks.set(check.criterion, paths.length ? { ...check, notePaths: paths } : check);
	}
	const missing = criteria.filter((criterion) => !checks.has(criterion));
	const outstanding = report?.remaining ?? goal.progress?.remaining ?? [];
	const remaining = [...new Set([...missing, ...outstanding.filter((item) => !checks.has(item))])].slice(0, MAX_GOAL_CRITERIA * 2);
	const account = [goal.objective, stripGoalReport(answer), ...(report?.remaining ?? []),
		...(report?.checks.flatMap((check) => [check.evidence, ...(check.notePaths ?? [])]) ?? [])].filter(Boolean).join('\n');
	const seen = new Set(goal.progress?.observations);
	for (const [path, observation] of latest) {
		if (!observation.digest || !observation.body?.trim()) continue;
		if (relevantPaths.has(path) || account.includes(path) || goal.refs?.some((ref) => ref.kind === 'folder'
			? path.startsWith(ref.path + '/') : path === ref.path)) seen.add(observation.digest);
	}
	return { checks: [...checks.values()], remaining, ...(seen.size > 0 && { observations: [...seen].slice(-maxObservationDigests) }), ...(report?.blocked && { blocked: report.blocked }) };
}

type GoalReview = 'passed' | 'needs-evidence';

export function goalCompletionEvidence(goal: ChatGoal, result: RunState) {
	if (goal.status !== 'active') return;
	const notes = goalNoteObservations(result.messages, notePath);
	const proposed = finishGoalRound(goal, result, 'passed', notes);
	if (proposed.status !== 'complete' || !proposed.progress) return;
	const checks: GoalCheck[] = [];
	const local = new Map<string, { path: string; start: number; body: string }>();
	for (const check of proposed.progress.checks) {
		const condition = localNoteCondition(check.criterion);
		if (!condition) checks.push(check);
		else {
			const observed = notes.latest.get(condition.path);
			if (observed?.body === undefined) return;
			local.set(condition.path, { path: condition.path, start: observed.start, body: observed.body });
		}
	}
	return { checks, local: [...local.values()] };
}

export function finishGoalRound(goal: ChatGoal, result: RunState | undefined, review?: GoalReview,
	notes = goalNoteObservations(result?.messages ?? [], notePath)): ChatGoal {
	if (goal.status !== 'active') return goal;
	const criteria = goal.criteria ?? [goal.objective];
	const successful = result?.status === 'done' || result?.status === 'file-changes-done';
	const answer = successful && result.messages.filter((message) => message.role === 'assistant' && !message.local
		&& !message.subagentActivity).at(-1);
	const lastLine = answer && !answer.incomplete && !answer.truncated && !answer.toolCalls?.length
		? answer.content.trimEnd().split('\n').at(-1) : undefined;
	const structured = lastLine !== undefined && result ? confirmedGoalReport(result.messages, criteria.length) : undefined;
	const legacy = answer && !answer.goalReportRequired && !structured;
	const report = structured ? goalProgress(structured, criteria) : legacy ? readLegacyReport(lastLine, criteria, !goal.criteria && !goal.progress) : undefined;
	const denied = result?.messages.some(({ role, content, approvalReview }) => role === 'tool'
		&& (content === TOOL_NOT_APPROVED || approvalReview === 'denied'));
	const next = goal.criteria || goal.progress || report ? { ...goal, progress: settleProgress(goal, answer ? answer.content : '', successful && !denied ? report : undefined, notes) } : goal;
	if (denied) {
		const progress = next.progress && { ...next.progress, blocked: TOOL_NOT_APPROVED };
		return { ...next, status: 'paused', reason: 'blocked', ...(progress && { progress }) };
	}
	if (!successful) {
		return { ...next, status: 'paused', reason: result?.status === 'limit' ? 'stalled' : result?.status === 'cancelled' ? 'manual' : 'failed' };
	}
	if (answer && answer.toolCalls?.length) return { ...next, status: 'paused', reason: 'failed' };
	if (report?.blocked || (legacy && lastLine === '<!-- scribe-goal-blocked -->')) return { ...next, status: 'paused', reason: 'blocked' };
	if (report && next.progress?.remaining.length === 0 && report.remaining.length === 0) {
		const semantic = next.progress.checks.filter((check) => !localNoteCondition(check.criterion));
		if (review === 'needs-evidence' || (semantic.length && review !== 'passed')) {
			const unresolved = review === 'needs-evidence' ? next.progress.checks : semantic;
			return { ...next, status: 'paused', reason: 'verification', progress: { ...next.progress,
				checks: next.progress.checks.filter((check) => !unresolved.includes(check)), remaining: unresolved.map((check) => check.criterion) } };
		}
		return { ...next, status: 'complete' };
	}
	const checked = new Set(goal.progress?.checks.map(({ criterion }) => criterion));
	const previouslySeen = new Set(goal.progress?.observations);
	const advanced = next.progress?.checks.some(({ criterion }) => !checked.has(criterion))
		|| next.progress?.observations?.some((digest) => !previouslySeen.has(digest));
	return advanced ? next : { ...next, status: 'paused', reason: 'stalled' };
}
