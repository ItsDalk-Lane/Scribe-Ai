import { planRevision, submittedPlan } from '../../interaction/chatPlan';
import { createRunContext } from '../runContext';
import { conversationPlanFilename, SCRIBE_DATA_DIRECTORY } from '../storage/paths';
import type { ConversationStore, PermissionPolicy, RunContext, SavedRun } from '../../types';

export function connectPlanRun(ctx: RunContext, store: ConversationStore, configDir: string,
	toolsEnabled: () => boolean, canSwitch: () => boolean, onSwitch: () => void, previous?: SavedRun): void {
	const { task, signal } = ctx;
	const { conversationId } = task.request;
	const path = `${SCRIBE_DATA_DIRECTORY}/conversations/${conversationPlanFilename(conversationId, task.id)}`;
	const baseline = ctx.permissions;
	let restricted: PermissionPolicy | undefined;
	const policy = () => restricted ?? baseline;
	ctx.permissions = {
		get executionMode() { return policy().executionMode; },
		canSkipFullAccessApproval: () => policy().canSkipFullAccessApproval?.() === true,
		canRead: (path) => policy().canRead(path),
		readLines: (path) => policy().readLines?.(path),
		canWrite: (path) => policy().canWrite(path),
		canRequestPath: (path, operation) => policy().canRequestPath?.(path, operation) === true,
		canCallTool: (tool) => policy().canCallTool(tool),
		canSendOutbound: () => policy().canSendOutbound(),
	};
	const canEnter = () => !task.request.intent && !task.request.approvedPlanTaskId && !task.request.goalRound && !task.request.target && canSwitch();
	const requirePlanning = () => {
		signal.throwIfAborted();
		if (task.request.intent !== 'plan') throw new Error('当前任务不在计划模式。');
	};
	ctx.plan = {
		path,
		canEnter,
		async enter() {
			signal.throwIfAborted();
			if (!canEnter()) throw new Error('当前任务无法进入计划模式。');
			const readonlyTask = { ...task, request: { ...task.request, intent: 'plan' as const } };
			const planning = await createRunContext(readonlyTask, ctx, configDir, toolsEnabled);
			signal.throwIfAborted();
			if (!canEnter()) throw new Error('有工作正在执行，无法切换到计划模式。');
			await store.append(conversationId, [{ type: 'plan-enter', taskId: task.id }]);
			restricted = planning.permissions;
			task.request.intent = 'plan';
			onSwitch();
			return `已进入只读计划模式。使用 SavePlan 保存计划，随后用 SubmitPlan 提请用户确认。计划草案位置 ${path}`;
		},
		async read() {
			requirePlanning();
			const current = await store.readPlanDraft(conversationId, task.id);
			if (current) return current.markdown;
			if (previous && task.request.revisesPlanTaskId === previous.state.taskId) {
				const draft = previous.planDraft ?? await store.readPlanDraft(conversationId, previous.state.taskId);
				const markdown = draft?.markdown ?? submittedPlan(previous)?.markdown;
				if (markdown) return markdown;
			}
			return '本轮尚未保存计划。';
		},
		async save(markdown) {
			requirePlanning();
			await store.savePlanDraft(conversationId, task.id, { markdown, submitted: false });
			return `计划草案已保存到 ${path}。定稿后使用 SubmitPlan 请求用户确认。`;
		},
		async submit() {
			requirePlanning();
			const draft = await store.readPlanDraft(conversationId, task.id);
			if (!draft) throw new Error('请先用 SavePlan 保存计划。');
			await store.savePlanDraft(conversationId, task.id, { ...draft, submitted: true }, planRevision(draft.markdown));
			return '计划已提交等待用户确认。可简短说明关键决定，然后结束本轮。';
		},
	};
}
