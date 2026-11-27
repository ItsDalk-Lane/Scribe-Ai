import type { ChatTask, ChatTaskUpdate } from '../orchestration/storage/chatTasks';
import type { ToolContext, ToolDefinition, ToolModule } from '../types';
import { fileToolInput, requiredText } from './support/fileAccess';

export const chatTaskReadTools = new Set(['TaskList', 'TaskGet']);
export const chatTaskToolNames = new Set([...chatTaskReadTools, 'TaskCreate', 'TaskUpdate']);

const taskId = { type: 'string', description: '清单中的任务编号。' };
const details = {
	subject: { type: 'string', description: '简短的行动标题。' },
	description: { type: 'string', description: '工作范围和可核对的完成条件。' },
	activeForm: { type: 'string', description: '执行时展示的简短进度，如“正在核对引文”。' },
};
const blockedBy = { type: 'array', items: taskId, description: '必须先完成的任务编号。' };
const blocks = { type: 'array', items: taskId, description: '需要等本项完成的任务编号。' };
const statuses = ['pending', 'in_progress', 'completed', 'deleted'] as const;
const planStatuses = ['pending', 'deleted'];
const createFields = { ...details, blockedBy, blocks };
const updateFields = { taskId, ...details, status: { type: 'string', enum: statuses }, addBlockedBy: blockedBy, addBlocks: blocks };

function schema(properties: Record<string, unknown>, required: string[]) {
	return { type: 'object', properties, required, additionalProperties: false };
}

function access(ctx: ToolContext) {
	if (!ctx.chatTasks || ctx.task.request.intent === 'review') throw new Error('当前任务无法访问聊天清单。');
	return ctx.chatTasks;
}

function optionalIds(args: Record<string, unknown>, field: string): string[] | undefined {
	const ids = args[field];
	if (ids === undefined) return;
	if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string' && Boolean(id.trim()))) {
		throw new Error(`参数 ${field} 必须是任务编号列表。`);
	}
	return ids;
}

function taskInfo(task: ChatTask, full: boolean) {
	const { id, subject, status, owner, blockedBy, blocks, planRunId } = task;
	return { id, subject, status, owner, blockedBy, blocks, ...(planRunId && { awaitingPlanApproval: true }),
		...(full && { description: task.description, activeForm: task.activeForm }) };
}

const definitions: ToolDefinition[] = [{
	name: 'TaskList', description: '查看本聊天当前一批任务的状态、负责人和依赖。', isReadOnly: true,
	inputSchema: schema({}, []),
	prepare(input, ctx) {
		fileToolInput(input, []);
		const store = access(ctx);
		return { run: async () => {
			const batch = (await store.list()).at(-1);
			return JSON.stringify({ batch: batch?.id, tasks: batch?.tasks.map((task) => taskInfo(task, false)) ?? [] });
		} };
	},
}, {
	name: 'TaskGet', description: '按编号查看本聊天任务的完整要求、状态和依赖。', isReadOnly: true,
	inputSchema: schema({ taskId }, ['taskId']),
	prepare(input, ctx) {
		const id = requiredText(fileToolInput(input, ['taskId']), 'taskId');
		const store = access(ctx);
		return { run: async () => JSON.stringify(taskInfo(await store.get(id), true)) };
	},
}, {
	name: 'TaskCreate', description: '在本聊天清单中新增待办。可用已有编号设置先后依赖。', isReadOnly: false,
	inputSchema: schema(createFields, ['subject', 'description']),
	prepare(input, ctx) {
		const args = fileToolInput(input, Object.keys(createFields));
		const store = access(ctx);
		const task = { subject: requiredText(args, 'subject'), description: requiredText(args, 'description'),
			...(args.activeForm !== undefined && { activeForm: requiredText(args, 'activeForm') }),
			blockedBy: optionalIds(args, 'blockedBy'), blocks: optionalIds(args, 'blocks') };
		return { independent: true, run: async () => JSON.stringify(taskInfo(await store.create(task), true)) };
	},
}, {
	name: 'TaskUpdate', description: '修改任务要求或依赖。开始时用 in_progress 认领，核实完成用 completed，放回待办用 pending，移除用 deleted。', isReadOnly: false,
	inputSchema: schema(updateFields, ['taskId']),
	prepare(input, ctx) {
		const args = fileToolInput(input, Object.keys(updateFields));
		const store = access(ctx);
		const change: ChatTaskUpdate = { id: requiredText(args, 'taskId') };
		if (Object.keys(args).length === 1) throw new Error('请指定要更改的任务字段。');
		for (const field of ['subject', 'description', 'activeForm'] as const) {
			if (args[field] !== undefined) change[field] = requiredText(args, field);
		}
		if (args.addBlockedBy !== undefined) change.addBlockedBy = optionalIds(args, 'addBlockedBy');
		if (args.addBlocks !== undefined) change.addBlocks = optionalIds(args, 'addBlocks');
		if (args.status !== undefined) {
			const status = statuses.find((item) => item === args.status);
			if (!status) throw new Error('任务状态无效。');
			if (ctx.task.request.intent === 'plan' && !planStatuses.includes(status)) throw new Error('计划需要用户确认后才能执行。');
			if (status === 'deleted' && Object.keys(args).length !== 2) throw new Error('删除任务时只需指定编号和状态。');
			change.status = status;
		}
		return { independent: true, run: async () => {
			const task = await store.update(change);
			return JSON.stringify(change.status === 'deleted' ? { id: task.id, deleted: true } : taskInfo(task, true));
		} };
	},
}];

export const chatTaskTools: ToolModule = () => definitions;

export function isChatTaskMutation(tool: ToolDefinition) {
	return !tool.isReadOnly && definitions.includes(tool);
}
