import type { ReactNode, RefObject } from 'react';
import { SIDE_CHAT_ICON } from '../../constants';
import type { ExecutionMode } from '../../types';
import { composerShortcut, sideChatCommand } from '../composerKeyboard';
import { uiText } from '../uiText';
import type { ChatModelGroup } from '../useChatModel';
import ChatIcon from './ChatIcon';
import ChatModelPicker from './ChatModelPicker';
import ExecutionModePicker from './ExecutionModePicker';
import type { ThinkingSelection } from './ThinkingSlider';
import { ContextActions, ContextChips, useVaultPicker } from './ContextPicker';
import type { ContextPickerProps } from './ContextPicker';

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
	onChange: (instruction: string) => void;
	onModelChange: (value: string) => Promise<boolean>;
	onThinkingChange: (level: string) => void;
	onSubmit: (instruction: string) => void;
	onStop: () => void;
	queueDuringRun?: boolean;
	onContinueQueue?: () => void;
	queueContinuingDisabled?: boolean;
	onClose?: () => void;
	onResume?: () => void;
	onRetryConnection?: () => void;
	toolbar?: ReactNode;
}

export default function TaskInput({
	inputRef, busy, disabled, conversationId, context, contextMetric, executionMode, vaultOnly, placeholder,
	modelGroups, modelValue, modelSaving = false, modelSelecting = false, thinking, error, instruction,
	onChange, onModelChange, onThinkingChange, onSubmit, onStop, queueDuringRun = false,
	onContinueQueue, queueContinuingDisabled, onClose, onResume, onRetryConnection, toolbar,
}: TaskInputProps) {
	const text = uiText();
	const provider = modelGroups.find(({ models }) => models.some(({ value }) => value === modelValue))?.label;
	const disclosure = provider
		? (context.selection ? text.chatSelectionDisclosure : text.chatSubmitDisclosure).replace('{provider}', () => provider)
		: text.chatModelMissing;
	const locked = busy || disabled;
	const draftLocked = disabled || (busy && !queueDuringRun);
	const isSideCommand = queueDuringRun && sideChatCommand(instruction) !== null;
	const blocked = disabled || (!isSideCommand && (draftLocked || modelSaving || !modelValue || !instruction.trim()));
	const actionLabel = busy ? text.chatStop : isSideCommand ? text.sideChatOpen : text.submit;
	const queueHint = busy && queueDuringRun ? text.queueEnterHint : undefined;
	const actionDescription = busy ? queueHint : disclosure;
	const pick = useVaultPicker(context.app, context.onAdd);
	const focusInput = () => inputRef.current?.focus({ preventScroll: true });

	return (
		<div className="scribe-task-input">
			{toolbar && <div className="scribe-compose-bar">{toolbar}</div>}
			<form className="scribe-compose-form" onSubmit={(event) => {
				event.preventDefault();
				if (!blocked) onSubmit(instruction);
			}}>
				<ContextChips refs={context.refs} selection={context.selection} quotes={context.quotes} disabled={draftLocked} onRemove={context.onRemove}
					onRemoveSelection={context.onRemoveSelection} onRemoveQuotes={context.onRemoveQuotes} onFocusInput={focusInput} />
				<textarea
					ref={inputRef}
					className="scribe-input"
					placeholder={placeholder ?? text.taskPlaceholder}
					aria-label={placeholder ?? text.taskPlaceholder}
					aria-description={queueHint ? `${queueHint} ${disclosure}` : disclosure}
					value={instruction}
					rows={3}
					readOnly={draftLocked}
					onChange={(event) => onChange(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.defaultPrevented) return;
						const input = event.currentTarget;
						const shortcut = composerShortcut(event.nativeEvent, input.value, input.selectionStart, input.selectionEnd);
						if (shortcut === 'send' || shortcut === 'ignore') {
							event.preventDefault();
							if (shortcut === 'send' && !blocked) input.form?.requestSubmit();
						} else if (shortcut === 'reference' && !draftLocked && !context.selection) {
							event.preventDefault();
							pick(focusInput);
						}
					}}
				/>
				{error && <div className="scribe-chat-error" role="alert">{error}</div>}
				<div className="scribe-compose-toolbar">
					<ContextActions key={conversationId} disabled={draftLocked || Boolean(context.selection)} vaultOnly={vaultOnly}
						onPick={() => pick(focusInput)} onAdd={context.onAdd} onFocusInput={focusInput} />
					{executionMode && <ExecutionModePicker value={executionMode.value} onChange={executionMode.onChange}
						disabled={locked || Boolean(context.selection) || executionMode.queuePending}
						description={context.selection ? text.chatModeSelection
							: busy || executionMode.queuePending ? text.chatModeLocked : undefined} />}
					<div className="scribe-compose-submit">
						{onClose && <button type="button" className="scribe-compose-action" onClick={onClose}
							aria-label={text.sideChatClose} title={text.sideChatClose}><ChatIcon name="x" /></button>}
						{onResume && <button type="button" className="scribe-compose-action" disabled={modelSaving} onClick={() => { focusInput(); onResume(); }}
							aria-label={text.chatResumeReview} title={text.chatResumeReview}>
							<ChatIcon name="play" />
						</button>}
						{onRetryConnection && <button type="button" className="scribe-compose-action" onClick={() => { focusInput(); onRetryConnection(); }}
							aria-label={text.chatRetryConnection} title={text.chatRetryConnection}>
							<ChatIcon name="rotate-cw" />
						</button>}
						{onContinueQueue && <button type="button" className="scribe-compose-action scribe-compose-queue-resume"
							disabled={locked || modelSaving || queueContinuingDisabled} onClick={() => { focusInput(); onContinueQueue(); }}
							title={text.queueResume}>{text.queueResume}</button>}
						{contextMetric && <div className="scribe-composer-context">{contextMetric}</div>}
						<ChatModelPicker groups={modelGroups} value={modelValue} disabled={locked} saving={modelSaving}
							selecting={modelSelecting} thinking={thinking} onSelect={onModelChange} onThinkingChange={onThinkingChange} />
						<button type={busy ? 'button' : 'submit'} className="scribe-compose-action scribe-compose-primary"
							disabled={!busy && blocked} onClick={busy ? () => { focusInput(); onStop(); } : undefined}
							aria-label={actionLabel} aria-description={actionDescription} aria-keyshortcuts={busy ? 'Escape' : undefined}
							title={`${actionLabel} (${busy ? 'Esc' : 'Enter'})${actionDescription ? `\n${actionDescription}` : ''}`}>
							<ChatIcon name={busy ? 'square' : isSideCommand ? SIDE_CHAT_ICON : 'arrow-up'} />
						</button>
					</div>
				</div>
			</form>
		</div>
	);
}
