import { slashCommandLabels } from './slashCommandMeta';

const commandNames = [
	'presets', 'approve', 'skills', 'review', 'rename', 'new', 'archive', 'delete', 'resume',
	'fork', 'init', 'compact', 'config', 'recap', 'plan', 'goal', 'agents', 'side', 'copy', 'export', 'diff', 'mention',
	'status', 'warnings', 'usage', 'quit', 'ps', 'stop', 'clear', 'multi-agents',
] as const;

export type SlashCommandName = typeof commandNames[number];
export type SlashCommandSurface = 'main' | 'side';

const aliases: Readonly<Record<string, SlashCommandName>> = {
	btw: 'side', clean: 'stop', exit: 'quit', subagents: 'multi-agents',
};

const localizedNames = Object.fromEntries(commandNames.flatMap((name) =>
	slashCommandLabels[name].map((label) => [label.toLowerCase(), name]))) as Readonly<Record<string, SlashCommandName>>;
const sideCommands = new Set<SlashCommandName>(['skills', 'copy', 'export', 'mention', 'status', 'warnings']);
const acceptsArgs = new Set<SlashCommandName>([
	'review', 'rename', 'new', 'resume', 'fork', 'plan', 'goal', 'side', 'export', 'clear',
]);

export interface SlashCommand {
	name: SlashCommandName;
	args: string;
	argsStart: number;
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
