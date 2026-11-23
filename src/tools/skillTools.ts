import { listCuratedSkills } from '../skills/library/github';
import type { SkillRun, ToolDefinition } from '../types';
import { fileToolInput, requiredText } from './support/fileAccess';

const text = { type: 'string' };
const offset = { type: 'integer', minimum: 0 };
interface SkillTool {
	name: string;
	description: string;
	fields: Record<string, typeof text>;
	required?: string[];
	write?: boolean;
	run(skills: SkillRun, input: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}
function page(input: Record<string, unknown>) {
	const value = input.offset ?? 0;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('页码无效。');
	return value;
}

const definitions: SkillTool[] = [
	{ name: 'list_skills', description: '列出当前任务可调用的技能及本轮短标识。可用 offset 翻页。', fields: { offset },
		run: (s, a) => s.list(page(a)) },
	{ name: 'read_skill', description: '按技能标识（技能清单第二项，不是技能名称）读取操作说明，或按技能目录内的相对路径读取配套文本。续读请传回 offset 与 digest。',
		fields: { id: text, file: text, offset, digest: text }, required: ['id'],
		run: (s, a) => s.read(requiredText(a, 'id'), a.file === undefined ? 'SKILL.md' : requiredText(a, 'file'), page(a), typeof a.digest === 'string' ? a.digest : undefined) },
	{ name: 'list_skill_files', description: '列出一个已授权技能随附的资料、模板和脚本名称。', fields: { id: text }, required: ['id'],
		run: (s, a) => s.files(requiredText(a, 'id')) },
	{ name: 'propose_skill', description: '把完整的 SKILL.md 草稿交给用户检查、修改并点击保存。', write: true, fields: { content: text }, required: ['content'],
		run: (s, a) => s.propose(requiredText(a, 'content')) },
	{ name: 'install_skill', description: '从官方精选名称或公开 GitHub 技能目录网址预览安装包，用户选择目标并确认后安装。', write: true,
		fields: { source: text }, required: ['source'], run: (s, a) => s.install(requiredText(a, 'source')) },
	{ name: 'list_curated_skills', description: '从 OpenAI 的公开 GitHub 精选目录获取可以安装的技能名称。', fields: {},
		async run(_s, _a, signal) {
			return (await listCuratedSkills(signal)).join('\n');
		} },
];

export const skillToolNames = new Set(definitions.map((tool) => tool.name));
export const readOnlySkillTools = ['list_skills', 'read_skill', 'list_skill_files'];
export function skillTools(): ToolDefinition[] {
	return definitions.map((def) => ({
		name: def.name, description: def.description, isReadOnly: !def.write,
		inputSchema: { type: 'object', properties: def.fields, required: def.required ?? [], additionalProperties: false },
		prepare(raw, ctx) {
			const skills = ctx.skillRun;
			if (!skills || !skills.canUse(def.name)) throw new Error('当前任务未启用这项技能操作。');
			const args = fileToolInput(raw, Object.keys(def.fields));
			return { independent: true, ...(def.write && !ctx.permissions.executionMode && { approval: { title: '审阅技能', target: def.description } }),
				run: () => def.run(skills, args, ctx.signal) };
		},
	}));
}
