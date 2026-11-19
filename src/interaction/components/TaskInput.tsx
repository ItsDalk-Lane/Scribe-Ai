import { useId } from 'react';
import type { RefObject } from 'react';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { composerShortcut } from '../composerKeyboard';
import { uiText } from '../uiText';
import type { ChatModelGroup } from '../useChatModel';
import ChatIcon from './ChatIcon';
import ChatModelPicker from './ChatModelPicker';
import type { ThinkingSelection } from './ThinkingSlider';
import { ContextActions, ContextChips, useVaultPicker } from './ContextPicker';
import type { ContextPickerProps } from './ContextPicker';

interface TaskInputProps {
	inputRef: RefObject<HTMLTextAreaElement | null>;
	busy: boolean;
	disabled: boolean;
	conversationId: string | null;
	context: Omit<ContextPickerProps, 'disabled'>;
	modelGroups: ChatModelGroup[];
	modelValue: string;
	modelSaving: boolean;
	modelSelecting: boolean;
	thinking: ThinkingSelection;
	error: string;
	instruction: string;
	onChange: (instruction: string) => void;
	onModelChange: (value: string) => Promise<boolean>;
	onThinkingChange: (level: ModelThinkingLevel) => void;
	onSubmit: (instruction: string) => void;
	onStop: () => void;
	onResume?: () => void;
	onRetryConnection?: () => void;
}

export default function TaskInput({
	inputRef, busy, disabled, conversationId, context, modelGroups, modelValue, modelSaving, modelSelecting, thinking, error, instruction,
	onChange, onModelChange, onThinkingChange, onSubmit, onStop, onResume, onRetryConnection,
}: TaskInputProps) {
	const text = uiText();
	const disclosureId = useId();
	const provider = modelGroups.find(({ models }) => models.some(({ value }) => value === modelValue))?.label;
	const disclosure = context.selection ? text.chatSelectionDisclosure : text.chatSubmitDisclosure;
	const locked = busy || disabled;
	const blocked = locked || modelSaving || !modelValue || !instruction.trim();
	const pick = useVaultPicker(context.app, context.onAdd);
	const focusInput = () => inputRef.current?.focus({ preventScroll: true });

	return (
		<div className="scribe-task-input">
			<form className="scribe-compose-form" onSubmit={(event) => {
				event.preventDefault();
				if (!blocked) onSubmit(instruction);
			}}>
				<ContextChips refs={context.refs} selection={context.selection} disabled={locked} onRemove={context.onRemove}
					onRemoveSelection={context.onRemoveSelection} onFocusInput={focusInput} />
				<textarea
					ref={inputRef}
					className="scribe-input"
					placeholder={text.taskPlaceholder}
					aria-label={text.taskPlaceholder}
					aria-describedby={disclosureId}
					value={instruction}
					rows={3}
					readOnly={locked}
					onChange={(event) => onChange(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.defaultPrevented) return;
						const input = event.currentTarget;
						const shortcut = composerShortcut(event.nativeEvent, input.value, input.selectionStart, input.selectionEnd);
						if (shortcut === 'send' || shortcut === 'ignore') {
							event.preventDefault();
							if (shortcut === 'send' && !blocked) input.form?.requestSubmit();
						} else if (shortcut === 'reference' && !locked && !context.selection) {
							event.preventDefault();
							pick(focusInput);
						}
					}}
				/>
				{error && <div className="scribe-chat-error" role="alert">{error}</div>}
				<div className="scribe-compose-toolbar">
					<ContextActions key={conversationId} disabled={locked || Boolean(context.selection)}
						onPick={() => pick(focusInput)} onAdd={context.onAdd} onFocusInput={focusInput} />
					<ChatModelPicker groups={modelGroups} value={modelValue} provider={provider} disabled={locked} saving={modelSaving}
						selecting={modelSelecting} thinking={thinking} onSelect={onModelChange} onThinkingChange={onThinkingChange} />
					<div className="scribe-compose-submit">
						{onResume && <button type="button" className="scribe-compose-action" disabled={modelSaving} onClick={() => { focusInput(); onResume(); }}
							aria-label={text.chatResumeReview} title={text.chatResumeReview}>
							<ChatIcon name="play" />
						</button>}
						{onRetryConnection && <button type="button" className="scribe-compose-action" onClick={() => { focusInput(); onRetryConnection(); }}
							aria-label={text.chatRetryConnection} title={text.chatRetryConnection}>
							<ChatIcon name="rotate-cw" />
						</button>}
						{busy ? <button type="button" className="scribe-compose-action scribe-compose-primary" onClick={() => { focusInput(); onStop(); }}
							aria-label={text.chatStop} title={`${text.chatStop} (Esc)`} aria-keyshortcuts="Escape">
							<ChatIcon name="square" />
						</button> : <button type="submit" className="scribe-compose-action scribe-compose-primary" disabled={blocked}
							aria-label={text.submit} aria-describedby={disclosureId} title={`${text.submit} (Enter)`}>
							<ChatIcon name="arrow-up" />
						</button>}
					</div>
				</div>
			</form>
			<p className="scribe-compose-disclosure" id={disclosureId}>
				{provider ? disclosure.replace('{provider}', () => provider) : text.chatModelMissing}
			</p>
		</div>
	);
}
