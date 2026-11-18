import { useEffect, useId, useRef, useState } from 'react';
import { composerShortcut } from '../composerKeyboard';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';
import { ContextActions, ContextChips, ExternalPath, useVaultPicker } from './ContextPicker';
import type { ContextPickerProps } from './ContextPicker';

interface TaskInputProps {
	busy: boolean;
	disabled: boolean;
	conversationId: string | null;
	context: Omit<ContextPickerProps, 'disabled'>;
	destination: string;
	error: string;
	instruction: string;
	onChange: (instruction: string) => void;
	onFocus: () => void;
	onSubmit: (instruction: string) => void;
	onStop: () => void;
	onResume?: () => void;
	onRetryConnection?: () => void;
}

export default function TaskInput({
	busy, disabled, conversationId, context, destination, error, instruction, onChange, onFocus, onSubmit, onStop, onResume, onRetryConnection,
}: TaskInputProps) {
	const text = uiText();
	const field = useRef<HTMLTextAreaElement>(null);
	const externalTrigger = useRef<HTMLButtonElement | null>(null);
	const disclosureId = useId();
	const destinationId = useId();
	const externalId = useId();
	const [externalOpen, setExternalOpen] = useState(false);
	const locked = busy || disabled;
	const blocked = locked || !destination || !instruction.trim();
	const showExternal = externalOpen && !context.selection;
	const pick = useVaultPicker(context.app, context.onAdd);
	const focusInput = () => field.current?.focus({ preventScroll: true });
	const disclosure = context.selection ? text.chatSelectionDisclosure : text.chatSubmitDisclosure;
	useEffect(() => setExternalOpen(false), [conversationId, busy, disabled]);

	return (
		<div className="scribe-task-input" onKeyDown={(event) => {
			if (!showExternal || event.defaultPrevented || composerShortcut(event.nativeEvent) !== 'escape'
				|| (event.target instanceof Element && event.target.closest('select'))) return;
			event.preventDefault();
			event.stopPropagation();
			setExternalOpen(false);
			if (externalTrigger.current?.isConnected && !locked) externalTrigger.current.focus();
			else focusInput();
		}}>
			{showExternal && <ExternalPath id={externalId} disabled={locked} onAdd={context.onAdd} />}
			<form className="scribe-compose-form" onSubmit={(event) => {
				event.preventDefault();
				if (!blocked) {
					setExternalOpen(false);
					onSubmit(instruction.trim());
				}
			}}>
				<ContextChips refs={context.refs} selection={context.selection} disabled={locked} onRemove={context.onRemove}
					onRemoveSelection={context.onRemoveSelection} onFocusInput={focusInput} />
				<textarea
					ref={field}
					className="scribe-input"
					placeholder={text.taskPlaceholder}
					aria-label={text.taskPlaceholder}
					aria-describedby={destination ? `${destinationId} ${disclosureId}` : disclosureId}
					value={instruction}
					rows={3}
					readOnly={locked}
					onFocus={onFocus}
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
					<ContextActions key={conversationId} disabled={locked} selectionOnly={Boolean(context.selection)}
						onPick={() => pick(focusInput)} onAttachSelection={() => {
							if (!context.onAttachSelection()) return false;
							setExternalOpen(false);
							focusInput();
							return true;
						}} externalOpen={showExternal} externalId={externalId} onToggleExternal={(trigger) => {
							externalTrigger.current = trigger;
							setExternalOpen(!showExternal);
							if (showExternal) trigger?.focus({ preventScroll: true });
						}} />
					{destination && <span className="scribe-compose-destination" id={destinationId} title={destination}>{destination}</span>}
					<div className="scribe-compose-submit">
						{onResume && <button type="button" className="scribe-compose-action" onClick={() => { focusInput(); onResume(); }}
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
							aria-label={text.submit} title={`${text.submit} (Enter)`}>
							<ChatIcon name="arrow-up" />
						</button>}
					</div>
				</div>
			</form>
			<div className="scribe-chat-disclosure" id={disclosureId}>
				{destination ? disclosure : text.chatModelMissing}
			</div>
		</div>
	);
}
