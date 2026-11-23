import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { composerShortcut } from '../composerKeyboard';
import { updateOverflowTitle } from '../overflowTitle';
import { paintProviderIcon } from '../paintProviderIcon';
import { thinkingLabel, uiText } from '../uiText';
import type { ChatModelGroup } from '../useChatModel';
import ChatIcon from './ChatIcon';
import ThinkingSlider from './ThinkingSlider';
import type { ThinkingSelection } from './ThinkingSlider';

interface Props {
	groups: ChatModelGroup[];
	value: string;
	thinking: ThinkingSelection;
	disabled: boolean;
	saving: boolean;
	selecting: boolean;
	triggerRef?: RefObject<HTMLButtonElement | null>;
	onSelect: (value: string) => Promise<boolean>;
	onThinkingChange: (level: string) => void;
}

function ProviderIcon({ id, label }: Pick<ChatModelGroup, 'id' | 'label'>) {
	const attach = useCallback((element: HTMLSpanElement | null) => {
		if (!element) return;
		element.replaceChildren();
		paintProviderIcon(element, id, label);
	}, [id, label]);
	return <span ref={attach} className="scribe-chat-provider-icon" aria-hidden="true" />;
}

export default function ChatModelPicker({ groups, value, thinking, disabled, saving, selecting, triggerRef, onSelect, onThinkingChange }: Props) {
	const text = uiText();
	const id = useId();
	const popup = useRef<HTMLDivElement>(null);
	const localTrigger = useRef<HTMLButtonElement>(null);
	const trigger = triggerRef ?? localTrigger;
	const providerTrigger = useRef<HTMLButtonElement>(null);
	const searchInput = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [browsed, setBrowsed] = useState('');
	const [providersOpen, setProvidersOpen] = useState(false);
	const [query, setQuery] = useState('');
	const currentGroup = groups.find(({ models }) => models.some((model) => model.value === value));
	const current = currentGroup?.models.find((model) => model.value === value);
	const group = groups.find(({ id }) => id === browsed) ?? currentGroup ?? groups.find(({ models }) => models.length) ?? groups[0];
	const models = group?.models.filter(({ id }) => id.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
	const level = thinking.level ?? thinking.levels[0];
	const effort = current && level ? thinkingLabel(text, level) : undefined;
	const modelLabel = current && (effort ? `${current.id} · ${effort}` : current.id);
	const expanded = open && !disabled && Boolean(group);

	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);

	function close(restore = false) {
		setOpen(false);
		if (restore) trigger.current?.focus({ preventScroll: true });
	}

	function show() {
		setBrowsed('');
		setQuery('');
		setProvidersOpen(false);
		setOpen(true);
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
			const left = Math.max(0, bounds.left) + 4;
			const right = Math.min(win.innerWidth, bounds.right) - 4;
			const rtl = win.getComputedStyle(button).direction === 'rtl';
			const inline = rtl ? right - anchor.left : anchor.right - left;
			const panelWidth = inline >= 310 ? Math.max(170, inline - 146) : inline;
			panel.style.setProperty('--scribe-model-width', `${Math.max(0, Math.floor(panelWidth))}px`);
			panel.style.setProperty('--scribe-model-height', `${Math.max(0, Math.floor(anchor.top - Math.max(0, bounds.top) - 8))}px`);
			const menu = panel.getBoundingClientRect();
			const before = rtl ? right - menu.right : menu.left - left;
			const after = rtl ? menu.left - left : right - menu.right;
			panel.dataset.providerSide = before >= 142 ? 'before' : after >= 142 ? 'after' : 'inside';
			panel.style.setProperty('--scribe-provider-width', `${Math.floor(Math.max(0, before, after))}px`);
		};
		const dismiss = (event: PointerEvent) => {
			const path = event.composedPath();
			if (!path.includes(button) && !path.includes(panel)) close();
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
		providerTrigger.current?.focus({ preventScroll: true });
		return () => {
			observer.disconnect();
			doc.removeEventListener('scroll', measure, true);
			doc.removeEventListener('pointerdown', dismiss);
			win.removeEventListener('resize', measure);
		};
	}, [expanded, trigger]);

	async function choose(model: string) {
		if (!saving && await onSelect(model) && popup.current) close(true);
	}

	return <div className="scribe-chat-model-picker" onBlur={(event) => {
		if (expanded && !event.currentTarget.contains(event.relatedTarget)) close();
	}} onKeyDown={(event) => {
		if (!expanded || event.defaultPrevented || composerShortcut(event.nativeEvent) !== 'escape') return;
		event.preventDefault();
		event.stopPropagation();
		if (providersOpen) {
			providerTrigger.current?.focus({ preventScroll: true });
			setProvidersOpen(false);
		} else close(true);
	}}>
		<button type="button" ref={trigger} className="scribe-compose-model" disabled={disabled || !group}
			aria-label={modelLabel ? `${text.chatChooseModel} · ${modelLabel}` : text.chatChooseModel}
			title={modelLabel ?? text.chatModelMissing} aria-haspopup="dialog"
			aria-expanded={expanded} aria-controls={expanded ? id : undefined} aria-disabled={saving || undefined}
			onClick={() => {
				if (expanded) close();
				else if (!saving) show();
			}} onKeyDown={(event) => {
				if (!expanded && !saving && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
					event.preventDefault();
					show();
				}
			}}>
			<span>{current?.id ?? text.chatNoModelSelected}</span>
			{effort && <span className="scribe-compose-effort">{effort}</span>}
			<ChatIcon name="chevron-down" />
		</button>
		{expanded && group && <div id={id} className="scribe-chat-model-panel" ref={popup} role="dialog" aria-label={text.chatChooseModel}>
			<div className="scribe-chat-provider-row" onPointerLeave={(event) => {
				if (event.pointerType !== 'mouse') return;
				const focused = event.currentTarget.ownerDocument.activeElement;
				if (focused?.closest('.scribe-chat-provider-options')) return;
				setProvidersOpen(false);
			}} onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setProvidersOpen(false);
			}}>
				<button type="button" className="scribe-chat-provider-trigger" ref={providerTrigger}
					aria-label={`${text.chatChooseProvider} · ${group.label}`} aria-expanded={providersOpen}
					aria-controls={providersOpen ? `${id}-providers` : undefined}
					onPointerEnter={(event) => { if (event.pointerType === 'mouse') setProvidersOpen(true); }}
					onClick={() => setProvidersOpen(true)}>
					<ProviderIcon id={group.id} label={group.label} /><span>{group.label}</span><ChatIcon name="chevron-right" />
				</button>
				{providersOpen && <div className="scribe-chat-provider-options" id={`${id}-providers`} role="group" aria-label={text.chatChooseProvider}>
					{groups.map(({ id, label }) => <button key={id} type="button" aria-current={id === group.id || undefined} onClick={() => {
						setBrowsed(id);
						setQuery('');
						searchInput.current?.focus({ preventScroll: true });
						setProvidersOpen(false);
					}}>
						<ProviderIcon id={id} label={label} /><span>{label}</span>{id === group.id && <ChatIcon name="check" />}
					</button>)}
				</div>}
			</div>
			<div className="scribe-chat-model-body">
				<label className="scribe-chat-model-search">
					<span>{text.models}</span>
					<ChatIcon name="search" />
					<input ref={searchInput} type="search" aria-label={text.searchAvailableModels} placeholder={text.searchAvailableModels}
						value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
				</label>
				<div className="scribe-chat-model-options" role="group" aria-label={text.chatChooseModel} aria-busy={saving || undefined}
					onKeyDown={(event) => {
						if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
						event.preventDefault();
						const rows = Array.from(event.currentTarget.querySelectorAll('button'));
						const index = rows.findIndex((row) => row === event.target);
						const next = rows[(index + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length];
						next?.focus();
					}}>
					{models.map((model) => <button type="button" key={model.value}
						onPointerEnter={({ currentTarget }) => updateOverflowTitle(currentTarget, currentTarget.querySelector('span'))}
						aria-current={value === model.value || undefined} aria-disabled={saving || undefined} onClick={() => void choose(model.value)}>
						<span>{model.id}</span>
						{model.vision && <small>{text.chatVisionModel}</small>}
						{value === model.value && <ChatIcon name="check" />}
					</button>)}
					{!models.length && <p role="status">{group.models.length ? text.noModelsMatch : text.noModelsAdded}</p>}
				</div>
				{currentGroup === group && <ThinkingSlider {...thinking} disabled={disabled || selecting} onChange={onThinkingChange} />}
			</div>
		</div>}
	</div>;
}
