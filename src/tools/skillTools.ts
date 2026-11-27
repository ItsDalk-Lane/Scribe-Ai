import { listCuratedSkills } from '../skills/library/github';
import type { SkillRun, ToolDefinition } from '../types';
import { fileToolInput, requiredText } from './support/fileAccess';

const text = { type: 'string' };
const offset = { type: 'integer', minimum: 0 };
interface SkillTool {
	name: string;
	description: string;
	fields: Record<string, typeof text & { description?: string }>;
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
	{ name: 'list_skills', description: '列出当前可用技能的名称、来源、用途和标识。用 offset 翻页，查看清单中省略的技能。用返回的技能标识填写 id 可列出配套文件名，此时省略 offset。', fields: { offset, id: text },
		run(skills, input) {
			if (input.id === undefined) return skills.list(page(input));
			if (input.offset !== undefined) throw new Error('列出技能文件时请省略 offset。');
			return skills.files(requiredText(input, 'id'));
		} },
	{ name: 'read_skill', description: '读取技能操作说明。需要配套文本时填写技能目录内的相对路径 file。续读请传回上一页给出的 offset 与 digest。',
		fields: {
			id: { type: 'string', description: '清单中的技能名称，也可填写 list_skills 返回的标识。' },
			source: { type: 'string', description: '同名时填写清单中的来源。若来源仍无法区分，改用 list_skills 返回的标识并省略 source。' },
			file: text, offset, digest: text,
		}, required: ['id'],
		run: (s, a) => s.read(requiredText(a, 'id'), a.file === undefined ? 'SKILL.md' : requiredText(a, 'file'), page(a),
			typeof a.digest === 'string' ? a.digest : undefined, a.source === undefined ? undefined : requiredText(a, 'source')) },
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
export const readOnlySkillTools = ['list_skills', 'read_skill'];

export function isSkillListing(name?: string) {
	return name === 'list_skills' || name === 'list_skill_files';
}

export function isSkillReadResult(name?: string) {
	return name === 'read_skill' || isSkillListing(name);
}

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
