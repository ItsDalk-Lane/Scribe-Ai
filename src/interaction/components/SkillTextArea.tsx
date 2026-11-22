import { getLanguage } from 'obsidian';
import { useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import type { RefObject, TextareaHTMLAttributes } from 'react';
import type { NoteRef, SkillInfo, SkillRegistry } from '../../types';
import type { SkillScanIssue } from '../../skills/discovery';
import type { SlashUi } from '../slashUi';
import { INSTALLER_ID } from '../../orchestration/context/skills';
import { isImeComposing } from '../composerKeyboard';
import { editSkillText, insertSkill, skillMentionParts, skillQuery } from './skillMentionText';
import type { SkillDraft } from './skillMentionText';
import ChatIcon from './ChatIcon';
import { useSlashSuggestions } from './SlashSuggestions';
import type { SlashSuggestionOptions } from './SlashSuggestions';

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> {
	inputRef: RefObject<HTMLTextAreaElement | null>;
	menuRef?: RefObject<(() => void) | null>;
	closeMenuRef?: RefObject<(() => void) | null>;
	draft: SkillDraft;
	registry: SkillRegistry;
	refs: NoteRef[];
	scope?: string[];
	slash?: SlashSuggestionOptions;
	panelUiRef?: { current: SlashUi | null };
	onDraftChange: (draft: SkillDraft) => void;
}

export function skillMenuText() {
	const lang = getLanguage().toLowerCase();
	if (lang.startsWith('zh')) return /tw|hk|hant/u.test(lang)
		? { title: '技能', search: '搜尋技能', empty: '沒有符合的技能', loading: '正在讀取技能…', enable: '啟用', disable: '停用', close: '關閉', choose: '選擇技能', fail: '讀取技能失敗', manual: '僅限自動使用', retry: '重試', issues: '掃描提示' }
		: { title: '技能', search: '搜索技能', empty: '没有符合的技能', loading: '正在读取技能…', enable: '启用', disable: '停用', close: '关闭', choose: '选择技能', fail: '读取技能失败', manual: '仅限自动使用', retry: '重试', issues: '扫描提示' };
	return { title: 'Skills', search: 'Search skills', empty: 'No matching skills', loading: 'Loading skills…', enable: 'Enable', disable: 'Disable', close: 'Close', choose: 'Choose a skill', fail: 'Could not load skills', manual: 'Automatic use only', retry: 'Retry', issues: 'Scan notices' };
}

type SkillMenuCopy = ReturnType<typeof skillMenuText>;
export function SkillMenuRow({ item, text, id, selected, toggle, choosing, onChoose, onToggle }: {
	item: SkillInfo; text: SkillMenuCopy; id?: string; selected?: boolean; toggle: boolean;
	choosing: boolean; onChoose: (item: SkillInfo) => void; onToggle: (item: SkillInfo) => void;
}) {
	return <div className="scribe-skill-menu-row" role="presentation">
		<button type="button" id={id} role={id ? 'option' : undefined} aria-selected={id ? Boolean(selected) : undefined}
			disabled={!item.enabled || !item.manual} title={[item.manual ? item.description : text.manual, item.sourceLabel, item.id].join('\n')}
			onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(item)}>
			<span className="scribe-skill-menu-name">{item.displayName || item.name}</span>
			<span className="scribe-skill-badge">{item.sourceLabel}</span>
			{item.description && <span className="scribe-skill-menu-description">{item.description}</span>}
		</button>
		{toggle && item.id !== INSTALLER_ID && <button type="button" role="switch" aria-checked={item.enabled} disabled={choosing}
			aria-label={`${item.name} · ${item.sourceLabel}`} title={item.enabled ? text.disable : text.enable}
			onClick={() => onToggle(item)}><ChatIcon name={item.enabled ? 'toggle-right' : 'toggle-left'} /></button>}
	</div>;
}

export default function SkillTextArea({ inputRef, menuRef, closeMenuRef, registry, refs, scope, slash, panelUiRef, draft, onDraftChange, readOnly, onKeyDown, ...input }: Props) {
	const text = skillMenuText();
	const id = useId();
	const [caret, setCaret] = useState<number | null>(null);
	const [manage, setManage] = useState(false);
	const [search, setSearch] = useState('');
	const [active, setActive] = useState(-1);
	const [items, setItems] = useState<SkillInfo[]>();
	const [issues, setIssues] = useState<SkillScanIssue[]>([]);
	const [error, setError] = useState('');
	const [changing, setChanging] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const filter = useRef<HTMLInputElement>(null);
	const options = useRef<HTMLDivElement>(null);
	const layer = useRef<HTMLDivElement>(null);
	const chipped = Boolean(input.className?.includes('scribe-input'));
	const commands = useSlashSuggestions({
		instruction: draft.instruction, caret, options: manage || readOnly ? undefined : slash,
		onComplete: (instruction, cursor) => {
			onDraftChange(editSkillText(draft, instruction, cursor));
			setCaret(cursor);
			inputRef.current?.ownerDocument.defaultView?.requestAnimationFrame(() => {
				const field = inputRef.current;
				if (field?.value === instruction) field.setSelectionRange(cursor, cursor);
			});
		},
	});
	if (panelUiRef) panelUiRef.current = commands.ui;
	const query = caret === null || manage || readOnly || commands.id ? undefined : skillQuery(draft.instruction, caret);
	const visible = !readOnly && Boolean(manage || query);
	const scopeKey = visible ? JSON.stringify(scope ?? registry.scope(refs)) : '';
	const term = (manage ? search : query?.query ?? '').toLowerCase();
	const matches = items?.filter((item) => (manage || (item.enabled && item.manual))
		&& [item.name, item.displayName, item.description, item.sourceLabel].some((part) => part?.toLowerCase().includes(term))) ?? [];
	const chosen = matches[active];

	useEffect(() => {
		if (!visible) return;
		let version = 0;
		const load = () => {
			const current = ++version;
			setError('');
			setItems(undefined);
			setIssues([]);
			void registry.inspect([], '', JSON.parse(scopeKey) as string[]).then((report) => {
				if (version === current) { setItems(report.items); setIssues(report.issues); }
			}, (cause: unknown) => {
				if (version === current) setError(cause instanceof Error ? cause.message : text.fail);
			});
		};
		const unsubscribe = registry.subscribe(load);
		load();
		return () => { version++; unsubscribe(); };
	}, [visible, scopeKey, refresh, registry, text.fail]);

	useEffect(() => {
		if (manage) filter.current?.focus();
	}, [manage]);
	useEffect(() => {
		if (!manage && active >= 0) options.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [active, manage]);

	function close(focus: boolean) {
		setManage(false);
		setCaret(null);
		setActive(-1);
		if (focus) inputRef.current?.focus({ preventScroll: true });
	}

	function openMenu() {
		if (readOnly) return;
		setSearch('');
		setActive(-1);
		setManage(true);
	}
	useImperativeHandle(menuRef, () => openMenu);
	useImperativeHandle(closeMenuRef, () => () => close(false));

	function choose(item: SkillInfo) {
		if (!item.enabled || !item.manual) return;
		const start = query?.start ?? inputRef.current?.selectionStart ?? draft.instruction.length;
		const end = query?.end ?? inputRef.current?.selectionEnd ?? start;
		const next = insertSkill(draft, start, end, item);
		onDraftChange({ ...next, skillScope: JSON.parse(scopeKey) as string[] });
		close(true);
		inputRef.current?.ownerDocument.defaultView?.requestAnimationFrame(() => {
			inputRef.current?.setSelectionRange(next.cursor, next.cursor);
		});
	}

	async function toggle(item: SkillInfo) {
		setChanging(true);
		try {
			await registry.setEnabled(item.id, !item.enabled);
			setRefresh((n) => n + 1);
		} catch (cause) { setError(cause instanceof Error ? cause.message : text.fail); }
		finally { setChanging(false); }
	}

	return <div className="scribe-composer-skill-field" onBlur={(event) => {
		if (!event.currentTarget.contains(event.relatedTarget)) close(false);
	}} onKeyDown={(event) => {
		if (event.defaultPrevented || (!visible && !commands.id) || isImeComposing(event.nativeEvent) || event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		if (commands.id) {
			inputRef.current?.focus({ preventScroll: true });
			commands.dismiss();
		} else close(true);
	}}>
		{chipped && <div ref={layer} className="scribe-skill-mention-layer" aria-hidden="true">
			{skillMentionParts(draft.instruction, draft.skillMentions).map((part, index) => typeof part === 'string' ? part
				: <span key={index} className="scribe-skill-mention-chip">{part.text}</span>)}{'\u200b'}
		</div>}
		<textarea {...input} ref={inputRef} value={draft.instruction} readOnly={readOnly} spellCheck={false}
			aria-autocomplete="list" aria-controls={commands.id ?? (visible ? id : undefined)}
			aria-activedescendant={commands.activeId ?? (visible && chosen ? `${id}-${active}` : undefined)}
			onScroll={(event) => { if (layer.current) layer.current.scrollTop = event.currentTarget.scrollTop; }}
			onFocus={(event) => {
				const field = event.currentTarget;
				setCaret(field.selectionStart === field.selectionEnd ? field.selectionStart : null);
				input.onFocus?.(event);
			}}
			onChange={(event) => {
				const field = event.currentTarget;
				onDraftChange(editSkillText(draft, field.value, field.selectionStart));
				setCaret(field.selectionStart === field.selectionEnd ? field.selectionStart : null);
				setActive(-1);
			}}
			onSelect={(event) => {
				const field = event.currentTarget;
				setCaret(field.selectionStart === field.selectionEnd ? field.selectionStart : null);
			}}
			onKeyDown={(event) => {
				if (isImeComposing(event.nativeEvent) || commands.onKeyDown(event)) return;
				if (visible && !manage && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
					if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
					if (matches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
						event.preventDefault();
						setActive(event.key === 'ArrowDown' ? (active + 1) % matches.length : (active < 1 ? matches.length : active) - 1);
						return;
					}
					if ((event.key === 'Tab' || event.key === 'Enter') && (chosen || (query && matches.length === 1))) {
						event.preventDefault();
						const row = chosen ?? matches[0];
						if (row && !event.repeat) choose(row);
						return;
					}
				}
				onKeyDown?.(event);
			}} />
		{commands.menu}
		{visible && <div ref={options} className="scribe-skill-suggestions scribe-context-popover" aria-label={text.title}>
			{manage && <div className="scribe-skill-menu-header">
				<input ref={filter} aria-label={text.search} placeholder={text.search} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
				<button type="button" title={text.close} aria-label={text.close} onClick={() => close(true)}><ChatIcon name="x" /></button>
			</div>}
			{error && <p role="alert">{error} <button type="button" onClick={() => setRefresh((n) => n + 1)}>{text.retry}</button></p>}
			{manage && issues.length > 0 && <details className="scribe-skill-scan-notices">
				<summary>{text.issues} ({issues.length})</summary>
				<ul>{issues.map((issue) => <li key={issue.path}><strong>{issue.path}</strong><div>{issue.reason}</div></li>)}</ul>
			</details>}
			{!error && !items && <p role="status">{text.loading}</p>}
			{!error && items && !matches.length && <p role="status">{text.empty}</p>}
			<div id={id} role={manage ? 'group' : 'listbox'} aria-label={text.choose}>
				{matches.map((item, index) => <SkillMenuRow key={item.id} item={item} text={text} id={`${id}-${index}`}
					selected={index === active} toggle={manage} choosing={changing} onChoose={choose} onToggle={(row) => void toggle(row)} />)}
			</div>
		</div>}
	</div>;
}
