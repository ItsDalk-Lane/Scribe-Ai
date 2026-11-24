import type { SavedRun, TaskRequest } from '../types';
import { MAX_GOAL_PLAN_LENGTH, validGoalCriteria, validGoalRef } from './chatGoal';

export interface ChatPlan {
	request: TaskRequest;
	taskId: string;
	title: string;
	markdown: string;
	criteria: string[];
}

export function submittedPlan(run?: SavedRun): ChatPlan | undefined {
	if (run?.request.intent !== 'plan' || (run.state.status !== 'done' && run.state.status !== 'file-changes-done')) return;
	const answer = run.state.messages.at(-1);
	if (answer?.role !== 'assistant' || answer.local || answer.incomplete || answer.truncated || answer.toolCalls?.length) return;
	const lines = answer.content.trimEnd().split(/\r?\n/u);
	const start = lines.indexOf('<!-- scribe-plan -->');
	if (start < 0 || lines.at(-1) !== '<!-- /scribe-plan -->') return;
	const markdown = lines.slice(start + 1, -1).join('\n').trim();
	if (!markdown || markdown.length > MAX_GOAL_PLAN_LENGTH || /<!-- \/?scribe-plan -->/u.test(markdown)) return;
	const title = /^#[\t ]+(.+)/u.exec(markdown)?.[1]?.trim();
	if (!title) return;
	const acceptance = lines.findIndex((line, index) => index > start
		&& /^#{2,6}[\t ]+(?:验收条件|驗收條件|Acceptance criteria)\s*$/iu.test(line));
	if (acceptance < 0) return;
	const nextSection = lines.findIndex((line, index) => index > acceptance && /^#{1,6}\s/u.test(line));
	const criteria = [...new Set(lines.slice(acceptance + 1, nextSection < 0 ? -1 : nextSection).flatMap((line) => {
		const item = /^-\s+(.+)$/u.exec(line)?.[1]?.trim();
		return item ? [item] : [];
	}))];
	if (!validGoalCriteria(criteria)) return;
	const refs = run.request.refs.filter(validGoalRef);
	return { request: { ...run.request, refs }, taskId: run.state.taskId, title, markdown, criteria };
}

export function approvedPlanRequest({ request, markdown }: ChatPlan): TaskRequest {
	return {
		conversationId: request.conversationId,
		instruction: `${request.instruction}\n\n用户已确认以下计划，请在确认的范围内执行，遵守现有审批，并逐项核对验收条件。\n\n${markdown}`,
		imageLinkEnd: request.instruction.length,
		...(request.imageSourcePath && { imageSourcePath: request.imageSourcePath }),
		refs: request.refs,
		chatQuotes: request.chatQuotes,
		skillMentions: request.skillMentions,
		skillScope: request.skillScope,
		skillNotePaths: request.skillNotePaths,
	};
}

export function stripPlanMarkers(content: string): string {
	return content.replace(/^<!-- \/?scribe-plan -->[\t ]*(?:\r?\n|$)/gmu, '').trimEnd();
}
