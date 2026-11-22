import type { SubagentToolAccess, ToolModule } from '../types';
import { fileToolInput, requiredText } from './support/fileAccess';

const target = { type: 'string', description: '当前聊天中的子 Agent 编号。' };
const message = { type: 'string', description: '具体任务、补充信息或需要返回的结果。' };
const specs: { name: string; description: string; properties: Record<string, unknown>; required: string[] }[] = [{
	name: 'spawn_agent',
	description: '在后台启动子 Agent，返回用于协作的编号。把职责和期望结果说清楚。涉及修改时明确划分各自负责的文件或段落。',
	properties: {
		message,
		agent_type: { type: 'string', description: '匹配任务时指定已有角色。没有合适角色时，改用临时系统提示词。' },
		system_instructions: { type: 'string', description: '没有合适角色时，为本子 Agent 编写独立系统提示词，说明职责、方法和限制。不要与 agent_type 一起使用。任务说明另写在 message。' },
		nickname: { type: 'string', description: '便于在聊天中辨认任务的简短名称。' },
		model: { type: 'string', description: '用户明确指定时填写已配置的模型 ID，或使用「服务商 ID/模型 ID」指定服务商。' },
		reasoning_effort: { type: 'string', description: '用户明确指定时填写模型支持的思考档位。' },
		fork_turns: { type: 'string', enum: ['all', 'none'], description: 'all 继承可用聊天历史，none 仅传达本次分派。' },
	},
	required: ['message'],
}, {
	name: 'list_agents',
	description: '列出当前聊天中的子 Agent、身份和状态。',
	properties: {},
	required: [],
}, {
	name: 'send_message',
	description: '给现有子 Agent 补充信息。运行中的任务会在可接收时读取，空闲的子 Agent 保留消息并等待新任务。',
	properties: { target, message },
	required: ['target', 'message'],
}, {
	name: 'ask_parent',
	description: '仅供子 Agent 使用。发现任务说明与实际环境不符或缺少关键信息时，向派发方提出具体问题，等到答复再继续。不要猜测关键事实。',
	properties: { message },
	required: ['message'],
}, {
	name: 'answer_subagent',
	description: '回答子 Agent 发来的待回复问题。收到问题后优先核对并回答，再回到手上的其他工作。无法确认时如实说明能确认的范围。',
	properties: { question_id: { type: 'string', description: '收件信息中的问题编号。' }, message },
	required: ['question_id', 'message'],
}, {
	name: 'review_subagent_result',
	description: '逐项核对提交原文与任务和证据，再验收。合格且下一步要用选 use，合格但以后再用选 defer，不合格选 revise 并指明问题及修改要求，缺少资料无法验收时选 blocked。两次自动返工或连续同一关键错误后，应自己核对修正，否则标为未通过。',
	properties: {
		result_id: { type: 'string', description: '待核对提交的结果编号。每版独立编号。' },
		decision: { type: 'string', enum: ['use', 'defer', 'revise', 'blocked'] },
		reason: { type: 'string', description: '退回或无法通过的具体原因。' },
		error_key: { type: 'string', description: '选择 revise 时填写关键错误的短标识。同一错误反复出现时必须沿用原标识。' },
		message: { type: 'string', description: '选择 revise 时填写交给原子 Agent 的完整修改要求。' },
	},
	required: ['result_id', 'decision'],
}, {
	name: 'read_subagent_result',
	description: '按工作结果的专用路径读取本聊天的完整提交原文。核对大型结果或随后要用已暂存的结果时使用。',
	properties: { path: { type: 'string', description: '协作结果收到时列出的读取路径。' } },
	required: ['path'],
}, {
	name: 'followup_task',
	description: '把后续任务交给现有子 Agent。它会使用自己的历史，空闲时启动新一轮工作。',
	properties: { target, message },
	required: ['target', 'message'],
}, {
	name: 'wait_agent',
	description: '等待当前聊天的子 Agent 产生新消息或结果。到时只结束等待，已有子任务继续进行。需要结果再等待。',
	properties: {
		targets: { type: 'array', minItems: 1, items: target, description: '要等待的子 Agent 编号。省略时等待本聊天中的子 Agent。' },
		timeout_ms: { type: 'integer', minimum: 0, description: '等待毫秒数，默认 30000。' },
	},
	required: [],
}, {
	name: 'interrupt_agent',
	description: '中断子 Agent 当前的工作，保留聊天记录和后续继续工作的能力。',
	properties: { target },
	required: ['target'],
}, {
	name: 'close_agent',
	description: '关闭不再需要的子 Agent，释放并行名额并保留历史。',
	properties: { target },
	required: ['target'],
}, {
	name: 'resume_agent',
	description: '重新打开已关闭的子 Agent，保留其历史，可继续发送消息或追加任务。',
	properties: { target },
	required: ['target'],
}];

export const subagentToolNames = new Set(specs.map(({ name }) => name));

export function subagentToolVisible(name: string, access: SubagentToolAccess | undefined): boolean {
	return !subagentToolNames.has(name) || Boolean(access && (name !== 'spawn_agent' || access.canSpawn)
		&& (name !== 'ask_parent' || access.canAskParent));
}

export function parseSubagentToolInput(name: string, input: unknown): Record<string, unknown> {
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

export const subagentTools: ToolModule = () => specs.map(({ name, description, properties, required }) => ({
	name,
	description,
	isReadOnly: true,
	inputSchema: { type: 'object', properties, required, additionalProperties: false },
	prepare(input, { subagents, signal }) {
		if (!subagents || !subagentToolVisible(name, subagents)) throw new Error('当前任务无法使用此子 Agent 操作。');
		const args = parseSubagentToolInput(name, input);
		return { run: () => subagents.execute(name, args, signal) };
	},
}));
