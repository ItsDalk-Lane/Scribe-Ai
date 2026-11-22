import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	completeSlashCommand, getSlashCommand, parseSlashCommand, readSlashDraft, slashCommandAcceptsArgs, slashCommandAllowed,
	slashCommandMatches, slashCommandQuery,
} from '../slashCommands';
import { editSkillText, sliceSkillMentions } from '../components/skillMentionText';

void test('slash commands recognize aliases and keep the original argument offsets', () => {
	const input = '/btw  先看 📓\n$edit ';
	const command = parseSlashCommand(input)!;
	assert.deepEqual(command, { name: 'side', args: '先看 📓\n$edit', argsStart: 6 });
	const mention = { id: 'local', name: 'edit', start: input.indexOf('$'), end: input.indexOf('$') + 5 };
	assert.equal(sliceSkillMentions({ instruction: input, skillMentions: [mention] }, command.argsStart, input.length)[0]?.start,
		command.args.indexOf('$'));
	assert.equal(parseSlashCommand('/exit')?.name, 'quit');
	assert.equal(parseSlashCommand('/clean')?.name, 'stop');
	assert.equal(parseSlashCommand('/subagents')?.name, 'multi-agents');
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
	assert.equal(getSlashCommand('背景任務'), 'ps');
	assert.deepEqual(parseSlashCommand('/预设 1'), { name: 'presets', args: '1', argsStart: 4 });
	assert.equal(slashCommandMatches('技', 'main')[0]?.name, 'skills');
	assert.equal(slashCommandMatches('狀態', 'main')[0]?.name, 'status');
	assert.deepEqual(slashCommandQuery('/预设', 3), { prefix: '预设', tokenEnd: 3 });
});

void test('model and permissions are not slash commands', () => {
	for (const token of ['model', '模型', 'permissions', '权限', '權限']) assert.equal(getSlashCommand(token), undefined);
	assert.equal(parseSlashCommand('/模型 gpt-5'), undefined);
	assert.deepEqual(slashCommandMatches('模型', 'main'), []);
});

void test('the popup promotes exact matches, shows aliases on search and respects side chat limits', () => {
	assert.equal(slashCommandMatches('RE', 'main')[0]?.token, 'review');
	assert.equal(slashCommandMatches('RECAP', 'main')[0]?.token, 'recap');
	assert.equal(slashCommandMatches('bt', 'main')[0]?.name, 'side');
	assert.equal(slashCommandMatches('', 'main').some(({ token }) => token === 'exit'), false);
	assert.deepEqual(slashCommandMatches('', 'side').map(({ name }) => name), ['skills', 'copy', 'export', 'mention', 'status', 'warnings']);
	assert.equal(slashCommandAllowed('side', 'side'), false);
	assert.equal(slashCommandAllowed('skills', 'side'), true);
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
	assert.deepEqual(completeSlashCommand('/co', 3, 'copy'), { instruction: '/copy ', caret: 6 });
});
