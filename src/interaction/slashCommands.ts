import type { TaskTarget } from '../types';
import { slashCommandLabels } from './slashCommandMeta';

const commandNames = [
	'clear', 'side', 'plan', 'goal', 'config', 'compact', 'skills', 'mcp', 'agents', 'presets',
	'recap', 'export', 'review', 'diff', 'approve', 'warnings',
] as const;

export type SlashCommandName = typeof commandNames[number];
export type SlashCommandSurface = 'main' | 'side';

const aliases: Readonly<Record<string, SlashCommandName>> = {
	btw: 'side',
	subagents: 'agents',
};

const localizedNames = Object.fromEntries(commandNames.flatMap((name) =>
	slashCommandLabels[name].map((label) => [label.toLowerCase(), name]))) as Readonly<Record<string, SlashCommandName>>;
const sideCommands = new Set<SlashCommandName>(['skills', 'mcp', 'export', 'warnings']);
const acceptsArgs = new Set<SlashCommandName>([
	'review', 'plan', 'goal', 'side', 'export', 'clear',
]);
export const slashGoalActions = ['clear', 'edit', 'pause', 'resume'] as const;

export interface SlashCommand {
	name: SlashCommandName;
	args: string;
	argsStart: number;
	subcommand?: string;
	presetIndex?: number;
}

export interface SlashSubcommand {
	name: SlashCommandName;
	subcommand: string;
	label: string;
	keywords?: readonly string[];
}

export interface SlashTargetChoice {
	target: TaskTarget;
	description?: string;
	reason?: string;
}

export function slashTargetCommand(target: TaskTarget): 'mcp' | 'agents' {
	return target.kind === 'mcp' ? 'mcp' : 'agents';
}

export function slashTargetMatches(instruction: string, caret: number, targets: readonly SlashTargetChoice[]) {
	if (!/^\/[^\s/]/u.test(instruction) || caret <= 1) return [];
	const typed = instruction.slice(1, caret).toLowerCase();
	const matches = targets.flatMap((choice) => {
		const { label } = choice.target;
		if (label.includes('/')) return [];
		const name = label.toLowerCase();
		const end = label.length + 1;
		const rest = instruction.slice(end);
		if (instruction.slice(1, end).toLowerCase() === name && (!rest || /^\s/u.test(rest))) {
			return [{ choice, tokenEnd: end, exact: caret >= end }];
		}
		if (!name.startsWith(typed)) return [];
		const tail = /^[^\s/]*/u.exec(instruction.slice(caret))?.[0] ?? '';
		return [{ choice, tokenEnd: caret + tail.length, exact: false }];
	});
	const exactEnd = Math.max(0, ...matches.filter(({ exact }) => exact).map(({ tokenEnd }) => tokenEnd));
	return matches.filter(({ exact, tokenEnd }) => !exact || tokenEnd === exactEnd);
}

export interface SlashCommandChoice {
	name: SlashCommandName;
	token: string;
}

export function getSlashCommand(token: string): SlashCommandName | undefined {
	const name = token.toLowerCase();
	if ((commandNames as readonly string[]).includes(name)) return name as SlashCommandName;
	if (Object.prototype.hasOwnProperty.call(aliases, name)) return aliases[name];
	return Object.prototype.hasOwnProperty.call(localizedNames, name) ? localizedNames[name] : undefined;
}

export function slashCommandAllowed(name: SlashCommandName, surface: SlashCommandSurface): boolean {
	return surface === 'main' || sideCommands.has(name);
}

export function slashCommandAcceptsArgs(name: SlashCommandName): boolean {
	return acceptsArgs.has(name);
}

export function slashCommandArguments(input: string, tokenEnd: number) {
	const rest = input.slice(tokenEnd).trimStart();
	return { args: rest.trimEnd(), argsStart: input.length - rest.length };
}

export function readSlashDraft(input: string) {
	const match = /^\/([^\s/]+)(?=\s|$)/u.exec(input);
	if (!match) return;
	const token = match[1]!;
	const tokenEnd = match[0].length;
	return { token, tokenEnd, ...slashCommandArguments(input, tokenEnd) };
}

export function parseSlashCommand(input: string): SlashCommand | undefined {
	const draft = readSlashDraft(input);
	const name = draft && getSlashCommand(draft.token);
	if (draft && name) return { name, args: draft.args, argsStart: draft.argsStart };
	return undefined;
}

export function slashCommandMatches(prefix: string, surface: SlashCommandSurface): SlashCommandChoice[] {
	const query = prefix.toLowerCase();
	const labels = (name: SlashCommandName) => slashCommandLabels[name].map((label) => label.toLowerCase());
	const items: SlashCommandChoice[] = commandNames.flatMap((name) => slashCommandAllowed(name, surface)
		&& (name.startsWith(query) || labels(name).some((label) => label.startsWith(query))) ? [{ name, token: name }] : []);
	if (query) {
		for (const [token, name] of Object.entries(aliases)) {
			if (slashCommandAllowed(name, surface) && token.startsWith(query)) items.push({ name, token });
		}
	}
	const exact = items.findIndex(({ name, token }) => token === query || labels(name).includes(query));
	if (exact > 0) items.unshift(...items.splice(exact, 1));
	return items;
}

export function slashSearchMatch(query: string, ...names: (string | undefined)[]): number {
	const prefix = query.toLowerCase();
	if (!prefix) return 0;
	const labels = names.map((name) => name?.toLowerCase());
	if (labels.includes(prefix)) return 2;
	return labels.some((label) => label?.startsWith(prefix)) ? 1 : 0;
}

export function slashCommandQuery(input: string, caret: number) {
	const match = /^\/([^\s/]*)(?=\s|$)/u.exec(input);
	if (!match) return;
	const tokenEnd = match[0].length;
	if (caret >= 1 && caret <= tokenEnd) return { prefix: input.slice(1, caret), tokenEnd };
	return undefined;
}

export function completeSlashCommand(input: string, tokenEnd: number, token: string) {
	const prefix = `/${token}`;
	const suffix = input.slice(tokenEnd);
	const spacer = /^\s/u.test(suffix) ? '' : ' ';
	return { instruction: prefix + spacer + suffix, caret: prefix.length + 1 };
}
