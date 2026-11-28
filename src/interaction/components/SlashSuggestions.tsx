import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { SkillInfo, TaskTarget } from '../../types';
import { isImeComposing } from '../composerKeyboard';
import { updateOverflowTitle } from '../overflowTitle';
import { slashCommandIcons, slashCommandSubmenus } from '../slashCommandMeta';
import { slashCommandText } from '../slashCommandText';
import type { SlashCommandText } from '../slashCommandText';
import {
	completeSlashCommand, getSlashCommand, parseSlashCommand, readSlashDraft, slashCommandAllowed, slashCommandArguments,
	slashCommandMatches, slashCommandQuery, slashGoalActions, slashSearchMatch, slashTargetCommand, slashTargetMatches,
} from '../slashCommands';
import type { SlashCommand, SlashCommandSurface, SlashSubcommand, SlashTargetChoice } from '../slashCommands';
import { presetLabel } from '../slashPresets';
import type { Preset } from '../slashPresets';
import type { SlashUi } from '../slashUi';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';
import { useComposerPopoverPosition } from './useComposerPopoverPosition';

export interface SlashSuggestionOptions {
	surface: SlashCommandSurface;
	run: (command: SlashCommand, ui: SlashUi, preserveDraft: boolean) => void;
	unavailable: (command: SlashCommand) => string | undefined;
	focusInput?: () => void;
	getPresets?: () => readonly (Preset | undefined)[];
	getSubcommands?: () => readonly SlashSubcommand[];
	getTargets?: () => readonly SlashTargetChoice[];
	selectTarget?: (target: TaskTarget, tokenEnd: number) => void;
	goalActions?: boolean;
}

export interface SlashLauncher {
	id: string;
	open: boolean;
	close: () => void;
}

interface Choice {
	label: string;
	description?: string;
	reason?: string;
	icon?: string;
	submenu?: boolean;
	command?: SlashCommand;
	complete?: () => { instruction: string; caret: number };
	apply?: () => void;
}

interface PanelBase {
	title: string;
	resolve: (value: unknown) => void;
	backValue: unknown;
	closeValue: unknown;
}

type Panel =
	| PanelBase & { kind: 'choose'; items: (query: string) => readonly unknown[]; label: (item: unknown) => string; search: boolean }
	| PanelBase & { kind: 'prompt'; initial: string; multiline: boolean }
	| PanelBase & { kind: 'confirm'; message: string; confirmText?: string }
	| PanelBase & { kind: 'info'; lines: readonly string[] }
	| PanelBase & { kind: 'panel'; draw: (host: HTMLElement) => (() => void) | void }
	| PanelBase & { kind: 'custom'; draw: (host: HTMLElement, done: (value: unknown) => void) => (() => void) | void };

function argumentKey(command: SlashCommand, prefix: string) {
	return `args:${command.name}:${prefix}:${command.args}`;
}

function suggestions(instruction: string, caret: number, options: SlashSuggestionOptions, text: SlashCommandText,
	skills: readonly SkillInfo[], onChooseSkill: (item: SkillInfo, tokenEnd: number) => void) {
	const namedTargets = options.surface === 'main' && caret > 1 && instruction.startsWith('/')
		? slashTargetMatches(instruction, caret, options.getTargets?.() ?? []) : [];
	const targets = namedTargets.map(({ choice: { target, description, reason }, tokenEnd, exact }): Choice & { rank: number } => {
		const name = slashTargetCommand(target);
		const unavailable = options.unavailable({ name, args: '', argsStart: tokenEnd }) ?? reason;
		return {
			label: target.label, rank: exact ? 3 : 1, icon: slashCommandIcons[name],
			description: [text.commandLabel(name), description].filter(Boolean).join(' · '), reason: unavailable,
			apply: () => options.selectTarget?.(target, tokenEnd),
		};
	});
	const query = slashCommandQuery(instruction, caret);
	if (query) {
		const { prefix, tokenEnd } = query;
		const args = slashCommandArguments(instruction, tokenEnd);
		const exactCommand = getSlashCommand(prefix);
		const choices: (Choice & { rank: number })[] = slashCommandMatches(prefix, options.surface).map(({ name, token }) => {
			const command = { name, ...args };
			const label = text.commandLabel(name);
			return {
				label,
				rank: name === exactCommand ? 4 : 2,
				description: text.describe(name),
				icon: slashCommandIcons[name],
				submenu: Boolean(slashCommandSubmenus[name]),
				reason: options.unavailable(command),
				command,
				complete: () => completeSlashCommand(instruction, tokenEnd, /\s/u.test(label) ? token : label || token),
			};
		});
		if (prefix && slashCommandAllowed('skills', options.surface)) {
			const reason = options.unavailable({ name: 'skills', args: '', argsStart: tokenEnd });
			for (const item of skills) {
				if (!item.enabled || !item.manual) continue;
				const match = slashSearchMatch(prefix, item.name, item.displayName);
				if (!match) continue;
				choices.push({
					label: item.displayName || item.name, rank: match === 2 ? 3 : 1,
					description: `${text.commandLabel('skills')} · ${item.sourceLabel}`,
					icon: slashCommandIcons.skills, reason, apply: () => onChooseSkill(item, tokenEnd),
				});
			}
		}
		if (prefix && !args.args && options.surface === 'main') {
			const add = (command: SlashCommand, label: string, keywords: readonly string[] = [], complete?: Choice['complete']) => {
				const match = slashSearchMatch(prefix, label, ...keywords);
				if (!match) return;
				choices.push({ label, rank: match === 2 ? 3 : 1, icon: slashCommandIcons[command.name],
					description: text.commandLabel(command.name), reason: options.unavailable(command), command, complete });
			};
			const presets = options.getPresets?.();
			if (presets?.includes(undefined)) add({ name: 'presets', ...args, subcommand: 'new' }, text.newPreset, ['new-preset']);
			presets?.forEach((preset, presetIndex) => {
				if (!preset || (readSlashDraft(preset.content) && !parseSlashCommand(preset.content))) return;
				const label = presetLabel(preset);
				add({ name: 'presets', ...args, presetIndex }, label, [label.replace(/^\//u, '')]);
			});
			for (const value of options.goalActions ? slashGoalActions : []) {
				add({ name: 'goal', ...args, args: value }, text.goalActionLabel(value), [value],
					() => completeSlashCommand(instruction, tokenEnd, `${text.commandLabel('goal')} ${value}`));
			}
			for (const { name, subcommand, label, keywords } of options.getSubcommands?.() ?? []) {
				add({ name, ...args, subcommand }, label, keywords);
			}
		}
		choices.push(...targets);
		choices.sort((left, right) => right.rank - left.rank);
		return { key: `name:${prefix}`, choices };
	}

	const command = parseSlashCommand(instruction);
	if (!command && targets.length) return { key: `target:${instruction.slice(0, caret)}`, choices: targets.sort((a, b) => b.rank - a.rank) };
	if (!command || !slashCommandAllowed(command.name, options.surface) || caret < command.argsStart
		|| /\s/u.test(instruction.slice(command.argsStart))) return;
	const queryArg = instruction.slice(command.argsStart, caret).toLowerCase();
	const available = command.name === 'goal' ? slashGoalActions : [];
	const matching: { value: string; description?: string }[] = available.filter((value) => value.startsWith(queryArg))
		.map((value) => ({ value, description: undefined }));
	const exact = matching.findIndex(({ value }) => value.toLowerCase() === queryArg);
	if (exact > 0) matching.unshift(...matching.splice(exact, 1));
	const choices: Choice[] = matching.map(({ value, description }) => ({
		label: value,
		description,
		complete: () => {
			const next = instruction.slice(0, command.argsStart) + value;
			return { instruction: next, caret: next.length };
		},
	}));
	return { key: argumentKey(command, queryArg), choices };
}

function SlashPanelView({ panel, settle, text }: {
	panel: Panel;
	settle: (value: unknown, close: boolean) => void;
	text: SlashCommandText;
}) {
	const labels = uiText();
	const [value, setValue] = useState(panel.kind === 'prompt' ? panel.initial : '');
	const [filter, setFilter] = useState('');
	const root = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
	const filterField = useRef<HTMLInputElement>(null);
	const host = useRef<HTMLDivElement>(null);
	const back = () => settle(panel.backValue, false);
	const close = () => settle(panel.closeValue, true);

	useEffect(() => {
		setValue(panel.kind === 'prompt' ? panel.initial : '');
		setFilter('');
		if (panel.kind === 'prompt') {
			field.current?.focus();
			field.current?.select();
		} else if (panel.kind === 'choose' && panel.search) {
			filterField.current?.focus();
		} else {
			root.current?.focus({ preventScroll: true });
		}
	}, [panel]);

	useEffect(() => {
		if (!host.current) return;
		if (panel.kind === 'custom') return panel.draw(host.current, (next) => settle(next, false));
		if (panel.kind === 'panel') return panel.draw(host.current);
	}, [panel, settle]);

	function accept() {
		settle(panel.kind === 'prompt' && !panel.multiline ? value.trim() : value.trimEnd(), false);
	}

	return <div ref={root} className="scribe-slash-panel" role="dialog" aria-label={panel.title} tabIndex={-1}
		onKeyDown={(event) => {
			if (event.key !== 'Escape' || isImeComposing(event.nativeEvent)) return;
			event.preventDefault();
			event.stopPropagation();
			back();
		}}>
		<div className="scribe-slash-panel-head">
			<button type="button" aria-label={text.back} title={text.back} onClick={back}><ChatIcon name="arrow-left" /></button>
			<span className="scribe-slash-panel-title">{panel.title}</span>
			<button type="button" aria-label={text.close} title={text.close} onClick={close}><ChatIcon name="x" /></button>
		</div>
		{panel.kind === 'choose' && <>
			{panel.search && <input ref={filterField} className="scribe-slash-panel-field" type="search" value={filter}
				aria-label={panel.title} placeholder={panel.title} onChange={(event) => setFilter(event.currentTarget.value)} />}
			<div className="scribe-slash-panel-list">
				{panel.items(filter)
					.map((item, index) => <button key={index} type="button" className="scribe-slash-row"
						onClick={() => settle(item, false)}>
						<span className="scribe-slash-name">{panel.label(item)}</span>
					</button>)}
			</div>
		</>}
		{panel.kind === 'prompt' && <>
			{panel.multiline
				? <textarea ref={(node) => { field.current = node; }} className="scribe-slash-panel-field" rows={5}
					aria-label={panel.title} value={value} onChange={(event) => setValue(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key !== 'Enter' || isImeComposing(event.nativeEvent) || (!event.metaKey && !event.ctrlKey)) return;
						event.preventDefault();
						accept();
					}} />
				: <input ref={(node) => { field.current = node; }} className="scribe-slash-panel-field" type="text"
					aria-label={panel.title} value={value} onChange={(event) => setValue(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key !== 'Enter' || isImeComposing(event.nativeEvent)) return;
						event.preventDefault();
						accept();
					}} />}
			<div className="scribe-slash-panel-actions">
				<button type="button" onClick={back}>{labels.cancel}</button>
				<button type="button" className="mod-cta" onClick={accept}>{labels.save}</button>
			</div>
		</>}
		{panel.kind === 'confirm' && <>
			<p className="scribe-slash-panel-message">{panel.message}</p>
			<div className="scribe-slash-panel-actions">
				<button type="button" onClick={back}>{labels.cancel}</button>
				<button type="button" className="mod-cta" onClick={() => settle(true, false)}>{panel.confirmText ?? labels.save}</button>
			</div>
		</>}
		{panel.kind === 'info' && <div className="scribe-slash-panel-info">
			{panel.lines.map((line, index) => <p key={index}>{line}</p>)}
		</div>}
		{(panel.kind === 'custom' || panel.kind === 'panel') && <div ref={host} className="scribe-slash-panel-custom" />}
	</div>;
}

export function useSlashSuggestions({
	instruction, caret, options, launcher, skills, onChooseSkill, onComplete,
}: {
	instruction: string;
	caret: number | null;
	options?: SlashSuggestionOptions;
	launcher?: SlashLauncher;
	skills: readonly SkillInfo[];
	onChooseSkill: (item: SkillInfo, tokenEnd: number) => void;
	onComplete: (instruction: string, caret: number) => void;
}) {
	const text = slashCommandText();
	const generatedId = useId();
	const id = launcher?.id ?? generatedId;
	const list = useRef<HTMLDivElement>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const focusInputRef = useRef(options?.focusInput);
	if (options?.focusInput) focusInputRef.current = options.focusInput;
	const instructionRef = useRef(instruction);
	instructionRef.current = instruction;
	const manual = launcher?.open === true;
	const queryCaret = manual ? 1 : caret;
	const current = options && queryCaret !== null
		? suggestions(manual ? '/' : instruction, queryCaret, options, text, skills, onChooseSkill) : undefined;
	const key = manual ? 'launcher' : current?.key;
	const [selection, setSelection] = useState<{ key: string | undefined; index: number; dismissed: boolean }>({
		key, index: -1, dismissed: false,
	});
	const [closedInput, setClosedInput] = useState<string | null>(null);
	const [panel, setPanel] = useState<Panel | null>(null);
	const panelRef = useRef<Panel | null>(null);
	if (selection.key !== key) setSelection({ key, index: -1, dismissed: false });
	useEffect(() => setClosedInput(null), [instruction]);

	const settlePanel = useCallback((value: unknown, close: boolean) => {
		const currentPanel = panelRef.current;
		if (!currentPanel) return;
		panelRef.current = null;
		setPanel(null);
		if (close) setClosedInput(instructionRef.current);
		focusInputRef.current?.();
		currentPanel.resolve(value);
	}, []);

	useEffect(() => () => {
		const currentPanel = panelRef.current;
		if (!currentPanel) return;
		panelRef.current = null;
		currentPanel.resolve(currentPanel.backValue);
	}, []);

	function pushPanel(next: Panel) {
		if (panelRef.current) settlePanel(panelRef.current.backValue, false);
		panelRef.current = next;
		setPanel(next);
	}

	const ui: SlashUi = {
		choose: <T,>(title: string, items: readonly T[] | ((query: string) => readonly T[]), label: (item: T) => string,
			search = typeof items === 'function') => new Promise<T | undefined>((resolve) => {
			pushPanel({
				kind: 'choose', title, label: (item) => label(item as T), search,
				items: typeof items === 'function' ? items : (filter) => items.filter((item) =>
					!filter || label(item).toLowerCase().includes(filter.toLowerCase())),
				backValue: undefined, closeValue: undefined, resolve: (value) => resolve(value as T | undefined),
			});
		}),
		prompt: (title, initial = '', multiline = false) => new Promise<string | undefined>((resolve) => {
			pushPanel({
				kind: 'prompt', title, initial, multiline, backValue: undefined, closeValue: undefined,
				resolve: (value) => resolve(value as string | undefined),
			});
		}),
		confirm: (title, message, confirmText) => new Promise<boolean>((resolve) => {
			pushPanel({
				kind: 'confirm', title, message, confirmText, backValue: false, closeValue: false,
				resolve: (value) => resolve(Boolean(value)),
			});
		}),
		show: (title, lines) => new Promise<boolean>((resolve) => {
			pushPanel({
				kind: 'info', title, lines, backValue: false, closeValue: true,
				resolve: (value) => resolve(Boolean(value)),
			});
		}),
		panel: (title, draw) => new Promise<boolean>((resolve) => {
			pushPanel({
				kind: 'panel', title, draw, backValue: false, closeValue: true,
				resolve: (value) => resolve(Boolean(value)),
			});
		}),
		custom: <T,>(title: string, draw: (host: HTMLElement, done: (value: T | undefined) => void) => (() => void) | void) =>
			new Promise<T | undefined>((resolve) => {
				pushPanel({
					kind: 'custom', title, draw: (host, done) => draw(host, done),
					backValue: undefined, closeValue: undefined, resolve: (value) => resolve(value as T | undefined),
				});
			}),
	};

	const visible = Boolean(panel)
		|| Boolean(current?.choices.length && (manual || (selection.key !== key || !selection.dismissed) && closedInput !== instruction));
	const choices = panel || !visible ? [] : current?.choices ?? [];
	const enabled = choices.flatMap(({ reason }, index) => reason ? [] : [index]);
	const index = selection.key === key && enabled.includes(selection.index) ? selection.index : enabled[0] ?? 0;
	const selected = choices[index];
	const activeId = visible && selected && !panel ? `${id}-${index}` : undefined;
	useEffect(() => {
		if (panel) return;
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [activeId, key, panel]);
	useComposerPopoverPosition(list, visible);

	function dismiss() {
		launcher?.close();
		if (panelRef.current) settlePanel(panelRef.current.closeValue, true);
		setSelection({ key, index: -1, dismissed: true });
		setClosedInput(instruction);
	}

	function choose(choice: Choice, complete: boolean) {
		if (choice.reason) return;
		if (choice.apply) {
			choice.apply();
			return;
		}
		if (choice.command && (!complete || choice.command.name === 'skills')) {
			if (manual) dismiss();
			options?.run(choice.command, ui, manual);
			return;
		}
		const next = choice.complete?.();
		if (!next) return;
		if (manual) launcher?.close();
		onComplete(next.instruction, next.caret);
		const completed = !choice.command && parseSlashCommand(next.instruction);
		if (completed) setSelection({ key: argumentKey(completed, completed.args.toLowerCase()), index: -1, dismissed: true });
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
		if (panel) {
			if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event.nativeEvent)) return false;
			event.preventDefault();
			event.stopPropagation();
			settlePanel(panel.backValue, false);
			return true;
		}
		if (!visible || event.defaultPrevented || isImeComposing(event.nativeEvent) || event.shiftKey || event.altKey || event.metaKey) return false;
		const up = event.ctrlKey ? event.key === 'p' : event.key === 'ArrowUp';
		const down = event.ctrlKey ? event.key === 'n' : event.key === 'ArrowDown';
		if (event.ctrlKey && !up && !down) return false;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			dismiss();
		} else if (up || down) {
			event.preventDefault();
			if (enabled.length) {
				const step = down ? 1 : -1;
				const next = enabled[(enabled.indexOf(index) + step + enabled.length) % enabled.length]!;
				setSelection({ key, index: next, dismissed: false });
			}
		} else if (selected && (event.key === 'Tab' || (event.key === 'Enter' && (selected.command || selected.apply)))) {
			if (manual && instruction && event.key === 'Tab') return false;
			if (event.key === 'Tab' && (selected.reason || !selected.complete && !selected.apply)) return false;
			event.preventDefault();
			if (!event.repeat) choose(selected, event.key === 'Tab');
		} else return false;
		return true;
	}

	return {
		activeId, id: visible ? id : undefined, dismiss, onKeyDown, ui,
		menu: visible && <div ref={list} id={id} role={panel ? undefined : 'listbox'} aria-label={panel ? undefined : text.label}
			className="scribe-context-popover scribe-slash-suggestions">
			{panel ? <SlashPanelView panel={panel} settle={settlePanel} text={text} /> : choices.map((choice, row) =>
				<button key={`${choice.command?.name ?? choice.label}:${row}`} type="button" tabIndex={-1} role="option"
					id={`${id}-${row}`} aria-selected={row === index} aria-disabled={Boolean(choice.reason)}
					onPointerEnter={({ currentTarget }) => updateOverflowTitle(currentTarget, currentTarget.querySelector('small'))}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => choose(choice, !choice.command)}>
					{choice.icon && <ChatIcon name={choice.icon} />}
					<span className="scribe-slash-name">{choice.label}</span>
					{(choice.reason || choice.description) && <small>{choice.reason || choice.description}</small>}
					{choice.submenu && <ChatIcon name="chevron-right" />}
				</button>)}
		</div>,
	};
}
