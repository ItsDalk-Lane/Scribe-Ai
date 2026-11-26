import { getLanguage, Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { LocalState } from '../orchestration/storage/localState';
import type { ConversationStore, RunState } from '../types';
import { finishGoalRound, MAX_GOAL_CRITERIA, MAX_GOAL_LENGTH, parseChatGoal,
	setGoalWorkClock, validGoalCriteria } from './chatGoal';
import type { ChatGoal, GoalPause, GoalWorkClock } from './chatGoal';
import { confirmAction } from './ConfirmModal';
import type { SlashUi } from './slashUi';

export function goalText() {
	const chinese = getLanguage().toLowerCase().startsWith('zh');
	return chinese ? {
		title: '聊天目标', objective: '目标内容', criteria: '验收条件（每行一项）', create: '启动目标',
		edit: '编辑', resume: '继续', pause: '暂停', clear: '清除', cancel: '取消', save: '保存',
		replace: '启动新目标会替换当前目标，聊天记录会保留。', confirmClear: '清除这个目标？聊天记录会保留。',
		invalidObjective: `请输入不超过 ${MAX_GOAL_LENGTH} 个字符的目标。`, invalidContext: '目标包含无效的资料或技能，请重新选择。',
		invalid: `请输入目标，填写最多 ${MAX_GOAL_CRITERIA} 项验收条件。`,
		missing: '请先输入 /goal 和目标内容。', saveFailed: '目标进度保存失败，自动续做已停止。',
		loadFailed: '无法读取目标记录，请重新打开聊天。', checked: '已核对', remaining: '待处理', working: '正在执行本轮', changed: '目标已更改，请重新打开。', waiting: '等待本聊天空闲后继续',
		active: '进行中', paused: '已暂停', complete: '已完成', current: '本次', total: '累计轮数',
		proof: '完成依据', reasons: {
			manual: '已手动暂停。', plan: '已切换到计划模式。', closed: '聊天已关闭或重开，请手动继续。', stalled: '上一轮未取得可确认的新进展。请查看聊天记录。', failed: '上一轮未成功结束，请查看聊天记录。',
			blocked: '需要你处理上一轮的问题。处理后可手动继续。',
		},
	} : {
		title: 'Chat goal', objective: 'Objective', criteria: 'Acceptance criteria (one per line)', create: 'Start goal',
		edit: 'Edit', resume: 'Resume', pause: 'Pause', clear: 'Clear', cancel: 'Cancel', save: 'Save',
		replace: 'Starting a new goal replaces the current goal. Chat history will be kept.', confirmClear: 'Clear this goal? Chat history will be kept.',
		invalidObjective: `Enter an objective of up to ${MAX_GOAL_LENGTH} characters.`, invalidContext: 'Select the goal’s attachments or skills again.',
		invalid: `Enter a goal, up to ${MAX_GOAL_CRITERIA} acceptance criteria.`,
		missing: 'Enter /goal followed by your objective first.', saveFailed: 'The goal could not be saved. Automatic work has stopped.',
		loadFailed: 'The goal could not be loaded. Reopen the chat.', checked: 'Checked', remaining: 'Remaining', working: 'Working on this round', changed: 'The goal changed. Open the editor again.', waiting: 'Waiting for this chat to become idle',
		active: 'In progress', paused: 'Paused', complete: 'Complete', current: 'This start', total: 'Total rounds',
		proof: 'Completion evidence', reasons: {
			manual: 'Paused manually.', plan: 'Switched to Plan mode.', closed: 'The chat was closed or reopened. Resume to continue.', stalled: 'The last round made no confirmed progress. See chat history.', failed: 'The last round ended early. See chat history.',
			blocked: 'The last round needs your attention. Resume when ready.',
		},
	};
}

type GoalContext = Pick<ChatGoal, 'refs' | 'imageSourcePath' | 'chatQuotes' | 'skillMentions' | 'skillScope' | 'skillNotePaths'>;
type GoalDraft = Pick<ChatGoal, 'objective' | 'criteria'>;

function editGoal(app: App, draft: GoalDraft, ui?: SlashUi) {
	const text = goalText();
	function render(host: HTMLElement, done: (value?: GoalDraft) => void) {
		let objective: HTMLTextAreaElement | undefined;
		let criteria: HTMLTextAreaElement | undefined;
		new Setting(host).setName(text.objective).addTextArea((field) => {
			objective = field.setValue(draft.objective).inputEl;
			objective.rows = 4;
			objective.maxLength = MAX_GOAL_LENGTH;
			objective.setAttribute('aria-label', text.objective);
		});
		new Setting(host).setName(text.criteria).addTextArea((field) => {
			criteria = field.setValue(draft.criteria?.join('\n') ?? '').inputEl;
			criteria.rows = 3;
			criteria.setAttribute('aria-label', text.criteria);
		});
		const error = host.createDiv({ cls: 'scribe-chat-error', attr: { role: 'alert' } });
		new Setting(host).addButton((button) => button.setButtonText(text.cancel).onClick(() => done()))
			.addButton((button) => button.setButtonText(text.save).setCta().onClick(() => {
				const value = objective?.value.trim();
				const checks = [...new Set(criteria?.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))];
				const conditions = checks.length ? checks : [value];
				if (!value || value.length > MAX_GOAL_LENGTH || !validGoalCriteria(conditions)) {
					error.setText(text.invalid);
					return;
				}
				done({ objective: value, criteria: conditions });
			}));
		queueMicrotask(() => objective?.focus());
	}
	if (ui) return ui.custom<GoalDraft>(text.title, render);
	return new Promise<GoalDraft | undefined>((resolve) => {
		const modal = new Modal(app);
		modal.modalEl.addClass('scribe-goal-modal');
		let result: GoalDraft | undefined;
		modal.setTitle(text.title);
		modal.onOpen = () => render(modal.contentEl, (value) => { result = value; modal.close(); });
		modal.onClose = () => resolve(result);
		modal.open();
	});
}

function confirmGoal(app: App, message: string, confirmText: string, ui?: SlashUi): Promise<boolean> {
	const text = goalText();
	if (ui) return ui.confirm(text.title, message, confirmText);
	return new Promise((resolve) => {
		let accepted = false;
		confirmAction(app, { title: text.title, message, confirmText, cancelText: text.cancel,
			onConfirm: () => { accepted = true; }, onClose: () => resolve(accepted) });
	});
}

interface GoalOptions {
	app: App;
	store: Pick<ConversationStore, 'loadGoal' | 'saveGoal'>;
	localState: LocalState;
	conversationId: string;
	isOpen: boolean;
	canContinue: boolean;
	start: (goal: ChatGoal) => Promise<RunState | undefined>;
	stopRunning: () => void;
	onDefinitionChange: () => void;
}

export function useChatGoal({ app, store, localState, conversationId, isOpen, canContinue, start, stopRunning, onDefinitionChange }: GoalOptions) {
	const [goal, setGoal] = useState<ChatGoal>();
	const [ready, setReady] = useState(false);
	const [opened, setOpened] = useState(false);
	const [error, setError] = useState('');
	const [working, setWorking] = useState(false);
	const [workClock, setWorkClock] = useState<GoalWorkClock>({ workedMs: 0 });
	const clock = useRef(workClock);
	const workOwner = useRef<ChatGoal>(undefined);
	const current = useRef<ChatGoal>(undefined);
	const saved = useRef<ChatGoal>(undefined);
	const writes = useRef(Promise.resolve());
	const revision = useRef(0);
	const mounted = useRef(false);
	const running = useRef(false);
	const writeFailed = useRef(false);
	const open = useRef(isOpen);
	const changing = useRef(false);

	function updateClock(value: GoalWorkClock) {
		if (clock.current.workedMs === value.workedMs && clock.current.startedAt === value.startedAt) return;
		clock.current = value;
		if (mounted.current) setWorkClock(value);
	}

	function setWorkActive(active: boolean) {
		if (active && (!workOwner.current || current.current !== workOwner.current || writeFailed.current)) return;
		updateClock(setGoalWorkClock(clock.current, active, performance.now()));
	}

	function sealWork(value: ChatGoal): ChatGoal {
		setWorkActive(false);
		return { ...value, workedMs: clock.current.workedMs };
	}

	const refreshIndex = useEffectEvent(onDefinitionChange);
	const onDispose = useEffectEvent(() => { void pause('closed'); });
	useEffect(() => {
		mounted.current = true;
		let disposed = false;
		void (async () => {
			try {
				const { goal: value, migrated } = await localState.restoreGoal(store, conversationId);
				if (disposed) return;
				if (migrated) refreshIndex();
				current.current = saved.current = value;
				updateClock({ workedMs: value?.workedMs ?? 0 });
				setGoal(value);
				setReady(true);
			} catch {
				if (!disposed) setError(goalText().loadFailed);
			}
		})();
		return () => { disposed = true; mounted.current = false; onDispose(); };
	}, [conversationId, localState, store]);

	async function save(next: ChatGoal | undefined): Promise<boolean> {
		const version = ++revision.current;
		current.current = next;
		updateClock({ workedMs: next?.workedMs ?? 0 });
		const write = writes.current.then(() => store.saveGoal(conversationId, next ?? null));
		writes.current = write.then(() => { saved.current = next; }, () => {});
		try {
			await write;
			if (revision.current === version) {
				writeFailed.current = false;
				if (mounted.current) {
					setGoal(next);
					setError('');
				}
			}
			return true;
		} catch {
			if (revision.current === version) {
				writeFailed.current = true;
				current.current = saved.current;
				updateClock({ workedMs: saved.current?.workedMs ?? 0 });
				if (mounted.current) {
					setGoal(saved.current);
					setError(goalText().saveFailed);
				}
			}
			return false;
		}
	}

	function pause(reason: GoalPause): Promise<boolean> {
		const value = current.current;
		if (!value || value.status !== 'active') return writes.current.then(() => current.current?.status !== 'active');
		const write = save({ ...sealWork(value), status: 'paused', reason });
		if (running.current) stopRunning();
		return write;
	}

	const onOpenChange = useEffectEvent(() => {
		open.current = isOpen;
		if (!isOpen) void pause('closed');
	});
	useEffect(() => onOpenChange(), [isOpen]);

	const runNext = useEffectEvent(async () => {
		const value = current.current;
		if (!isOpen || !canContinue || !value || value !== goal || value.status !== 'active'
			|| writeFailed.current || running.current) return;
		running.current = true;
		workOwner.current = value;
		setWorking(true);
		const started = { ...value, usedRounds: value.usedRounds + 1, totalRounds: value.totalRounds + 1 };
		let result: RunState | undefined;
		try {
			result = await start(started);
		} catch {
			// 任务出错时暂停，详细信息由原有聊天记录显示。
		} finally {
			// 聊天先保存本轮结果，验收状态保存完成后才能开始下一轮。
			if (mounted.current && current.current === value) await save(finishGoalRound(sealWork(result ? started : value), result));
			workOwner.current = undefined;
			running.current = false;
			if (mounted.current) setWorking(false);
		}
	});
	useEffect(() => { void runNext(); }, [canContinue, goal, isOpen, working]);

	async function create(description: string, context?: GoalContext, ui?: SlashUi): Promise<boolean> {
		if (!ready || !mounted.current || !open.current || changing.current) return false;
		const text = goalText();
		const objective = description.trim();
		if (!objective || objective.length > MAX_GOAL_LENGTH) throw new Error(text.invalidObjective);
		const next = parseChatGoal({ ...context, objective, criteria: [objective], status: 'active',
			usedRounds: 0, totalRounds: 0, workedMs: 0 });
		if (!next) throw new Error(text.invalidContext);
		const existing = current.current;
		changing.current = true;
		try {
			if (existing && !await confirmGoal(app, text.replace, text.create, ui)) return false;
			if (!mounted.current || !open.current || current.current?.objective !== existing?.objective) return false;
			setWorkActive(false);
			const savedGoal = save(next);
			if (running.current) stopRunning();
			if (!await savedGoal) return false;
			if (mounted.current) {
				setOpened(false);
				onDefinitionChange();
			}
			return true;
		} finally {
			changing.current = false;
		}
	}

	async function edit(existing: ChatGoal, ui?: SlashUi): Promise<boolean> {
		changing.current = true;
		try {
			const next = await editGoal(app, existing, ui);
			if (!next || !mounted.current || !open.current) return false;
			const latest = current.current;
			if (!latest || latest.objective !== existing.objective) throw new Error(goalText().changed);
			const sameObjective = latest.objective === next.objective;
			const sameCriteria = JSON.stringify(latest.criteria ?? [latest.objective]) === JSON.stringify(next.criteria);
			const savedGoal = save({
				...sealWork(latest), ...next, status: 'paused', reason: 'manual',
				...(!sameObjective && { skillMentions: undefined }),
				...((!sameObjective || !sameCriteria) && { evidence: undefined, progress: undefined, plan: undefined }),
			});
			if (running.current) stopRunning();
			if (!await savedGoal) return false;
			if (mounted.current) onDefinitionChange();
			return true;
		} finally {
			changing.current = false;
		}
	}

	async function command(argument: string, ui?: SlashUi): Promise<boolean> {
		if (!ready || !mounted.current || !open.current || changing.current) return false;
		const text = goalText();
		const value = current.current;
		const objective = argument.trim();
		const action = objective.toLowerCase();
		if (!action && value) {
			setOpened(true);
			return true;
		}
		if (action === 'pause' || action === 'resume' || action === 'edit' || action === 'clear') {
			if (!value) throw new Error(text.missing);
			if (action === 'pause') return pause('manual');
			if (action === 'resume') {
				if (value.status !== 'paused') return true;
				return save({ ...value, criteria: value.criteria ?? [value.objective], status: 'active', usedRounds: 0, reason: undefined });
			}
			if (action === 'edit') return edit(value, ui);
			changing.current = true;
			try {
				const confirmed = await confirmGoal(app, text.confirmClear, text.clear, ui);
				if (!confirmed || !mounted.current || !open.current || current.current?.objective !== value.objective) return false;
				setWorkActive(false);
				const cleared = save(undefined);
				if (running.current) stopRunning();
				if (!await cleared) return false;
				if (mounted.current) onDefinitionChange();
				return true;
			} finally {
				changing.current = false;
			}
		}
		return create(objective, undefined, ui);
	}

	return {
		value: goal, ready, opened, setOpened, working, error, command, setError, pause, create, setWorkActive,
		elapsedMs: workClock.workedMs, workStartedAt: workClock.startedAt,
	};
}
