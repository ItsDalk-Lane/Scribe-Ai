import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { composerShortcut } from '../composerKeyboard';
import { uiText } from '../uiText';
import type { ChatModelGroup } from '../useChatModel';
import ChatIcon from './ChatIcon';
import ThinkingSlider from './ThinkingSlider';
import type { ThinkingSelection } from './ThinkingSlider';

interface Props {
	groups: ChatModelGroup[];
	value: string;
	provider?: string;
	thinking: ThinkingSelection;
	disabled: boolean;
	saving: boolean;
	selecting: boolean;
	onSelect: (value: string) => Promise<boolean>;
	onThinkingChange: (level: ModelThinkingLevel) => void;
}

export default function ChatModelPicker({ groups, value, provider, thinking, disabled, saving, selecting, onSelect, onThinkingChange }: Props) {
	const text = uiText();
	const id = useId();
	const popup = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [focused, setFocused] = useState('');
	const models = groups.flatMap((group) => group.models);
	const current = models.find((model) => model.value === value);
	const destination = current && (provider ? `${provider} · ${current.id}` : current.id);
	const expanded = open && !disabled && models.length > 0;
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	function close(restore = false) {
		setOpen(false);
		if (restore) trigger.current?.focus({ preventScroll: true });
	}

	useLayoutEffect(() => {
		const button = trigger.current;
		const panel = popup.current;
		if (!expanded || !button || !panel) return;
		const doc = button.ownerDocument;
		const win = doc.defaultView;
		if (!win) return;
		const pane = button.closest('.scribe-app') ?? doc.documentElement;
		const measure = () => {
			const bounds = pane.getBoundingClientRect();
			const anchor = button.getBoundingClientRect();
			const inline = win.getComputedStyle(button).direction === 'rtl'
				? anchor.right - Math.max(0, bounds.left)
				: Math.min(win.innerWidth, bounds.right) - anchor.left;
			panel.dataset.availableWidth = String(Math.max(0, Math.floor(inline - 4)));
			panel.dataset.availableHeight = String(Math.max(0, Math.floor(anchor.top - Math.max(0, bounds.top) - 8)));
		};
		const dismiss = (event: PointerEvent) => {
			const path = event.composedPath();
			if (!path.includes(button) && !path.includes(panel)) setOpen(false);
		};
		measure();
		const observer = new win.ResizeObserver(measure);
		observer.observe(pane);
		observer.observe(button);
		const composer = button.closest('.scribe-compose-form');
		if (composer) observer.observe(composer);
		doc.addEventListener('scroll', measure, true);
		doc.addEventListener('pointerdown', dismiss);
		win.addEventListener('resize', measure);
		const row = panel.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
			?? panel.querySelector<HTMLButtonElement>('[role="option"]');
		row?.focus({ preventScroll: true });
		row?.scrollIntoView({ block: 'nearest' });
		return () => {
			observer.disconnect();
			doc.removeEventListener('scroll', measure, true);
			doc.removeEventListener('pointerdown', dismiss);
			win.removeEventListener('resize', measure);
		};
	}, [expanded]);

	async function choose(model: string) {
		if (!saving && await onSelect(model) && popup.current) close(true);
	}

	return <div className="scribe-chat-model-picker" onBlur={(event) => {
		if (expanded && !event.currentTarget.contains(event.relatedTarget)) close();
	}} onKeyDown={(event) => {
		if (!expanded || event.defaultPrevented || composerShortcut(event.nativeEvent) !== 'escape') return;
		event.preventDefault();
		event.stopPropagation();
		close(true);
	}}>
		<button type="button" ref={trigger} className="scribe-compose-model" disabled={disabled || models.length === 0}
			aria-label={destination ? `${text.chatChooseModel} · ${destination}` : text.chatChooseModel}
			title={destination ?? text.chatModelMissing} aria-haspopup="listbox"
			aria-expanded={expanded} aria-controls={expanded ? id : undefined} aria-disabled={saving || undefined}
			onClick={() => {
				if (expanded) close();
				else if (!saving) setOpen(true);
			}} onKeyDown={(event) => {
				if (!expanded && !saving && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
					event.preventDefault();
					setOpen(true);
				}
			}}>
			<span>{destination ?? text.chatNoModelSelected}</span><ChatIcon name="chevron-down" />
		</button>
		{expanded && <div className="scribe-chat-model-panel" ref={popup}>
			<div id={id} className="scribe-chat-model-options" role="listbox" aria-label={text.chatChooseModel} aria-busy={saving || undefined}
				onKeyDown={(event) => {
					if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Enter') return;
					event.preventDefault();
					const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
					const currentIndex = rows.findIndex((row) => row === event.target);
					if (event.key === 'Enter') {
						if (!event.repeat && !saving) rows[currentIndex]?.click();
						return;
					}
					const step = event.key === 'ArrowUp' ? -1 : 1;
					const next = rows[(currentIndex + step + rows.length) % rows.length];
					next?.focus({ preventScroll: true });
					next?.scrollIntoView({ block: 'nearest' });
				}}>
				{groups.map((group) => <div className="scribe-chat-model-group" role="group" aria-label={group.label} key={group.id}>
					<div className="scribe-chat-model-group-label" aria-hidden="true">{group.label}</div>
					{group.models.map((model) => <button type="button" role="option" key={model.value} title={model.id}
						aria-selected={value === model.value} aria-disabled={saving || undefined}
						tabIndex={model.value === (focused || current?.value || models[0]?.value) ? 0 : -1}
						onFocus={() => setFocused(model.value)} onClick={() => void choose(model.value)}>
						<span>{model.id}</span>{value === model.value && <ChatIcon name="check" />}
					</button>)}
				</div>)}
			</div>
			{current && <ThinkingSlider {...thinking} disabled={disabled || selecting} onChange={onThinkingChange} />}
		</div>}
	</div>;
}
