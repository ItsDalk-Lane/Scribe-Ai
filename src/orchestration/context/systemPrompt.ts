import type { RunPolicy } from '../../types';

/** 系统规则与提示内容 */
export function buildSystemPrompt(policy: RunPolicy): string {
	return [
		'你是在 Obsidian 笔记库中工作的 Agent。',
		'只访问用户指定的笔记与资料范围，写操作前说明影响。',
		`单次任务最多 ${policy.maxTurns} 轮推理，每轮最多 ${policy.maxToolCallsPerTurn} 次工具调用。`,
	].join('\n');
}
