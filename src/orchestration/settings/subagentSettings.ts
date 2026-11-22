import type { RunContext, SubagentRole, SubagentSettings } from '../../types';
import { isThinkingLevel } from './thinking';

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
	mode: 'auto',
	maxConcurrent: 6,
	maxDepth: 1,
	roles: [],
};

export const BUILTIN_SUBAGENT_ROLES: readonly SubagentRole[] = [
	{
		name: 'default',
		description: '处理没有专门角色的独立任务。',
		instructions: '完成分配给你的任务，把结果和仍需处理的问题交回给分派任务的 Agent。',
	},
	{
		name: 'worker',
		description: '完成范围明确的写作、整理或修改工作。',
		instructions: '只处理分配给你的范围。其他 Agent 可能正在同步工作，请保留他们的改动，并说明你完成的修改。',
	},
	{
		name: 'explorer',
		description: '搜索和核对资料，找出与问题直接相关的证据。',
		instructions: '以只读方式查找和核对资料。回答分配给你的具体问题，附上可验证的出处，不修改资料。',
	},
];

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function trimmed(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function normalizeSubagentRole(raw: unknown): SubagentRole | undefined {
	const { name: rawName, description: rawDescription, instructions: rawInstructions, model: rawModel, readOnly } = object(raw);
	const name = trimmed(rawName);
	const description = trimmed(rawDescription);
	const instructions = trimmed(rawInstructions);
	if (!/^[a-z][a-z0-9_-]*$/u.test(name) || !description || !instructions) return;
	const rawSelection = object(rawModel);
	const providerId = trimmed(rawSelection.providerId);
	const model = trimmed(rawSelection.model);
	let selection: RunContext['model'] | undefined;
	if (providerId && model) {
		selection = { providerId, model };
		if (rawSelection.reasoning === null || isThinkingLevel(rawSelection.reasoning)) selection.reasoning = rawSelection.reasoning;
	}
	return { name, description, instructions, ...(selection && { model: selection }), ...(readOnly === true && { readOnly: true }) };
}

export function normalizeSubagentSettings(raw: unknown): SubagentSettings {
	const { mode, maxConcurrent, maxDepth, roles: rawRoles } = object(raw);
	const roles = new Map<string, SubagentRole>();
	if (Array.isArray(rawRoles)) {
		for (const value of rawRoles) {
			const role = normalizeSubagentRole(value);
			if (role && !roles.has(role.name)) roles.set(role.name, role);
		}
	}
	return {
		mode: mode === 'auto' || mode === 'explicit' || mode === 'off' ? mode : DEFAULT_SUBAGENT_SETTINGS.mode,
		maxConcurrent: positiveInteger(maxConcurrent, DEFAULT_SUBAGENT_SETTINGS.maxConcurrent),
		maxDepth: positiveInteger(maxDepth, DEFAULT_SUBAGENT_SETTINGS.maxDepth),
		roles: Array.from(roles.values()),
	};
}
