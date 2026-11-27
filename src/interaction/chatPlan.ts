import { createHash } from 'node:crypto';
import type { SavedRun, TaskRequest } from '../types';
import { MAX_GOAL_PLAN_LENGTH, validGoalCriteria, validGoalRef } from './chatGoal';

const approvalNotice = '\n\n用户已确认以下计划，请在确认的范围内执行，遵守现有审批，并逐项核对验收条件。\n\n';

export interface ChatPlan {
	request: TaskRequest;
	taskId: string;
	title: string;
	markdown: string;
	criteria: string[];
	revision: string;
}

export interface PlanDraft {
	markdown: string;
	submitted: boolean;
}

export function planRevision(markdown: string): string {
	return createHash('sha256').update(markdown).digest('hex');
}

export function parsePlanMarkdown(markdown: string): Pick<ChatPlan, 'title' | 'criteria'> | undefined {
	if (!markdown || markdown.length > MAX_GOAL_PLAN_LENGTH || /<!-- \/?scribe-plan -->/u.test(markdown)) return;
	const lines = markdown.split(/\r?\n/u);
	const title = /^#[\t ]+(.+)/u.exec(markdown)?.[1]?.trim();
	if (!title) return;
	const acceptance = lines.findIndex((line, index) => index > 0
		&& /^#{2,6}[\t ]+(?:验收条件|驗收條件|Acceptance criteria)\s*$/iu.test(line));
	if (acceptance < 0) return;
	const nextSection = lines.findIndex((line, index) => index > acceptance && /^#{1,6}\s/u.test(line));
	const criteria = [...new Set(lines.slice(acceptance + 1, nextSection < 0 ? undefined : nextSection).flatMap((line) => {
		const item = /^-\s+(.+)$/u.exec(line)?.[1]?.trim();
		return item ? [item] : [];
	}))];
	return validGoalCriteria(criteria) ? { title, criteria } : undefined;
}

function legacyPlan(run: SavedRun): string | undefined {
	const answer = run.state.messages.at(-1);
	if (answer?.role !== 'assistant' || answer.local || answer.incomplete || answer.truncated || answer.toolCalls?.length) return;
	const lines = answer.content.trimEnd().split(/\r?\n/u);
	const start = lines.indexOf('<!-- scribe-plan -->');
	return start >= 0 && lines.at(-1) === '<!-- /scribe-plan -->' ? lines.slice(start + 1, -1).join('\n').trim() : undefined;
}

export function submittedPlan(run?: SavedRun): ChatPlan | undefined {
	if (run?.request.intent !== 'plan' || run.planArchived || (run.state.status !== 'done' && run.state.status !== 'file-changes-done')) return;
	const markdown = run.planDraft ? (run.planDraft.submitted ? run.planDraft.markdown : undefined) : legacyPlan(run);
	if (markdown === undefined) return;
	const fields = parsePlanMarkdown(markdown);
	if (!fields) return;
	const refs = run.request.refs.filter(validGoalRef);
	return { request: { ...run.request, refs }, taskId: run.state.taskId, markdown, revision: planRevision(markdown), ...fields };
}

export function approvedPlanRequest({ request, markdown, taskId, revision }: ChatPlan, mode?: TaskRequest['approvedPlanMode']): TaskRequest {
	return {
		conversationId: request.conversationId,
		approvedPlanTaskId: taskId,
		approvedPlanRevision: revision,
		...(mode && { approvedPlanMode: mode }),
		instruction: `${request.instruction}${approvalNotice}${markdown}`,
		imageLinkEnd: request.instruction.length,
		...(request.imageSourcePath && { imageSourcePath: request.imageSourcePath }),
		refs: request.refs,
		chatQuotes: request.chatQuotes,
		skillMentions: request.skillMentions,
		skillScope: request.skillScope,
		skillNotePaths: request.skillNotePaths,
	};
}

export function approvedPlanContent(request: TaskRequest): { instruction: string; markdown: string } | undefined {
	if (!request.approvedPlanTaskId) return;
	const offset = request.imageLinkEnd ?? request.instruction.lastIndexOf(approvalNotice);
	return offset >= 0 && request.instruction.startsWith(approvalNotice, offset) ? {
		instruction: request.instruction.slice(0, offset),
		markdown: request.instruction.slice(offset + approvalNotice.length),
	} : undefined;
}

export function matchesApprovedPlan(plan: ChatPlan | undefined, request: TaskRequest, requireRevision: boolean): boolean {
	if (!plan || plan.taskId !== request.approvedPlanTaskId || request.intent || request.target || request.goalRound
		|| (request.approvedPlanMode !== undefined && request.approvedPlanMode !== 'continue' && request.approvedPlanMode !== 'fresh')
		|| ((requireRevision || request.approvedPlanRevision !== undefined) && request.approvedPlanRevision !== plan.revision)) return false;
	const expected = approvedPlanRequest(plan);
	return request.instruction === expected.instruction && request.imageSourcePath === expected.imageSourcePath
		&& (request.imageLinkEnd === expected.imageLinkEnd || (!request.approvedPlanRevision && request.imageLinkEnd === undefined))
		&& JSON.stringify(request.refs) === JSON.stringify(expected.refs)
		&& JSON.stringify(request.chatQuotes ?? []) === JSON.stringify(expected.chatQuotes ?? [])
		&& JSON.stringify(request.skillMentions ?? []) === JSON.stringify(expected.skillMentions ?? []);
}

export function stripPlanMarkers(content: string): string {
	return content.replace(/^<!-- \/?scribe-plan -->[\t ]*(?:\r?\n|$)/gmu, '').trimEnd();
}
