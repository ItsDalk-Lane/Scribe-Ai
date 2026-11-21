import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ExecutionMode } from '../../types';
import { composerShortcut } from '../composerKeyboard';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';

interface Props {
	value: ExecutionMode;
	disabled: boolean;
	description?: string;
	onChange: (mode: ExecutionMode, trigger: HTMLButtonElement) => void;
}

export default function ExecutionModePicker({ value, disabled, description, onChange }: Props) {
	const text = uiText();
	const modes = {
		ask: { label: text.chatModeAsk, description: text.chatModeAskDescription, icon: 'shield-question' },
		'auto-review': { label: text.chatModeAutoReview, description: text.chatModeAutoReviewDescription, icon: 'shield-check' },
		'full-access': { label: text.chatModeFullAccess, description: text.chatModeFullAccessDescription, icon: 'shield-alert' },
	} satisfies Record<ExecutionMode, { label: string; description: string; icon: string }>;
	const current = modes[value];
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const selectedOption = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const expanded = open && !disabled;

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	useLayoutEffect(() => {
		if (expanded) selectedOption.current?.focus({ preventScroll: true });
	}, [expanded]);

	function close(restoreFocus: boolean) {
		setOpen(false);
		if (restoreFocus) trigger.current?.focus({ preventScroll: true });
	}

	return <div className="scribe-execution-picker" onBlur={(event) => {
		if (expanded && !event.currentTarget.contains(event.relatedTarget)) close(false);
	}} onKeyDown={(event) => {
		if (!expanded || event.defaultPrevented) return;
		if (composerShortcut(event.nativeEvent) === 'escape') {
			event.preventDefault();
			event.stopPropagation();
			close(true);
		} else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && menu.current) {
			event.preventDefault();
			const items = Array.from(menu.current.querySelectorAll('button'));
			const currentIndex = items.findIndex((item) => item === event.target);
			const step = event.key === 'ArrowDown' ? 1 : -1;
			items[(currentIndex + step + items.length) % items.length]?.focus({ preventScroll: true });
		}
	}}>
		<button type="button" ref={trigger} className="scribe-compose-action scribe-compose-execution"
			data-full-access={value === 'full-access' || undefined} disabled={disabled}
			aria-label={`${text.chatExecutionMode} · ${current.label}`}
			aria-expanded={expanded} aria-controls={expanded ? id : undefined}
			title={description ?? current.description}
			onClick={(event) => {
				event.currentTarget.focus({ preventScroll: true });
				setOpen(!expanded);
			}}>
			<ChatIcon name={current.icon} />
			<span className="scribe-execution-label">{current.label}</span>
			<ChatIcon name="chevron-down" />
		</button>
		{expanded && <div ref={menu} id={id} className="scribe-context-popover scribe-execution-menu" role="group" aria-label={text.chatExecutionMode}>
			{(Object.keys(modes) as ExecutionMode[]).map((mode) => {
				const item = modes[mode];
				return <button type="button" key={mode} ref={mode === value ? selectedOption : undefined} aria-pressed={mode === value}
					onClick={() => {
						close(true);
						if (trigger.current && mode !== value) onChange(mode, trigger.current);
					}}>
					<ChatIcon name={item.icon} />
					<span className="scribe-execution-option">
						<span>{item.label}</span>
						<small>{item.description}</small>
					</span>
					{mode === value && <ChatIcon name="check" />}
				</button>;
			})}
		</div>}
	</div>;
}
