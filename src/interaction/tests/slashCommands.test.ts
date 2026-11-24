import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	completeSlashCommand, getSlashCommand, parseSlashCommand, readSlashDraft, slashCommandAcceptsArgs, slashCommandAllowed,
	slashCommandMatches, slashCommandQuery, slashSearchMatch, slashTargetMatches,
} from '../slashCommands';
import { editSkillText, insertSkill, sliceSkillMentions } from '../components/skillMentionText';
import { clearLegacyPresets, readLegacyPresets, showSlashPresets } from '../slashPresets';
import type { Preset } from '../slashPresets';

void test('slash commands recognize aliases and keep the original argument offsets', () => {
	const input = '/btw  先看 📓\n$edit ';
	const command = parseSlashCommand(input)!;
	assert.deepEqual(command, { name: 'side', args: '先看 📓\n$edit', argsStart: 6 });
	const mention = { id: 'local', name: 'edit', start: input.indexOf('$'), end: input.indexOf('$') + 5 };
	assert.equal(sliceSkillMentions({ instruction: input, skillMentions: [mention] }, command.argsStart, input.length)[0]?.start,
		command.args.indexOf('$'));
	assert.equal(getSlashCommand('constructor'), undefined);
	assert.equal(getSlashCommand('__proto__'), undefined);
	assert.equal(slashCommandAcceptsArgs('plan'), true);
	assert.equal(slashCommandAcceptsArgs('skills'), false);
});

void test('unknown slash names can be rejected while ordinary text and nested paths stay literal', () => {
	assert.equal(readSlashDraft('/not-a-command 资料')?.token, 'not-a-command');
	assert.equal(parseSlashCommand('/not-a-command 资料'), undefined);
	for (const value of [' /goal 这里是正文', '用 /plan 就可以', '/Users/me/note.md', '//path', 'https://example.com/', '/']) {
		assert.equal(readSlashDraft(value), undefined);
	}
});

void test('localized command names parse and match without the English token', () => {
	assert.equal(getSlashCommand('预设'), 'presets');
	assert.equal(getSlashCommand('計畫模式'), 'plan');
	assert.deepEqual(parseSlashCommand('/预设 1'), { name: 'presets', args: '1', argsStart: 4 });
	assert.equal(slashCommandMatches('技', 'main')[0]?.name, 'skills');
	assert.equal(slashCommandMatches('計', 'main')[0]?.name, 'plan');
	assert.deepEqual(slashCommandQuery('/预设', 3), { prefix: '预设', tokenEnd: 3 });
});

void test('the preset menu offers a clear first action and reopens saved presets', async () => {
	let stored: (Preset | null)[] | undefined;
	const storage: Parameters<typeof showSlashPresets>[0] = {
		read: () => stored,
		save: (update) => { stored = update(stored ?? []); return Promise.resolve(); },
	};
	const menus: string[][] = [];
	const selections = ['新建预设', '2 · 总结笔记', '运行'];
	const ui: Parameters<typeof showSlashPresets>[1] = {
		choose: async (_title, items, label) => {
			menus.push(items.map(label));
			const selection = selections.shift();
			return items.find((item) => label(item) === selection);
		},
		prompt: async (_title, _initial, multiline) => {
			if (multiline) return '请总结这篇笔记。';
			// 模拟另一个聊天先保存了预设。
			stored = [{ label: '已有命令', content: '/warnings' }];
			return '总结笔记';
		},
		confirm: async () => false,
	};
	const tr = (zh: string) => zh;
	assert.equal(await showSlashPresets(storage, ui, tr), true);
	assert.equal(await showSlashPresets(storage, ui, tr), '请总结这篇笔记。');
	assert.deepEqual(menus, [['新建预设'], ['新建预设', '1 · 已有命令', '2 · 总结笔记'], ['运行', '编辑', '删除']]);
});

void test('the direct new preset shortcut opens its form and uses the latest free slot', async () => {
	const existing = { label: '已有预设', content: '/warnings' };
	const concurrent = { label: '同时保存的预设', content: '/skills' };
	let stored: (Preset | null)[] = [existing];
	const storage: Parameters<typeof showSlashPresets>[0] = {
		read: () => stored,
		save: (update) => { stored = update(stored); return Promise.resolve(); },
	};
	const ui: Parameters<typeof showSlashPresets>[1] = {
		choose: async () => assert.fail('Direct creation must skip the presets picker'),
		prompt: async (_title, _initial, multiline) => {
			if (multiline) return '请整理这段内容。';
			stored = [existing, concurrent];
			return '整理内容';
		},
		confirm: async () => false,
	};
	const tr = (zh: string) => zh;
	assert.equal(await showSlashPresets(storage, ui, tr, true), true);
	assert.deepEqual(stored.slice(0, 3), [existing, concurrent, { label: '整理内容', content: '请整理这段内容。' }]);
	stored = Array.from({ length: 10 }, () => existing);
	await assert.rejects(() => showSlashPresets(storage, { ...ui, prompt: async () => assert.fail('No preset slot is free') }, tr, true), /预设已满/u);
});

void test('旧预设导入保留原槽位，清理前仍可重复读取', () => {
	const preset = { label: '曾保存的预设', content: '/warnings' };
	let stored: unknown = [null, preset, null, { content: 123 }];
	const app = {
		loadLocalStorage: () => stored,
		saveLocalStorage: (_key: string, value: unknown) => { stored = value; },
	};
	assert.deepEqual(readLegacyPresets(app).slice(0, 4), [null, preset, null, null]);
	assert.deepEqual(stored, [null, preset, null, { content: 123 }]);
	clearLegacyPresets(app);
	assert.deepEqual(readLegacyPresets(app), Array.from({ length: 10 }, () => null));
});

void test('model and permissions are not slash commands', () => {
	for (const token of ['model', '模型', 'permissions', '权限', '權限']) assert.equal(getSlashCommand(token), undefined);
	assert.equal(parseSlashCommand('/模型 gpt-5'), undefined);
	assert.deepEqual(slashCommandMatches('模型', 'main'), []);
});

void test('the popup promotes exact matches, shows aliases on search and respects side chat limits', () => {
	assert.equal(slashCommandMatches('RE', 'main')[0]?.token, 'recap');
	assert.equal(slashCommandMatches('RECAP', 'main')[0]?.token, 'recap');
	assert.equal(slashCommandMatches('bt', 'main')[0]?.name, 'side');
	assert.deepEqual(slashCommandMatches('', 'main').map(({ name }) => name), [
		'clear', 'side', 'plan', 'goal', 'config', 'compact', 'skills', 'mcp', 'agents', 'presets', 'recap', 'export', 'review', 'diff', 'approve', 'warnings',
	]);
	assert.deepEqual(slashCommandMatches('', 'side').map(({ name }) => name), ['skills', 'mcp', 'export', 'warnings']);
	assert.equal(slashCommandAllowed('side', 'side'), false);
	assert.equal(slashCommandAllowed('skills', 'side'), true);
	assert.equal(parseSlashCommand('/mcp')?.name, 'mcp');
	assert.equal(slashCommandMatches('MCP 服', 'main')[0]?.name, 'mcp');
	assert.equal(slashCommandAllowed('mcp', 'side'), true);
	assert.equal(slashCommandAcceptsArgs('mcp'), false);
	assert.equal(parseSlashCommand('/agents')?.name, 'agents');
	assert.equal(parseSlashCommand('/subagents')?.name, 'agents');
	assert.deepEqual(slashCommandMatches('sub', 'main'), [{ name: 'agents', token: 'subagents' }]);
	assert.equal(slashCommandMatches('子 Agent', 'main')[0]?.name, 'agents');
	assert.equal(slashCommandAllowed('agents', 'side'), false);
	assert.equal(slashCommandAcceptsArgs('agents'), false);
});

void test('removed commands, their aliases, and their menu names cannot be run', () => {
	for (const token of ['new', 'copy', 'mention', 'status', 'usage', 'resume', 'init', 'quit', 'ps', 'stop', 'multi-agents', 'rename', 'fork',
		'clean', 'exit', 'Close', 'Jobs', '新聊天', '复制', '引用', '狀態', '用量', '恢復聊天', '初始化', '关闭聊天', '后台任务',
		'停止后台任务', '多助手', '子助理', '重命名', '建立聊天分支', 'archive', 'delete', '归档', '封存', '删除', '刪除']) {
		assert.equal(getSlashCommand(token), undefined, token);
		assert.equal(parseSlashCommand(`/${token}`), undefined, token);
	}
});

void test('completion is restricted to the first command token and preserves argument text and skill links', () => {
	assert.deepEqual(slashCommandQuery('/', 1), { prefix: '', tokenEnd: 1 });
	assert.equal(slashCommandQuery('/plan 📔', 7), undefined);
	assert.equal(slashCommandQuery('/tmp/a', 4), undefined);
	const original = '/pl\n$draw';
	const mention = { id: 'draw-vault', name: 'draw', start: 4, end: 9 };
	const query = slashCommandQuery(original, 3)!;
	const next = completeSlashCommand(original, query.tokenEnd, 'plan');
	assert.deepEqual(next, { instruction: '/plan\n$draw', caret: 6 });
	assert.deepEqual(editSkillText({ instruction: original, skillMentions: [mention] }, next.instruction, next.caret).skillMentions,
		[{ ...mention, start: 6, end: 11 }]);
	assert.deepEqual(completeSlashCommand('/co', 3, 'compact'), { instruction: '/compact ', caret: 9 });
});

void test('a slash skill search accepts either name and replaces only the slash token when selected', () => {
	const skill = { id: 'skill-from-notes', name: 'meeting-notes', displayName: '会议纪要', sourceLabel: '本地' };
	assert.equal(slashSearchMatch('MEET', skill.name, skill.displayName), 1);
	assert.equal(slashSearchMatch('会议', skill.name, skill.displayName), 1);
	assert.equal(slashSearchMatch('会议纪要', skill.name, skill.displayName), 2);
	assert.equal(slashSearchMatch('', skill.name, skill.displayName), 0);
	const instruction = '/meet 整理 $format';
	const mention = { id: 'format-from-vault', name: 'format', start: 9, end: 16 };
	const query = slashCommandQuery(instruction, 5)!;
	const next = insertSkill({ instruction, skillMentions: [mention] }, 0, query.tokenEnd, skill);
	assert.equal(next.instruction, '$meeting-notes 整理 $format');
	assert.equal(next.cursor, 15);
	assert.deepEqual(next.skillMentions, [
		{ id: skill.id, name: skill.name, sourceLabel: skill.sourceLabel, start: 0, end: 14 },
		{ ...mention, start: 18, end: 25 },
	]);
});


void test('slash shortcuts find named MCP services and subagents and preserve the task suffix', () => {
	const short = { target: { kind: 'mcp', id: 'short', label: '文档' } } as const;
	const service = { target: { kind: 'mcp', id: 'long', label: '文档 Search' } } as const;
	const role = { target: { kind: 'agent', id: 'worker', label: 'worker' } } as const;
	const choices = [short, service, role];
	assert.deepEqual(slashTargetMatches('/', 1, choices), []);
	assert.deepEqual(slashTargetMatches('/wor', 4, choices), [{ choice: role, tokenEnd: 4, exact: false }]);
	assert.deepEqual(slashTargetMatches('/文档 Se', 6, [service]), [{ choice: service, tokenEnd: 6, exact: false }]);
	const task = '/文档 search 整理 $format';
	const [match] = slashTargetMatches(task, task.length, choices);
	assert.deepEqual(match, { choice: service, tokenEnd: 10, exact: true });
	const source = task.indexOf('$');
	const mention = { id: 'notes', name: 'format', start: source, end: task.length };
	const remaining = task.slice(match?.tokenEnd).trimStart();
	assert.equal(remaining, '整理 $format');
	assert.deepEqual(editSkillText({ instruction: task, skillMentions: [mention] }, remaining, 0).skillMentions,
		[{ ...mention, start: 3, end: remaining.length }]);
	assert.deepEqual(slashTargetMatches('/worker-extra', 13, choices), []);
	assert.deepEqual(slashTargetMatches('/tmp/worker', 11, choices), []);
});
