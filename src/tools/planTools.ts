import type { ToolDefinition, ToolModule } from '../types';
import { fileToolInput, requiredText } from './support/fileAccess';

export interface RunPlanTools {
	path: string;
	canEnter(): boolean;
	enter(): Promise<string>;
	read(): Promise<string>;
	save(markdown: string): Promise<string>;
	submit(): Promise<string>;
}

const noArguments = { type: 'object', properties: {}, additionalProperties: false };
const definitions: ToolDefinition[] = [{
	name: 'EnterPlanMode', description: '将本轮收紧为只读计划模式。需要先调查和让用户确认方案时使用。切换后无法自行恢复执行。',
	isReadOnly: false, inputSchema: noArguments,
	prepare(input, { plan }) {
		fileToolInput(input, []);
		if (!plan?.canEnter()) throw new Error('当前任务无法进入计划模式。');
		return { independent: true, run: () => plan.enter() };
	},
}, {
	name: 'ReadPlan', description: '读取本轮计划草案或用户要求修订的上一版。开始修订或恢复整理后使用。',
	isReadOnly: true, inputSchema: noArguments,
	prepare(input, { task, plan }) {
		fileToolInput(input, []);
		if (task.request.intent !== 'plan' || !plan) throw new Error('只能在计划模式下读取草案。');
		return { run: () => plan.read() };
	},
}, {
	name: 'SavePlan', description: '把完整 Markdown 保存为本轮的私有计划草案。修订时传入完整新版。正文包含一级标题和可核对的验收条件。',
	isReadOnly: false,
	inputSchema: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'], additionalProperties: false },
	prepare(input, { task, plan }) {
		const markdown = requiredText(fileToolInput(input, ['markdown']), 'markdown');
		if (task.request.intent !== 'plan' || !plan) throw new Error('只能在计划模式下保存草案。');
		return { independent: true, run: () => plan.save(markdown) };
	},
}, {
	name: 'SubmitPlan', description: '将已保存的计划交给用户确认。提交后简短说明需要用户决定的事项，由用户选择继续执行或要求修改。',
	isReadOnly: false, inputSchema: noArguments,
	prepare(input, { task, plan }) {
		fileToolInput(input, []);
		if (task.request.intent !== 'plan' || !plan) throw new Error('只能在计划模式下提交草案。');
		return { independent: true, run: () => plan.submit() };
	},
}];

export const planToolNames = new Set(definitions.map(({ name }) => name));
export const planDraftToolNames = new Set([...planToolNames].filter((name) => name !== 'EnterPlanMode'));
export const planTools: ToolModule = () => definitions;

export function isPlanMutation(tool: ToolDefinition) {
	return !tool.isReadOnly && definitions.includes(tool);
}
