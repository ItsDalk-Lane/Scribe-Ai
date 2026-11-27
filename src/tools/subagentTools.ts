import type { SubagentToolAccess, ToolCall, ToolDefinition, ToolModule, ToolSpec } from '../types';
import { fileToolInput, requiredText } from './support/fileAccess';

const target = { type: 'string', description: '当前聊天中的子 Agent 编号。' };
const message = { type: 'string', description: '具体任务、补充信息或需要返回的结果。' };
const questionId = { type: 'string', description: '收件信息中的问题编号。' };
export const contactSubagentTool = 'contact_subagent';
export const manageSubagentsTool = 'manage_subagents';

type Action = {
	value: string;
	operation: string;
	description: string;
	fields: string[];
	childOnly?: true;
	answering?: true;
	freshOnly?: true;
};

const groups = new Map<string, { description: string; actions: Action[] }>([
	[contactSubagentTool, { description: '向子 Agent 或派发方传递协作信息。', actions: [
		{ value: 'send', operation: 'send_message', fields: ['target', 'message'],
			description: '补充信息。运行中会接收，空闲时保留消息。' },
		{ value: 'follow_up', operation: 'followup_task', fields: ['target', 'message'], freshOnly: true,
			description: '交给现有子 Agent 后续任务，使用其历史启动新一轮。' },
		{ value: 'ask_parent', operation: 'ask_parent', fields: ['message'], childOnly: true,
			description: '缺少关键事实时向派发方提出具体问题，等待答复。' },
		{ value: 'answer', operation: 'answer_subagent', fields: ['question_id', 'message'], answering: true,
			description: '按问题编号答复。无法确认时说明能确认的范围。' },
	] }],
	[manageSubagentsTool, { description: '查看子 Agent 状态并管理已有分工。', actions: [
		{ value: 'list', operation: 'list_agents', fields: [], answering: true, description: '列出本聊天的子 Agent、身份和状态。' },
		{ value: 'interrupt', operation: 'interrupt_agent', fields: ['target'], description: '中断当前工作并保留记录。' },
		{ value: 'close', operation: 'close_agent', fields: ['target'], description: '关闭并释放名额，保留历史。' },
		{ value: 'reopen', operation: 'resume_agent', fields: ['target'], freshOnly: true, description: '重新打开已关闭的子 Agent。' },
	] }],
]);
const actionFields: Record<string, unknown> = { target, message, question_id: questionId };

function groupedSchema(actions: Action[]) {
	const fields = new Set(actions.flatMap(({ fields }) => fields));
	return {
		type: 'object',
		properties: {
			action: { type: 'string', enum: actions.map(({ value }) => value), description: actions.map(({ value, description, fields }) =>
				`${value}${fields.length ? `（必填 ${fields.join('、')}）` : ''}：${description}`).join(' ') },
			...Object.fromEntries(Array.from(fields, (field) => [field, actionFields[field]])),
		},
		required: ['action', ...actions[0]!.fields.filter((field) => actions.every(({ fields }) => fields.includes(field)))],
		additionalProperties: false,
	};
}

function groupedAction({ name, input }: Pick<ToolCall, 'name' | 'input'>) {
	const value = input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'action')
		? (input as { action: unknown }).action : undefined;
	return groups.get(name)?.actions.find((action) => action.value === value);
}

function actionAllowed(action: Action, access: SubagentToolAccess) {
	return (!action.childOnly || access.canAskParent) && (!action.freshOnly || !access.resuming);
}

const specs: { name: string; description: string; properties: Record<string, unknown>; required: string[] }[] = [{
	name: 'spawn_agent',
	description: '在后台启动子助手并返回用于协作的编号。明确各自负责的工作，避免多个助手重复操作同一批文件或段落。',
	properties: {
		message: { type: 'string', description: '写一份可以独立执行的任务简报，说明目标、必要背景、已知决定、可用资料、工作范围、交付和验收条件。即使继承历史也应指出关键资料和决定。' },
		agent_type: { type: 'string', description: '从可用角色中选择匹配的角色。两个角色参数都省略时使用默认角色。' },
		system_instructions: { type: 'string', description: '需要临时角色时，填写此子助手的职责、方法和限制并省略 agent_type。具体任务写在 message 中。' },
		nickname: { type: 'string', description: '便于在聊天中辨认任务的简短名称。' },
		model: { type: 'string', description: '有预设模型的角色优先使用预设。否则默认沿用派发者的模型。用户明确指定时可填写同服务商的模型 ID，或用「服务商 ID/模型 ID」请求切换服务商。跨服务商或接收地址变化可触发发送审批。' },
		reasoning_effort: { type: 'string', description: '角色没有预设模型且用户明确指定时，填写模型支持的思考档位。' },
		fork_turns: { type: 'string', enum: ['all', 'none'], description: '默认 none，从本次分派和当前获准资料开始，不继承父级历史。仅当历史是完成任务所必需时选择 all，继承可用历史和引用。只读计划始终从独立简报开始。' },
	},
	required: ['message'],
}, {
	name: 'review_subagent_result',
	description: '逐项核对提交原文与任务和证据。成功完成且下一步立即采用选 use，成功完成但稍后采用选 defer，届时用返回路径和 read_subagent_result 重读。需要原助手修改选 revise，提交原因、错误标识和完整修改要求。无法验收时选 blocked 并说明原因。',
	properties: {
		result_id: { type: 'string', description: '待核对提交的结果编号。每版独立编号。' },
		decision: { type: 'string', enum: ['use', 'defer', 'revise', 'blocked'] },
		reason: { type: 'string', description: '退回或无法通过的具体原因。' },
		error_key: { type: 'string', description: '选择 revise 时填写可重复使用的关键错误标识，例如 missing-source。同一错误沿用同一个标识。连续两稿以同一标识退回时，运行时停止该项自动返工。' },
		message: { type: 'string', description: '选择 revise 时填写交给原子 Agent 的完整修改要求。' },
	},
	required: ['result_id', 'decision'],
}, {
	name: 'read_subagent_result',
	description: '按工作结果的专用路径读取本聊天的完整提交原文。核对大型结果或随后要用已暂存的结果时使用。',
	properties: { path: { type: 'string', description: '协作结果收到时列出的读取路径。' } },
	required: ['path'],
}, {
	name: 'wait_agent',
	description: '等待当前聊天的子 Agent 产生新消息或结果。到时只结束等待，已有子任务继续进行。需要结果再等待。',
	properties: {
		targets: { type: 'array', minItems: 1, items: target, description: '要等待的子 Agent 编号。省略时等待本聊天中的子 Agent。' },
		timeout_ms: { type: 'integer', minimum: 0, description: '等待毫秒数，默认 30000。' },
	},
	required: [],
}];

export const subagentToolNames = new Set([...groups.keys(), ...specs.map(({ name }) => name)]);
const historicalNames = new Set(Array.from(groups.values()).flatMap(({ actions }) => actions.map(({ operation }) => operation)));

export function isSubagentTool(name: string) {
	return subagentToolNames.has(name) || historicalNames.has(name);
}

export function subagentOperation(call: Pick<ToolCall, 'name' | 'input'>) {
	return groups.has(call.name) ? groupedAction(call)?.operation : call.name;
}

export function subagentToolVisible(name: string, access: SubagentToolAccess | undefined): boolean {
	return !subagentToolNames.has(name) || Boolean(access && (name !== 'spawn_agent' || access.canSpawn));
}

export function subagentRequestTool(tool: ToolSpec, access: SubagentToolAccess | undefined, answering: boolean): ToolSpec {
	const group = groups.get(tool.name);
	return group && access ? { ...tool, inputSchema: groupedSchema(group.actions.filter((action) =>
		actionAllowed(action, access) && (!answering || action.answering))) } : tool;
}

export function subagentActionWhileAnswering(tool: string | ToolCall): boolean {
	return typeof tool === 'string'
		? groups.get(tool)?.actions.some(({ answering }) => answering) === true
		: groupedAction(tool)?.answering === true;
}

function parseSubagentToolInput(name: string, input: unknown): Record<string, unknown> {
	const spec = specs.find((tool) => tool.name === name);
	if (!spec) throw new Error('未知的子 Agent 操作。');
	const args = fileToolInput(input, Object.keys(spec.properties));
	for (const field of spec.required) requiredText(args, field);
	for (const [field, value] of Object.entries(args)) {
		if (field === 'timeout_ms') {
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('timeout_ms 必须是非负整数。');
		} else if (field === 'targets') {
			if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim())) {
				throw new Error('targets 必须包含至少一个有效的子 Agent 编号。');
			}
		} else if (field === 'fork_turns') {
			if (value !== 'all' && value !== 'none') throw new Error('fork_turns 必须是 all 或 none。');
		} else if (!spec.required.includes(field)) {
			requiredText(args, field);
		}
	}
	if (name === 'spawn_agent' && args.agent_type && args.system_instructions) {
		throw new Error('请选择已有角色或填写临时系统提示词。');
	}
	if (name === 'review_subagent_result') {
		if (!['use', 'defer', 'revise', 'blocked'].includes(String(args.decision))) throw new Error('无效的验收决定。');
		if (args.decision === 'revise' || args.decision === 'blocked') requiredText(args, 'reason');
		if (args.decision === 'revise') {
			requiredText(args, 'error_key');
			requiredText(args, 'message');
		}
	}
	return args;
}

export const subagentTools: ToolModule = () => [...specs.map(({ name, description, properties, required }): ToolDefinition => ({
	name,
	description,
	isReadOnly: true,
	inputSchema: { type: 'object', properties, required, additionalProperties: false },
	prepare(input, { subagents, signal }) {
		if (!subagents || !subagentToolVisible(name, subagents)) throw new Error('当前任务无法使用此子 Agent 操作。');
		const args = parseSubagentToolInput(name, input);
		return { run: () => subagents.execute(name, args, signal) };
	},
})), ...Array.from(groups, ([name, { description, actions }]): ToolDefinition => ({
	name,
	description,
	isReadOnly: true,
	inputSchema: groupedSchema(actions),
	prepare(input, { subagents, signal }) {
		const action = groupedAction({ name, input });
		if (!action) throw new Error('未知的子 Agent 操作。');
		if (!subagents || !actionAllowed(action, subagents)) throw new Error('当前任务无法使用此子 Agent 操作。');
		const args = fileToolInput(input, ['action', ...action.fields]);
		const fields = Object.fromEntries(action.fields.map((field) => [field, requiredText(args, field)]));
		return { run: () => subagents.execute(action.operation, fields, signal) };
	},
}))];
