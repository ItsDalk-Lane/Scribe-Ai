import { TFile, TFolder } from 'obsidian';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { SIDE_CHAT_ICON } from '../../constants';
import type { ExecutionMode, SkillInfo, SkillMention, SkillRegistry } from '../../types';
import { composerShortcut, sideChatCommand } from '../composerKeyboard';
import { parseSlashCommand, readSlashDraft, slashCommandAcceptsArgs, slashCommandAllowed } from '../slashCommands';
import type { SlashCommand, SlashCommandName, SlashCommandSurface } from '../slashCommands';
import type { SlashUi } from '../slashUi';
import { slashCommandText } from '../slashCommandText';
import { uiText } from '../uiText';
import type { ChatModelGroup } from '../useChatModel';
import ChatIcon from './ChatIcon';
import ChatModelPicker from './ChatModelPicker';
import ExecutionModePicker from './ExecutionModePicker';
import type { ThinkingSelection } from './ThinkingSlider';
import { ContextActions, ContextChips, useVaultPicker } from './ContextPicker';
import type { ContextPickerProps } from './ContextPicker';
import SkillTextArea, { skillMenuText } from './SkillTextArea';
import SlashSkillPanel from './SlashSkillPanel';
import { prepareSkillMentions } from './skillMentionText';

export interface SlashCommandUi {
	openSkills: () => Promise<boolean>;
	openMention: () => Promise<boolean>;
	ui: SlashUi;
}

interface TaskInputProps {
	inputRef: RefObject<HTMLTextAreaElement | null>;
	busy: boolean;
	disabled: boolean;
	conversationId: string | null;
	context: Omit<ContextPickerProps, 'disabled'>;
	contextMetric?: ReactNode;
	executionMode?: {
		value: ExecutionMode;
		queuePending: boolean;
		onChange: (mode: ExecutionMode, trigger: HTMLButtonElement) => void;
	};
	vaultOnly?: boolean;
	placeholder?: string;
	modelGroups: ChatModelGroup[];
	modelValue: string;
	modelSaving?: boolean;
	modelSelecting?: boolean;
	thinking: ThinkingSelection;
	error: string;
	instruction: string;
	skillMentions: SkillMention[];
	skills: SkillRegistry;
	skillScope?: string[];
	onChange: (instruction: string, skillMentions: SkillMention[], scope?: string[]) => void;
	onModelChange: (value: string) => Promise<boolean>;
	onThinkingChange: (level: string) => void;
	onSubmit: (instruction: string, mentions: SkillMention[], scope: string[]) => void;
	onStop: () => void;
	onNew?: () => void;
	queueDuringRun?: boolean;
	onContinueQueue?: () => void;
	queueContinuingDisabled?: boolean;
	onClose?: () => void;
	onResume?: () => void;
	slashCommands?: {
		surface: SlashCommandSurface;
		unavailable?: (name: SlashCommandName, args: string) => string | undefined;
		run: (command: SlashCommand, ui: SlashCommandUi) => Promise<boolean | void> | boolean | void;
	};
}

export default function TaskInput({
	inputRef, busy, disabled, conversationId, context, contextMetric, executionMode, vaultOnly, placeholder,
	modelGroups, modelValue, modelSaving = false, modelSelecting = false, thinking, error, instruction, skills, skillScope, skillMentions,
	onChange, onModelChange, onThinkingChange, onSubmit, onStop, queueDuringRun = false,
	onContinueQueue, queueContinuingDisabled, onNew, onClose, onResume, slashCommands,
}: TaskInputProps) {
	const text = uiText();
	const slashText = slashCommandText();
	const provider = modelGroups.find(({ models }) => models.some(({ value }) => value === modelValue))?.label;
	const disclosure = provider
		? text.chatSubmitDisclosure.replace('{provider}', () => provider)
		: text.chatModelMissing;
	const locked = busy || disabled;
	const [checking, setChecking] = useState(false);
	const [commandRunning, setCommandRunning] = useState(false);
	const [skillError, setSkillError] = useState('');
	const pending = useRef(false);
	const runningCommand = useRef(false);
	const draftRevision = useRef(0);
	const mounted = useRef(false);
	useLayoutEffect(() => { draftRevision.current++; }, [conversationId, instruction, skillMentions, skillScope]);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const busyWithoutQueue = busy && !queueDuringRun;
	const draftLocked = checking || disabled || (busyWithoutQueue && !slashCommands);
	const contextLocked = draftLocked || busyWithoutQueue;
	const slashDraft = slashCommands ? readSlashDraft(instruction) : undefined;
	const command = slashDraft && parseSlashCommand(instruction);
	const isSideCommand = command?.name === 'side' || (!slashCommands && queueDuringRun && sideChatCommand(instruction) !== null);
	const isSkillMenu = command?.name === 'skills' || (!slashCommands && instruction.trim() === '/skills');
	const menu = useRef<(() => void) | null>(null);
	const closeMenu = useRef<(() => void) | null>(null);
	const slashUi = useRef<SlashUi | null>(null);
	const modelTrigger = useRef<HTMLButtonElement>(null);
	const permissionsTrigger = useRef<HTMLButtonElement>(null);
	const blocked = disabled || commandRunning
		|| (slashDraft ? draftLocked : !isSideCommand && (contextLocked || (!isSkillMenu && (modelSaving || !modelValue || !instruction.trim()))));
	const actionLabel = busy ? text.chatStop : isSkillMenu ? skillMenuText().title : isSideCommand ? text.sideChatOpen : slashDraft ? slashText.run : text.submit;
	const queueHint = busy && queueDuringRun && !slashDraft ? text.queueEnterHint : undefined;
	const commandDescription = command ? slashText.describe(command.name) : slashDraft ? slashText.label : undefined;
	const actionDescription = busy ? queueHint : commandDescription ?? (isSkillMenu ? undefined : disclosure);
	const pick = useVaultPicker(context.app, context.onAdd);
	const focusInput = () => inputRef.current?.focus({ preventScroll: true });

	function commandUnavailable({ name, args }: SlashCommand): string | undefined {
		if (!slashCommands) return undefined;
		if (!slashCommandAllowed(name, slashCommands.surface)) return slashText.mainOnly(name);
		if (args && !slashCommandAcceptsArgs(name)) return slashText.noArgs(name);
		return slashCommands.unavailable?.(name, args);
	}

	async function runSlash(command: SlashCommand, ui?: SlashUi) {
		if (!slashCommands || draftLocked || pending.current || runningCommand.current) return;
		const unavailable = commandUnavailable(command);
		if (unavailable) { setSkillError(unavailable); return; }
		const panel = ui ?? slashUi.current;
		if (!panel) return;
		const revision = draftRevision.current;
		runningCommand.current = true;
		setCommandRunning(true);
		setSkillError('');
		try {
			const result = await slashCommands.run(command, {
				openSkills: async () => {
					const scope = skillScope ?? skills.scope(context.refs);
					const chosen = await panel.custom<SkillInfo>(skillMenuText().title, (host, done) => {
						const root = createRoot(host);
						root.render(<SlashSkillPanel registry={skills} scope={scope} onChoose={(item) => done(item)} />);
						return () => root.unmount();
					});
					if (!chosen) return false;
					const token = `$${chosen.name}`;
					onChange(token + ' ', [{ id: chosen.id, name: chosen.name, sourceLabel: chosen.sourceLabel, start: 0, end: token.length }], scope);
					closeMenu.current?.();
					return false;
				},
				openMention: async () => {
					const items = context.app.vault.getAllLoadedFiles()
						.filter((item) => item.path !== '/' && (item instanceof TFile || item instanceof TFolder));
					const chosen = await panel.choose(text.chatPickVaultItem, items, (item) => item.path, true);
					if (!chosen) return false;
					context.onAdd({ path: chosen.path, kind: chosen instanceof TFolder ? 'folder' : 'file' });
					return true;
				},
				ui: panel,
			});
			if (result !== false && mounted.current && draftRevision.current === revision) onChange('', []);
		} catch (cause) {
			if (mounted.current && draftRevision.current === revision) setSkillError(cause instanceof Error ? cause.message : text.chatFailed);
		} finally {
			runningCommand.current = false;
			if (mounted.current) setCommandRunning(false);
		}
	}

	async function submit() {
		if (pending.current || runningCommand.current || blocked) return;
		if (slashDraft) {
			if (command) await runSlash(command, slashUi.current ?? undefined);
			else setSkillError(slashText.unknown(slashDraft.token));
			return;
		}
		if (isSkillMenu) { menu.current?.(); onChange('', []); return; }
		pending.current = true;
		setChecking(true);
		setSkillError('');
		try {
			const scope = skillScope ?? skills.scope(context.refs);
			const mentions = await prepareSkillMentions({ instruction, skillMentions }, skills, scope);
			if (mounted.current) onSubmit(instruction, mentions, scope);
		} catch (cause) {
			if (mounted.current) setSkillError(cause instanceof Error ? cause.message : text.chatFailed);
		} finally {
			pending.current = false;
			if (mounted.current) setChecking(false);
		}
	}

	return (
		<div className="scribe-task-input">
			<form className="scribe-compose-form" onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}>
				<ContextChips refs={context.refs} quotes={context.quotes} disabled={contextLocked} onRemove={context.onRemove}
					onRemoveQuotes={context.onRemoveQuotes} onFocusInput={focusInput} />
				<SkillTextArea
					inputRef={inputRef} menuRef={menu} closeMenuRef={closeMenu} registry={skills} refs={context.refs} scope={skillScope}
					panelUiRef={slashUi}
					slash={slashCommands && !commandRunning ? {
						surface: slashCommands.surface, run: (value, ui) => void runSlash(value, ui), unavailable: commandUnavailable,
						focusInput,
					} : undefined}
					draft={{ instruction, skillMentions }} onDraftChange={(draft) => {
						draftRevision.current++;
						setSkillError('');
						onChange(draft.instruction, draft.skillMentions ?? [], draft.skillScope);
					}}
					className="scribe-input"
					placeholder={placeholder ?? text.taskPlaceholder}
					aria-label={placeholder ?? text.taskPlaceholder}
					aria-description={commandDescription ?? (isSkillMenu ? skillMenuText().title : queueHint ? `${queueHint} ${disclosure}` : disclosure)}
					rows={3}
					readOnly={draftLocked}
					onKeyDown={(event) => {
						if (event.defaultPrevented) return;
						const input = event.currentTarget;
						const shortcut = composerShortcut(event.nativeEvent, input.value, input.selectionStart, input.selectionEnd);
						if (shortcut === 'send' || shortcut === 'ignore') {
							event.preventDefault();
							if (shortcut === 'send' && !blocked) input.form?.requestSubmit();
						} else if (shortcut === 'reference' && !contextLocked) {
							event.preventDefault();
							pick(focusInput);
						}
					}}
				/>
				{(skillError || error) && <div className="scribe-chat-error" role="alert">{skillError || error}</div>}
				<div className="scribe-compose-toolbar">
					{onNew && <button type="button" className="scribe-compose-action" disabled={disabled} onClick={onNew}
						aria-label={text.chatNewConversation} title={text.chatNewConversation}>
						<ChatIcon name="message-square-plus" />
					</button>}
					{executionMode && <ExecutionModePicker value={executionMode.value} onChange={executionMode.onChange}
						triggerRef={permissionsTrigger}
						disabled={locked || executionMode.queuePending}
						description={busy || executionMode.queuePending ? text.chatModeLocked : undefined} />}
					<ContextActions key={conversationId} disabled={contextLocked} vaultOnly={vaultOnly}
						onPick={() => pick(focusInput)} onAdd={context.onAdd} onFocusInput={focusInput} />
					<div className="scribe-compose-submit">
						{onClose && <button type="button" className="scribe-compose-action" onClick={onClose}
							aria-label={text.sideChatClose} title={text.sideChatClose}><ChatIcon name="x" /></button>}
						{onResume && <button type="button" className="scribe-compose-action" disabled={modelSaving} onClick={() => { focusInput(); onResume(); }}
							aria-label={text.chatResumeReview} title={text.chatResumeReview}>
							<ChatIcon name="play" />
						</button>}
						{onContinueQueue && <button type="button" className="scribe-compose-action scribe-compose-queue-resume"
							disabled={locked || modelSaving || queueContinuingDisabled} onClick={() => { focusInput(); onContinueQueue(); }}
							title={text.queueResume}>{text.queueResume}</button>}
						{contextMetric && <div className="scribe-composer-context">{contextMetric}</div>}
						<ChatModelPicker groups={modelGroups} value={modelValue} disabled={locked} saving={modelSaving}
							triggerRef={modelTrigger}
							selecting={modelSelecting} thinking={thinking} onSelect={onModelChange} onThinkingChange={onThinkingChange} />
						<button type={busy ? 'button' : 'submit'} className="scribe-compose-action scribe-compose-primary"
							disabled={!busy && blocked} onClick={busy ? () => { focusInput(); onStop(); } : undefined}
							aria-label={actionLabel} aria-description={actionDescription} aria-keyshortcuts={busy ? 'Escape' : undefined}
							title={`${actionLabel} (${busy ? 'Esc' : 'Enter'})${actionDescription ? `\n${actionDescription}` : ''}`}>
							<ChatIcon name={busy ? 'square' : isSkillMenu ? 'book-open' : isSideCommand ? SIDE_CHAT_ICON : 'arrow-up'} />
						</button>
					</div>
				</div>
			</form>
		</div>
	);
}
