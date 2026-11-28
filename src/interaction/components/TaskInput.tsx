import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { SIDE_CHAT_ICON } from '../../constants';
import { retainDraftImages } from '../../orchestration/storage/retainedImages';
import { userImageReferences } from '../../orchestration/context/imageAttachments';
import { pdfAttachmentPath } from '../../orchestration/context/pdfAttachments';
import type { ExecutionMode, SkillInfo, SkillMention, SkillRegistry, TaskTarget } from '../../types';
import { clipboardImages, saveClipboardImage } from '../composerImages';
import { isImageFile, MAX_IMAGES } from '../../tools/support/imageData';
import { composerShortcut, sideChatCommand } from '../composerKeyboard';
import { parseSlashCommand, readSlashDraft, slashCommandAcceptsArgs, slashCommandAllowed, slashGoalActions, slashTargetCommand, slashTargetMatches } from '../slashCommands';
import type { SlashCommand, SlashCommandName, SlashCommandSurface, SlashSubcommand, SlashTargetChoice } from '../slashCommands';
import type { SlashUi } from '../slashUi';
import { slashCommandText } from '../slashCommandText';
import { tr } from '../skills/dialog';
import type { Preset } from '../slashPresets';
import { uiText } from '../uiText';
import type { ChatModelGroup } from '../useChatModel';
import ChatIcon from './ChatIcon';
import ChatModelPicker from './ChatModelPicker';
import ExecutionModePicker from './ExecutionModePicker';
import type { ThinkingSelection } from './ThinkingSlider';
import { ContextChips } from './ContextPicker';
import type { ContextPickerProps } from './ContextPicker';
import SkillTextArea, { skillMenuText } from './SkillTextArea';
import SlashSkillPanel from './SlashSkillPanel';
import { composerTargetPrefix, editSkillText, insertSkill, prepareSkillMentions } from './skillMentionText';

export interface SlashCommandUi {
	openSkills: () => Promise<boolean>;
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
	composerMode?: { kind: 'plan' | 'goal'; onClose: () => void };
	vaultOnly?: boolean;
	placeholder?: string;
	modelGroups: ChatModelGroup[];
	modelValue: string;
	modelSaving?: boolean;
	modelSelecting?: boolean;
	pdfAnalysisSupported?: boolean;
	pdfAnalysisModelLabel?: string;
	thinking: ThinkingSelection;
	error: string;
	instruction: string;
	skillMentions: SkillMention[];
	skills: SkillRegistry;
	skillScope?: string[];
	target?: TaskTarget;
	onRemoveTarget?: () => void;
	onChange: (instruction: string, skillMentions: SkillMention[], scope?: string[]) => void;
	onModelChange: (value: string) => Promise<boolean>;
	onThinkingChange: (level: string) => void;
	onSubmit: (instruction: string, mentions: SkillMention[], scope: string[]) => void | Promise<void>;
	onStop: () => void;
	queueDuringRun?: boolean;
	onContinueQueue?: () => void;
	queueContinuingDisabled?: boolean;
	onClose?: () => void;
	onResume?: () => void;
	slashCommands?: {
		surface: SlashCommandSurface;
		goalActions?: boolean;
		getPresets?: () => readonly (Preset | undefined)[];
		getSubcommands?: () => readonly SlashSubcommand[];
		getTargets?: () => readonly SlashTargetChoice[];
		subscribeTargets?: (listener: () => void) => (() => void) | undefined;
		selectTarget?: (target: TaskTarget) => void;
		unavailable?: (name: SlashCommandName, args: string) => string | undefined;
		run: (command: SlashCommand, ui: SlashCommandUi) => Promise<boolean | void> | boolean | void;
	};
}

export default function TaskInput({
	inputRef, busy, disabled, conversationId, context, contextMetric, executionMode, composerMode, vaultOnly, placeholder,
	modelGroups, modelValue, modelSaving = false, modelSelecting = false, pdfAnalysisSupported = false, pdfAnalysisModelLabel,
	thinking, error, instruction, skills, skillScope, skillMentions,
	target, onRemoveTarget, onChange, onModelChange, onThinkingChange, onSubmit, onStop, queueDuringRun = false,
	onContinueQueue, queueContinuingDisabled, onClose, onResume, slashCommands,
}: TaskInputProps) {
	const text = uiText();
	const slashText = slashCommandText();
	const modeKind = composerMode?.kind;
	const inputPlaceholder = placeholder ?? (modeKind === 'goal' ? tr('描述目标，以及怎样算完成…', 'Describe the goal and what counts as done…')
		: modeKind === 'plan' ? tr('描述要规划的任务…', 'Describe the task to plan…') : text.taskPlaceholder);
	const provider = modelGroups.find(({ models }) => models.some(({ value }) => value === modelValue))?.label;
	const vision = modelGroups.flatMap(({ models }) => models).find(({ value }) => value === modelValue)?.vision;
	const disclosure = provider
		? text.chatSubmitDisclosure.replace('{provider}', () => provider)
		: text.chatModelMissing;
	const locked = busy || disabled;
	const [checking, setChecking] = useState(false);
	const [pasting, setPasting] = useState(false);
	const [commandRunning, setCommandRunning] = useState(false);
	const [slashMenuOpen, setSlashMenuOpen] = useState(false);
	const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
	const referenceMenuId = useId();
	const slashMenuId = useId();
	const [skillError, setSkillError] = useState('');
	const pending = useRef(false);
	const runningCommand = useRef(false);
	const draftRevision = useRef(0);
	const mounted = useRef(false);
	const pastePending = useRef(false);
	useLayoutEffect(() => retainDraftImages(context.conversationStore, conversationId, context.refs), [context.conversationStore, conversationId, context.refs]);
	const pasteConversation = useRef(conversationId);
	useLayoutEffect(() => { pasteConversation.current = conversationId; }, [conversationId]);
	useLayoutEffect(() => { draftRevision.current++; }, [conversationId, instruction, skillMentions, skillScope]);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const busyWithoutQueue = busy && !queueDuringRun;
	const draftLocked = checking || disabled || (busyWithoutQueue && !slashCommands);
	const contextLocked = draftLocked || busyWithoutQueue;
	const referencesDisabled = contextLocked || commandRunning;
	useEffect(() => { if (referencesDisabled) setReferenceMenuOpen(false); }, [referencesDisabled]);
	const slashDraft = slashCommands ? readSlashDraft(instruction) : undefined;
	const subscribeTargets = slashCommands?.subscribeTargets;
	const searchingTargets = Boolean(slashDraft);
	const [, refreshTargets] = useState(0);
	useEffect(() => searchingTargets ? subscribeTargets?.(() => refreshTargets((value) => value + 1)) : undefined,
		[searchingTargets, subscribeTargets]);
	const command = slashDraft && parseSlashCommand(instruction);
	const goalDraft = modeKind === 'goal' || (slashCommands?.surface === 'main' && command?.name === 'goal'
		&& !slashGoalActions.some((action) => action === command.args.toLowerCase()));
	const isSideCommand = command?.name === 'side' || (!slashCommands && queueDuringRun && sideChatCommand(instruction) !== null);
	const isSkillMenu = command?.name === 'skills' || (!slashCommands && instruction.trim() === '/skills');
	const menu = useRef<(() => void) | null>(null);
	const closeMenu = useRef<(() => void) | null>(null);
	const slashUi = useRef<SlashUi | null>(null);
	const modelTrigger = useRef<HTMLButtonElement>(null);
	const permissionsTrigger = useRef<HTMLButtonElement>(null);
	const attachedImages = context.refs.filter(({ kind, lines, path }) => kind !== 'folder' && !lines && isImageFile(path));
	const hasPdf = context.refs.some(pdfAttachmentPath);
	const pdfIssue = !hasPdf ? undefined : !pdfAnalysisSupported || isSideCommand
		? tr('请在普通聊天中发送 PDF。', 'Send PDFs in a regular chat.')
		: !pdfAnalysisModelLabel ? tr('请先在「服务 → PDF 解析」中选择可用的 PDF 解析模型。',
			'Select an available PDF analysis model in Services → PDF analysis first.') : undefined;
	const missingPrompt = !instruction.trim() && (modeKind === 'goal' || (!attachedImages.length && !hasPdf));
	const blocked = disabled || commandRunning || pasting
		|| (slashDraft ? draftLocked : Boolean(pdfIssue && !isSkillMenu)
			|| (!isSideCommand && (contextLocked || (!isSkillMenu && (modelSaving || !modelValue || missingPrompt)))));
	const actionLabel = busy ? text.chatStop : isSkillMenu ? skillMenuText().title : isSideCommand ? text.sideChatOpen : slashDraft ? slashText.run : text.submit;
	const queueHint = busy && queueDuringRun && !slashDraft ? text.queueEnterHint : undefined;
	const commandDescription = command ? slashText.describe(command.name) : slashDraft ? slashText.label : undefined;
	const actionDescription = busy ? queueHint : commandDescription ?? (isSkillMenu ? undefined : disclosure);
	const focusInput = () => inputRef.current?.focus({ preventScroll: true });

	function commandUnavailable({ name, args }: SlashCommand): string | undefined {
		if (!slashCommands) return undefined;
		if (!slashCommandAllowed(name, slashCommands.surface)) return slashText.mainOnly(name);
		if (args && !slashCommandAcceptsArgs(name)) return slashText.noArgs(name);
		return slashCommands.unavailable?.(name, args);
	}

	function selectSlashTarget(choice: TaskTarget, tokenEnd: number) {
		if (!slashCommands?.selectTarget || draftLocked || pending.current || runningCommand.current) return;
		const current = slashCommands.getTargets?.().find(({ target }) => target.kind === choice.kind && target.id === choice.id);
		if (!current) { setSkillError(slashText.unknown(choice.label)); return; }
		const unavailable = commandUnavailable({ name: slashTargetCommand(choice), args: '', argsStart: tokenEnd }) ?? current.reason;
		if (unavailable) { setSkillError(unavailable); return; }
		const remaining = instruction.slice(tokenEnd).trimStart();
		const selection = inputRef.current ? inputRef.current.selectionStart - composerTargetPrefix(target).length : instruction.length;
		const cursor = Math.max(0, selection - (instruction.length - remaining.length));
		const next = editSkillText({ instruction, skillMentions }, remaining, cursor);
		slashCommands.selectTarget(current.target);
		setSkillError('');
		onChange(next.instruction, next.skillMentions ?? [], skillScope);
		focusInput();
		inputRef.current?.ownerDocument.defaultView?.requestAnimationFrame(() => {
			const prefix = composerTargetPrefix(current.target);
			const field = inputRef.current;
			if (field?.value === prefix + remaining) field.setSelectionRange(prefix.length + cursor, prefix.length + cursor);
		});
	}

	async function runSlash(command: SlashCommand, ui?: SlashUi, preserveDraft = false) {
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
					if (!mounted.current || draftRevision.current !== revision) return false;
					const draft = preserveDraft ? { instruction, skillMentions } : { instruction: '' };
					const next = insertSkill(draft, 0, 0, chosen);
					onChange(next.instruction, next.skillMentions, scope);
					closeMenu.current?.();
					return false;
				},
				ui: panel,
			});
			if (!preserveDraft && result !== false && mounted.current && draftRevision.current === revision) onChange('', []);
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
			else {
				const matches = slashTargetMatches(instruction, instruction.length, slashCommands?.getTargets?.() ?? [])
					.filter(({ exact }) => exact);
				if (matches.length === 1 && matches[0]) selectSlashTarget(matches[0].choice.target, matches[0].tokenEnd);
				else setSkillError(matches.length > 1
					? tr('有多个同名选项，请从候选列表中选择。', 'Choose from the matching suggestions.')
					: slashText.unknown(slashDraft.token));
			}
			return;
		}
		if (isSkillMenu) { menu.current?.(); onChange('', []); return; }
		if (!isSideCommand && vision === false && userImageReferences({ instruction, refs: context.refs }).length) {
			setSkillError(tr('当前模型连接未启用图片输入，请选择支持图片的模型。', 'Choose a model that supports image input.'));
			return;
		}
		pending.current = true;
		setChecking(true);
		setSkillError('');
		try {
			const scope = skillScope ?? skills.scope(context.refs);
			const mentions = await prepareSkillMentions({ instruction, skillMentions }, skills, scope);
			const prompt = instruction.trim() ? instruction : hasPdf ? (attachedImages.length
				? tr('请分析这些附件。', 'Analyze these attachments.') : tr('请分析附件中的 PDF。', 'Analyze the attached PDF.'))
				: tr('请查看这些图片。', 'Look at these images.');
			if (mounted.current) await onSubmit(prompt, mentions, scope);
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
				<ContextChips app={context.app} refs={context.refs} quotes={context.quotes}
					disabled={contextLocked} onRemove={context.onRemove}
					onRemoveQuotes={context.onRemoveQuotes} onFocusInput={focusInput} />
				<SkillTextArea
					inputRef={inputRef} menuRef={menu} closeMenuRef={closeMenu} registry={skills} refs={context.refs} scope={skillScope}
					panelUiRef={slashUi} target={target} onRemoveTarget={onRemoveTarget}
					references={{ ...context, conversationId, disabled: referencesDisabled, vaultOnly }}
					referenceLauncher={{ id: referenceMenuId, open: referenceMenuOpen, close: () => setReferenceMenuOpen(false) }}
					slashLauncher={slashCommands?.surface === 'main' ? {
						id: slashMenuId, open: slashMenuOpen, close: () => setSlashMenuOpen(false),
					} : undefined}
					slash={slashCommands && !commandRunning ? {
						surface: slashCommands.surface, run: (value, ui, preserveDraft) => void runSlash(value, ui, preserveDraft),
						unavailable: commandUnavailable,
						getPresets: slashCommands.getPresets, goalActions: slashCommands.goalActions,
						getSubcommands: slashCommands.getSubcommands,
						getTargets: slashCommands.getTargets, selectTarget: selectSlashTarget,
						focusInput,
					} : undefined}
					draft={{ instruction, skillMentions }} onDraftChange={(draft) => {
						draftRevision.current++;
						setSkillError('');
						onChange(draft.instruction, draft.skillMentions ?? [], draft.skillScope);
					}}
					className="scribe-input"
					placeholder={inputPlaceholder}
					aria-label={inputPlaceholder}
					aria-description={commandDescription ?? (isSkillMenu ? skillMenuText().title : queueHint ? `${queueHint} ${disclosure}` : disclosure)}
					rows={3}
					readOnly={draftLocked}
					onPaste={(event) => {
						const files = clipboardImages(event.clipboardData);
						if (!files.length) return;
						event.preventDefault();
						if (!conversationId || referencesDisabled || pending.current || pastePending.current) return;
						if (files.length + attachedImages.length > MAX_IMAGES) {
							setSkillError(tr('最多添加 12 张图片。', 'Attach up to 12 images.'));
							return;
						}
						pastePending.current = true;
						setPasting(true);
						setSkillError('');
						void (async () => {
							for (const file of files) {
								const ref = await saveClipboardImage(context.app, conversationId, file,
									() => mounted.current && pasteConversation.current === conversationId);
								context.onAdd(ref);
							}
						})().catch((cause: unknown) => {
							if (mounted.current && pasteConversation.current === conversationId) setSkillError(cause instanceof Error ? cause.message : text.chatFailed);
						}).finally(() => {
							pastePending.current = false;
							if (mounted.current) setPasting(false);
						});
					}}
					onKeyDown={(event) => {
						if (event.defaultPrevented) return;
						const input = event.currentTarget;
						const shortcut = composerShortcut(event.nativeEvent);
						if (shortcut === 'send' || shortcut === 'ignore') {
							event.preventDefault();
							if (shortcut === 'send' && !blocked) input.form?.requestSubmit();
						}
					}}
				/>
				{goalDraft && <div className="setting-item-description">{text.chatGoalReviewDisclosure}</div>}
				{hasPdf && !pdfIssue && <div className="setting-item-description">{tr(`PDF 原件和当前问题将发送给 ${pdfAnalysisModelLabel}。`,
					`The PDF and your question will be sent to ${pdfAnalysisModelLabel}.`)}</div>}
				{(pdfIssue || skillError || error) && <div className="scribe-chat-error" role="alert">{pdfIssue || skillError || error}</div>}
				<div className="scribe-compose-toolbar">
					<button type="button" className="scribe-compose-action scribe-compose-reference" disabled={referencesDisabled}
						aria-label={text.chatAddContext} title={text.chatAddContext} aria-expanded={referenceMenuOpen}
						aria-controls={referenceMenuOpen ? referenceMenuId : undefined} onMouseDown={(event) => event.preventDefault()}
						onClick={() => {
							closeMenu.current?.();
							setReferenceMenuOpen(!referenceMenuOpen);
							if (referenceMenuOpen) focusInput();
						}}><ChatIcon name="plus" /></button>
					{slashCommands?.surface === 'main' && <button type="button" className="scribe-compose-action scribe-compose-slash"
						disabled={draftLocked || commandRunning} aria-label={slashText.label} aria-haspopup="listbox"
						aria-expanded={slashMenuOpen} aria-controls={slashMenuOpen ? slashMenuId : undefined}
						onMouseDown={(event) => event.preventDefault()} onClick={() => {
							setReferenceMenuOpen(false);
							setSlashMenuOpen((open) => !open);
							focusInput();
						}}>
						<ChatIcon name="square-slash" />
					</button>}
					{executionMode && <ExecutionModePicker value={executionMode.value} onChange={executionMode.onChange}
						triggerRef={permissionsTrigger}
						disabled={locked || executionMode.queuePending}
						description={busy || executionMode.queuePending ? text.chatModeLocked : undefined} />}
					{composerMode && <button type="button" className="scribe-compose-action scribe-compose-mode" disabled={draftLocked || commandRunning}
						aria-label={modeKind === 'goal' ? tr('关闭目标输入', 'Close goal draft') : tr('退出计划模式', 'Exit plan mode')}
						onClick={() => { composerMode.onClose(); focusInput(); }}>
						<span className="scribe-compose-mode-icon"><ChatIcon name={modeKind === 'goal' ? 'target' : 'lightbulb'} /><ChatIcon name="x" /></span>
						{modeKind === 'goal' ? tr('目标', 'Goal') : tr('计划', 'Plan')}
					</button>}
					<div className="scribe-compose-submit">
						{onClose && <button type="button" className="scribe-compose-action" onClick={onClose}
							aria-label={text.sideChatClose} title={text.sideChatClose}><ChatIcon name="x" /></button>}
						{onResume && <button type="button" className="scribe-compose-action" disabled={modelSaving} onClick={() => { focusInput(); onResume(); }}
							aria-label={text.chatResumeReview} title={text.chatResumeReview}>
							<ChatIcon name="play" />
						</button>}
						{onContinueQueue && <button type="button" className="scribe-compose-action scribe-compose-queue-resume"
								disabled={locked || modelSaving || queueContinuingDisabled} onClick={() => { focusInput(); onContinueQueue(); }}>
								{text.queueResume}</button>}
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
