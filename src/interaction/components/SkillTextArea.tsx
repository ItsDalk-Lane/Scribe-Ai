import { getLanguage } from 'obsidian';
import { useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import type { RefObject, TextareaHTMLAttributes } from 'react';
import type { NoteRef, SkillInfo, SkillRegistry, TaskTarget } from '../../types';
import type { SkillScanIssue } from '../../skills/discovery';
import type { SlashUi } from '../slashUi';
import { slashCommandQuery } from '../slashCommands';
import { INSTALLER_ID } from '../../orchestration/context/skills';
import { isImeComposing } from '../composerKeyboard';
import { composerBodyEdit, composerTargetPrefix, deleteSkillAtCaret, editSkillText, insertSkill, skillMentionParts, skillQuery } from './skillMentionText';
import type { SkillDraft } from './skillMentionText';
import ChatIcon from './ChatIcon';
import { useSlashSuggestions } from './SlashSuggestions';
import type { SlashLauncher, SlashSuggestionOptions } from './SlashSuggestions';
import { useReferenceSuggestions } from './ContextPicker';
import type { ReferenceLauncher, ReferenceSuggestionOptions } from './ContextPicker';

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> {
	inputRef: RefObject<HTMLTextAreaElement | null>;
	menuRef?: RefObject<(() => void) | null>;
	closeMenuRef?: RefObject<(() => void) | null>;
	draft: SkillDraft;
	target?: TaskTarget;
	onRemoveTarget?: () => void;
	registry: SkillRegistry;
	refs: NoteRef[];
	scope?: string[];
	slash?: SlashSuggestionOptions;
	slashLauncher?: SlashLauncher;
	references?: ReferenceSuggestionOptions;
	referenceLauncher?: ReferenceLauncher;
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

export default function SkillTextArea({ inputRef, menuRef, closeMenuRef, registry, refs, scope, slash, slashLauncher,
	references, referenceLauncher, panelUiRef, draft, target, onRemoveTarget, onDraftChange, readOnly, onKeyDown, ...input }: Props) {
	const text = skillMenuText();
	const id = useId();
	const [caret, setCaret] = useState<number | null>(null);
	const [manage, setManage] = useState(false);
	const [search, setSearch] = useState('');
	const [active, setActive] = useState(-1);
	const [catalog, setCatalog] = useState<{ scopeKey: string; items: SkillInfo[] }>();
	const [issues, setIssues] = useState<SkillScanIssue[]>([]);
	const [error, setError] = useState('');
	const [changing, setChanging] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const filter = useRef<HTMLInputElement>(null);
	const options = useRef<HTMLDivElement>(null);
	const layer = useRef<HTMLDivElement>(null);
	const chipped = Boolean(input.className?.includes('scribe-input'));
	const prefix = composerTargetPrefix(target);
	const bodyOffset = (position: number) => Math.max(0, position - prefix.length);

	function restoreCaret(value: string, position: number) {
		inputRef.current?.ownerDocument.defaultView?.requestAnimationFrame(() => {
			const field = inputRef.current;
			if (field?.value === value) field.setSelectionRange(position, position);
		});
	}

	function trackCaret(field: HTMLTextAreaElement) {
		const { selectionStart, selectionEnd, selectionDirection } = field;
		if (selectionStart === selectionEnd) {
			if (selectionStart < prefix.length) field.setSelectionRange(prefix.length, prefix.length);
			setCaret(bodyOffset(selectionStart));
			return;
		}
		// 跨过标签的选区必须包含整个标签，确保粘贴或删除时同步取消目标。
		if (selectionStart < prefix.length && (selectionStart !== 0 || selectionEnd < prefix.length)) {
			field.setSelectionRange(0, Math.max(selectionEnd, prefix.length), selectionDirection);
		}
		setCaret(null);
	}

	function completeText(instruction: string, cursor: number) {
		onDraftChange(editSkillText(draft, instruction, cursor));
		setCaret(cursor);
		restoreCaret(prefix + instruction, prefix.length + cursor);
	}
	const context = useReferenceSuggestions({
		inputRef, instruction: draft.instruction, caret, launcher: referenceLauncher,
		options: manage || readOnly || slashLauncher?.open ? undefined : references, onComplete: completeText,
	});
	const mentionQuery = caret === null || manage || readOnly || context.visible ? undefined : skillQuery(draft.instruction, caret);
	const slashQuery = caret === null || manage || readOnly || context.visible || !slash || slashLauncher?.open
		? undefined : slashCommandQuery(draft.instruction, caret);
	const scopeKey = !readOnly && (manage || mentionQuery || slashQuery?.prefix)
		? JSON.stringify(scope ?? registry.scope(refs)) : '';
	const items = catalog?.scopeKey === scopeKey ? catalog.items : undefined;
	const commands = useSlashSuggestions({
		instruction: draft.instruction, caret, options: manage || readOnly || context.visible ? undefined : slash, launcher: slashLauncher,
		skills: items ?? [], onChooseSkill: (item, tokenEnd) => applySkill(item, 0, tokenEnd),
		onComplete: completeText,
	});
	if (panelUiRef) panelUiRef.current = commands.ui;
	const query = commands.id ? undefined : mentionQuery;
	const visible = !readOnly && Boolean(manage || query);
	const term = (manage ? search : query?.query ?? '').toLowerCase();
	const matches = items?.filter((item) => (manage || (item.enabled && item.manual))
		&& [item.name, item.displayName, item.description, item.sourceLabel].some((part) => part?.toLowerCase().includes(term))) ?? [];
	const chosen = matches[active];

	useEffect(() => {
		if (!scopeKey) return;
		let version = 0;
		const load = () => {
			const current = ++version;
			setError('');
			setCatalog(undefined);
			setIssues([]);
			void registry.inspect([], '', JSON.parse(scopeKey) as string[]).then((report) => {
				if (version === current) { setCatalog({ scopeKey, items: report.items }); setIssues(report.issues); }
			}, (cause: unknown) => {
				if (version === current) setError(cause instanceof Error ? cause.message : text.fail);
			});
		};
		const unsubscribe = registry.subscribe(load);
		load();
		return () => { version++; unsubscribe(); };
	}, [scopeKey, refresh, registry, text.fail]);

	useEffect(() => {
		if (manage) filter.current?.focus();
	}, [manage]);
	useEffect(() => {
		if (!manage && active >= 0) options.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [active, manage]);

	function close(focus: boolean) {
		if (context.visible) context.dismiss();
		slashLauncher?.close();
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
		const field = inputRef.current;
		const start = query?.start ?? (field ? bodyOffset(field.selectionStart) : draft.instruction.length);
		const end = query?.end ?? (field ? bodyOffset(field.selectionEnd) : start);
		applySkill(item, start, end);
	}

	function applySkill(item: SkillInfo, start: number, end: number) {
		if (!scopeKey || !item.enabled || !item.manual) return;
		const next = insertSkill(draft, start, end, item);
		onDraftChange({ ...next, skillScope: JSON.parse(scopeKey) as string[] });
		close(true);
		restoreCaret(prefix + next.instruction, prefix.length + next.cursor);
	}

	async function toggle(item: SkillInfo) {
		setChanging(true);
		try {
			await registry.setEnabled(item.id, !item.enabled);
			setRefresh((n) => n + 1);
		} catch (cause) { setError(cause instanceof Error ? cause.message : text.fail); }
		finally { setChanging(false); }
	}

	return <div className="scribe-composer-skill-field" data-target={target?.kind} onBlur={(event) => {
		if (!event.currentTarget.contains(event.relatedTarget) && !context.keepOnBlur()) close(false);
	}} onKeyDown={(event) => {
		if (context.onKeyDown(event)) return;
		if (event.defaultPrevented || (!visible && !commands.id) || isImeComposing(event.nativeEvent) || event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		if (commands.id) {
			inputRef.current?.focus({ preventScroll: true });
			commands.dismiss();
		} else close(true);
	}}>
		{chipped && <div ref={layer} className="scribe-skill-mention-layer" aria-hidden="true">
			{target && <><span className="scribe-skill-mention-chip scribe-target-mention-chip">
				<ChatIcon name={target.kind === 'mcp' ? 'plug' : 'bot'} />{target.label}
			</span>{prefix.slice(target.label.length)}</>}
			{skillMentionParts(draft.instruction, draft.skillMentions).map((part, index) => typeof part === 'string' ? part
				: <span key={index} className="scribe-skill-mention-chip">{part.text}</span>)}{'\u200b'}
		</div>}
		<textarea {...input} ref={inputRef} value={prefix + draft.instruction} readOnly={readOnly} spellCheck={false}
			aria-autocomplete="list" aria-controls={context.optionsId ?? commands.id ?? (visible ? id : undefined)}
			aria-activedescendant={context.activeId ?? commands.activeId ?? (visible && chosen ? `${id}-${active}` : undefined)}
			onScroll={(event) => { if (layer.current) layer.current.scrollTop = event.currentTarget.scrollTop; }}
			onFocus={(event) => {
				trackCaret(event.currentTarget);
				input.onFocus?.(event);
			}}
			onChange={(event) => {
				const field = event.currentTarget;
				slashLauncher?.close();
				const edit = composerBodyEdit(field.value, field.selectionStart, prefix);
				if (edit.removedTarget) onRemoveTarget?.();
				onDraftChange(editSkillText(draft, edit.instruction, edit.caret));
				setCaret(field.selectionStart === field.selectionEnd ? edit.caret : null);
				setActive(-1);
			}}
			onSelect={(event) => trackCaret(event.currentTarget)}
			onKeyDown={(event) => {
				if (isImeComposing(event.nativeEvent)) return;
				const { selectionStart, selectionEnd } = event.currentTarget;
				if (!readOnly && prefix && event.key === 'Backspace' && selectionStart === selectionEnd && selectionStart <= prefix.length) {
					event.preventDefault();
					onRemoveTarget?.();
					setCaret(0);
					restoreCaret(draft.instruction, 0);
					return;
				}
				if (chipped && !readOnly && event.key === 'Backspace' && selectionStart === selectionEnd
					&& !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
					const deletion = deleteSkillAtCaret(draft, bodyOffset(selectionStart));
					if (deletion) {
						event.preventDefault();
						completeText(deletion.instruction, deletion.cursor);
						return;
					}
				}
				if (context.onKeyDown(event) || commands.onKeyDown(event)) return;
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
		{context.menu}
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
