import { Menu } from 'obsidian';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { updateOverflowTitle } from '../overflowTitle';
import { uiText } from '../uiText';
import ChatIcon from './ChatIcon';

interface Tab {
	id: string;
	title: string;
	status?: 'running' | 'attention' | 'error';
}

interface Props {
	tabs: readonly Tab[];
	activeId: string;
	onActivate: (id: string) => void;
	onClose: (id: string) => void;
	onRename: (id: string, title: string) => Promise<boolean>;
}

const statusIcons = { running: 'loader-circle', attention: 'bell-dot', error: 'circle-alert' };

export default function ChatTabBar({ tabs, activeId, onActivate, onClose, onRename }: Props) {
	const text = uiText();
	const strip = useRef<HTMLDivElement>(null);
	const activeButton = useRef<HTMLButtonElement>(null);
	const renameInput = useRef<HTMLInputElement>(null);
	const editingSave = useRef(false);
	const restoreFocus = useRef<string | null>(null);
	const menu = useRef<Menu | null>(null);
	const [visibleCount, setVisibleCount] = useState(1);
	const [editing, setEditing] = useState<{ id: string; title: string }>();
	const [saving, setSaving] = useState(false);
	const statuses = { running: text.chatTabRunning, attention: text.chatTabAttention, error: text.chatTabError };
	const visible = tabs.slice(0, visibleCount);
	const active = tabs.find(({ id }) => id === activeId);
	if (active && !visible.includes(active)) visible.splice(visible.length - 1, 1, active);
	const overflow = tabs.filter((tab) => !visible.includes(tab));

	useLayoutEffect(() => {
		const element = strip.current;
		const win = element?.ownerDocument.defaultView;
		if (!element || !win) return;
		const measure = () => {
			const style = win.getComputedStyle(element);
			const tabWidth = Number.parseFloat(style.getPropertyValue('--scribe-tab-width')) || 144;
			const overflowWidth = Number.parseFloat(style.getPropertyValue('--scribe-tab-action-width')) || 28;
			const gap = Number.parseFloat(style.columnGap) || 0;
			const width = element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
			const fit = (reserved: number) => Math.floor((width - reserved + gap) / (tabWidth + gap));
			const withoutOverflow = fit(0);
			setVisibleCount(Math.max(1, withoutOverflow < tabs.length ? fit(overflowWidth + gap) : withoutOverflow));
		};
		measure();
		const resize = new win.ResizeObserver(measure);
		resize.observe(element);
		return () => resize.disconnect();
	}, [tabs.length]);

	useEffect(() => () => {
		const open = menu.current;
		menu.current = null;
		open?.hide();
	}, []);
	useLayoutEffect(() => {
		const editor = renameInput.current;
		if (editor) {
			editor.focus({ preventScroll: true });
			editor.select();
		}
	}, [editing?.id]);
	useLayoutEffect(() => {
		const target = restoreFocus.current;
		if (!target) return;
		restoreFocus.current = null;
		const element = target === activeId ? activeButton.current : strip.current?.querySelector<HTMLButtonElement>(
			`#${CSS.escape(`scribe-tab-${target}`)}`,
		);
		(element ?? activeButton.current)?.focus({ preventScroll: true });
	}, [activeId, editing?.id, tabs.length, visibleCount]);

	function showMenu(next: Menu, anchor: HTMLElement, point?: { x: number; y: number }) {
		menu.current?.hide();
		menu.current = next;
		const bounds = anchor.getBoundingClientRect();
		next.onHide(() => {
			if (menu.current !== next) return;
			menu.current = null;
			const doc = anchor.ownerDocument;
			if (doc.activeElement === doc.body) anchor.focus({ preventScroll: true });
		});
		next.showAtPosition(point ?? { x: bounds.left, y: bounds.bottom, width: bounds.width, overlap: true }, anchor.ownerDocument);
	}

	function close(id: string) {
		restoreFocus.current = activeId;
		onClose(id);
	}

	function contextMenu(tab: Tab, anchor: HTMLElement, point?: { x: number; y: number }) {
		const next = new Menu()
			.addItem((item) => item.setTitle(text.chatRenameConversation).setIcon('pencil')
				.onClick(() => setEditing({ id: tab.id, title: tab.title })))
			.addItem((item) => item.setTitle(text.chatCloseTab).setIcon('x').onClick(() => close(tab.id)));
		showMenu(next, anchor, point);
	}

	async function finishRename(tab: Tab, focus: boolean) {
		if (!editing || editingSave.current) return;
		const title = editing.title.trim();
		if (title && title !== tab.title) {
			editingSave.current = true;
			setSaving(true);
			try {
				if (!(await onRename(tab.id, title))) return;
			} finally {
				editingSave.current = false;
				setSaving(false);
			}
		}
		if (focus) restoreFocus.current = tab.id;
		setEditing(undefined);
	}

	function navigate(event: KeyboardEvent<HTMLButtonElement>, tab: Tab) {
		if (event.nativeEvent.isComposing) return;
		if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
			event.preventDefault();
			contextMenu(tab, event.currentTarget);
			return;
		}
		if (event.key === 'Delete') {
			event.preventDefault();
			close(tab.id);
			return;
		}
		const index = tabs.indexOf(tab);
		const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
		const target = step ? tabs[(index + step + tabs.length) % tabs.length]
			: event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : undefined;
		if (!target) return;
		event.preventDefault();
		if (target.id === activeId) return;
		restoreFocus.current = target.id;
		onActivate(target.id);
	}

	return <div className="scribe-chat-tab-strip" ref={strip}>
		<div className="scribe-chat-tab-list" role="tablist" aria-label={text.chatTabs}>
			{visible.map((tab) => {
				const title = tab.title || text.chatUntitled;
				const description = tab.status && statuses[tab.status];
				const selected = tab.id === activeId;
				return <div className="scribe-chat-tab-item" key={tab.id} data-active={selected || undefined} data-status={tab.status}>
					{editing?.id === tab.id
						? <input type="text" className="scribe-chat-tab-rename" ref={renameInput} aria-label={text.chatConversationTitle}
							value={editing.title} maxLength={120} readOnly={saving}
							onChange={(event) => setEditing({ id: tab.id, title: event.currentTarget.value })}
							onBlur={() => { void finishRename(tab, false); }}
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing || editingSave.current) return;
								if (event.key === 'Enter') {
									event.preventDefault();
									void finishRename(tab, true);
								} else if (event.key === 'Escape') {
									event.preventDefault();
									event.stopPropagation();
									restoreFocus.current = tab.id;
									setEditing(undefined);
								}
							}} />
						: <>
							<button type="button" className="scribe-chat-tab-select" role="tab" id={`scribe-tab-${tab.id}`}
								aria-controls={`scribe-tab-panel-${tab.id}`} aria-selected={selected} tabIndex={selected ? 0 : -1}
								ref={selected ? activeButton : undefined} aria-description={description}
								title={description ? `${title} · ${description}` : undefined} onClick={() => onActivate(tab.id)}
								onPointerEnter={description ? undefined : ({ currentTarget }) => updateOverflowTitle(currentTarget, currentTarget.querySelector('span:last-child'))}
								onKeyDown={(event) => navigate(event, tab)}
								onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
								onAuxClick={(event) => { if (event.button === 1) close(tab.id); }}
								onContextMenu={(event) => {
									event.preventDefault();
									contextMenu(tab, event.currentTarget, { x: event.clientX, y: event.clientY });
								}}>
								<ChatIcon name={tab.status ? statusIcons[tab.status] : 'message-circle'} />
								<span>{title}</span>
							</button>
							<button type="button" className="scribe-chat-tab-close" title={text.chatCloseTab}
								aria-label={`${text.chatCloseTab} · ${title}`} tabIndex={selected ? 0 : -1}
								onClick={() => close(tab.id)}><ChatIcon name="x" /></button>
						</>}
				</div>;
			})}
		</div>
		{overflow.length > 0 && <button type="button" className="scribe-chat-tab-action" aria-haspopup="menu"
			aria-label={text.chatMoreTabs} title={text.chatMoreTabs} onClick={(event) => {
				const next = new Menu();
				for (const tab of overflow) {
					const title = tab.title || text.chatUntitled;
					const description = tab.status && statuses[tab.status];
					next.addItem((item) => item.setTitle(description ? `${title} · ${description}` : title)
						.setIcon(tab.status ? statusIcons[tab.status] : 'message-circle').onClick(() => {
							restoreFocus.current = tab.id;
							onActivate(tab.id);
						}));
				}
				showMenu(next, event.currentTarget);
			}}><ChatIcon name="ellipsis" /></button>}
	</div>;
}
