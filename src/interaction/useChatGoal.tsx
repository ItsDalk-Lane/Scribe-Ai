import { getLanguage, Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { RunState } from '../types';
import { DEFAULT_GOAL_ROUNDS, finishGoalRound, MAX_GOAL_LENGTH, MAX_GOAL_ROUNDS, restoreChatGoal, validGoalRounds } from './chatGoal';
import type { ChatGoal, GoalPause } from './chatGoal';
import { confirmAction } from './ConfirmModal';
import type { SlashUi } from './slashUi';

const goalKey = (conversationId: string) => `scribe-ai:chat-goal:${conversationId}`;

export function clearChatGoal(app: App, conversationId: string): void {
	app.saveLocalStorage(goalKey(conversationId), null);
}

function goalText() {
	const chinese = getLanguage().toLowerCase().startsWith('zh');
	return chinese ? {
		title: '聊天目标', objective: '目标内容', limit: '每次最多自动执行的轮数', create: '启动目标',
		edit: '编辑', resume: '继续', pause: '暂停', clear: '清除', cancel: '取消', save: '保存',
		replace: '保存并启动后会替换现有目标。', confirmClear: '清除这个目标？聊天记录会保留。',
		invalid: `请输入目标，并将自动执行轮数设为 1 至 ${MAX_GOAL_ROUNDS} 的整数。`,
		missing: '请先输入 /goal 和目标内容。', saveFailed: '目标进度保存失败，自动续做已停止。',
		changed: '目标已更改，请重新打开。', waiting: '等待本聊天空闲后继续',
		active: '进行中', paused: '已暂停', complete: '已完成', current: '本次', total: '累计轮数',
		proof: '完成依据', reasons: {
			manual: '已手动停止。', closed: '聊天已关闭，请手动继续。', limit: '已达到本次上限。', failed: '上一轮未成功结束，请查看聊天记录。',
			blocked: '需要你处理上一轮的问题。处理后可手动继续。',
		},
	} : {
		title: 'Chat goal', objective: 'Objective', limit: 'Automatic rounds per start', create: 'Start goal',
		edit: 'Edit', resume: 'Resume', pause: 'Pause', clear: 'Clear', cancel: 'Cancel', save: 'Save',
		replace: 'Starting this goal replaces the current goal.', confirmClear: 'Clear this goal? Chat history will be kept.',
		invalid: `Enter a goal and a whole number from 1 to ${MAX_GOAL_ROUNDS} for the round limit.`,
		missing: 'Enter /goal followed by your objective first.', saveFailed: 'The goal could not be saved. Automatic work has stopped.',
		changed: 'The goal changed. Open the editor again.', waiting: 'Waiting for this chat to become idle',
		active: 'In progress', paused: 'Paused', complete: 'Complete', current: 'This start', total: 'Total rounds',
		proof: 'Completion evidence', reasons: {
			manual: 'Stopped manually.', closed: 'The chat closed. Resume to continue.', limit: 'This start reached its limit.', failed: 'The last round ended early. See chat history.',
			blocked: 'The last round needs your attention. Resume when ready.',
		},
	};
}

function editGoal(app: App, objective: string, maxRounds: number, action: 'create' | 'edit', replace: boolean) {
	const text = goalText();
	return new Promise<{ objective: string; maxRounds: number } | undefined>((resolve) => {
		const modal = new Modal(app);
		let result: { objective: string; maxRounds: number } | undefined;
		modal.setTitle(text.title);
		if (replace) modal.contentEl.createEl('p', { text: text.replace });
		let goalField: HTMLTextAreaElement | undefined;
		let limitField: HTMLInputElement | undefined;
		new Setting(modal.contentEl).setName(text.objective).addTextArea((field) => {
			goalField = field.setValue(objective).inputEl;
			goalField.rows = 4;
			goalField.maxLength = MAX_GOAL_LENGTH;
			goalField.setAttribute('aria-label', text.objective);
		});
		new Setting(modal.contentEl).setName(text.limit).addText((field) => {
			limitField = field.setValue(String(maxRounds)).inputEl;
			limitField.type = 'number';
			limitField.min = '1';
			limitField.max = String(MAX_GOAL_ROUNDS);
			limitField.setAttribute('aria-label', text.limit);
		});
		const error = modal.contentEl.createDiv({ cls: 'scribe-chat-error', attr: { role: 'alert' } });
		new Setting(modal.contentEl).addButton((button) => button.setButtonText(text.cancel).onClick(() => modal.close()))
			.addButton((button) => button.setButtonText(action === 'create' ? text.create : text.save).setCta().onClick(() => {
				const value = goalField?.value.trim();
				const rounds = limitField?.valueAsNumber;
				if (!value || value.length > MAX_GOAL_LENGTH || !validGoalRounds(rounds)) {
					error.setText(text.invalid);
					return;
				}
				result = { objective: value, maxRounds: rounds };
				modal.close();
			}));
		modal.onOpen = () => goalField?.focus();
		modal.onClose = () => resolve(result);
		modal.open();
	});
}

function editGoalPanel(ui: SlashUi, objective: string, maxRounds: number, action: 'create' | 'edit', replace: boolean) {
	const text = goalText();
	return ui.custom<{ objective: string; maxRounds: number }>(text.title, (host, done) => {
		if (replace) host.createEl('p', { text: text.replace });
		let goalField: HTMLTextAreaElement | undefined;
		let limitField: HTMLInputElement | undefined;
		new Setting(host).setName(text.objective).addTextArea((field) => {
			goalField = field.setValue(objective).inputEl;
			goalField.rows = 4;
			goalField.maxLength = MAX_GOAL_LENGTH;
			goalField.setAttribute('aria-label', text.objective);
		});
		new Setting(host).setName(text.limit).addText((field) => {
			limitField = field.setValue(String(maxRounds)).inputEl;
			limitField.type = 'number';
			limitField.min = '1';
			limitField.max = String(MAX_GOAL_ROUNDS);
			limitField.setAttribute('aria-label', text.limit);
		});
		const error = host.createDiv({ cls: 'scribe-chat-error', attr: { role: 'alert' } });
		new Setting(host).addButton((button) => button.setButtonText(text.cancel).onClick(() => done(undefined)))
			.addButton((button) => button.setButtonText(action === 'create' ? text.create : text.save).setCta().onClick(() => {
				const value = goalField?.value.trim();
				const rounds = limitField?.valueAsNumber;
				if (!value || value.length > MAX_GOAL_LENGTH || !validGoalRounds(rounds)) {
					error.setText(text.invalid);
					return;
				}
				done({ objective: value, maxRounds: rounds });
			}));
		queueMicrotask(() => goalField?.focus());
	});
}

interface GoalOptions {
	app: App;
	conversationId: string;
	isOpen: boolean;
	canContinue: boolean;
	start: (objective: string) => Promise<RunState | undefined>;
	stopRunning: () => void;
}

export function useChatGoal({ app, conversationId, isOpen, canContinue, start, stopRunning }: GoalOptions) {
	const [goal, setGoal] = useState(() => {
		try { return restoreChatGoal(app.loadLocalStorage(goalKey(conversationId))); } catch { return undefined; }
	});
	const [opened, setOpened] = useState(false);
	const [error, setError] = useState('');
	const [working, setWorking] = useState(false);
	const current = useRef(goal);
	const mounted = useRef(false);
	const running = useRef(false);
	const blocked = useRef(false);
	const open = useRef(isOpen);
	const changing = useRef(false);

	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);

	function save(next: ChatGoal | undefined): boolean {
		try {
			if (next) app.saveLocalStorage(goalKey(conversationId), next);
			else clearChatGoal(app, conversationId);
		} catch {
			blocked.current = true;
			setError(goalText().saveFailed);
			return false;
		}
		blocked.current = false;
		current.current = next;
		setGoal(next);
		setError('');
		return true;
	}

	function pause(reason: GoalPause): boolean {
		const value = current.current;
		if (!value || value.status !== 'active') return true;
		const saved = save({ ...value, status: 'paused', reason });
		if (running.current) stopRunning();
		return saved;
	}

	const onOpenChange = useEffectEvent(() => {
		open.current = isOpen;
		if (!isOpen) pause('closed');
	});
	useEffect(() => onOpenChange(), [isOpen]);

	const runNext = useEffectEvent(async () => {
		const value = current.current;
		if (!isOpen || !canContinue || !value || value.status !== 'active' || blocked.current || running.current) return;
		if (value.usedRounds >= value.maxRounds) {
			pause('limit');
			return;
		}
		const started = { ...value, usedRounds: value.usedRounds + 1, totalRounds: value.totalRounds + 1 };
		if (!save(started)) return;
		running.current = true;
		setWorking(true);
		let result: RunState | undefined;
		try {
			result = await start(started.objective);
		} catch {
			// 任务出错时暂停，详细信息由原有聊天记录显示。
		} finally {
			running.current = false;
			if (mounted.current) {
				setWorking(false);
				if (current.current === started && !blocked.current) save(finishGoalRound(started, result));
			}
		}
	});
	useEffect(() => { void runNext(); }, [canContinue, goal, isOpen, working]);

	async function command(argument: string, ui?: SlashUi): Promise<boolean> {
		if (!mounted.current || !isOpen || changing.current) return false;
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
				return save({ ...value, status: 'active', usedRounds: 0, reason: undefined });
			}
		}
		changing.current = true;
		try {
			const stillHere = () => mounted.current && open.current && current.current?.objective === value?.objective;
			if (action === 'clear') {
				const confirmed = ui ? await ui.confirm(text.title, text.confirmClear, text.clear)
					: await new Promise<boolean>((resolve) => {
						let accepted = false;
						confirmAction(app, { title: text.title, message: text.confirmClear, confirmText: text.clear, cancelText: text.cancel,
							onConfirm: () => { accepted = true; }, onClose: () => resolve(accepted) });
					});
				if (!confirmed || !stillHere() || !save(undefined)) return false;
				if (running.current) stopRunning();
				return true;
			}
			const editing = action === 'edit' && value;
			const editArguments = [editing ? value.objective : objective, editing ? value.maxRounds : DEFAULT_GOAL_ROUNDS,
				editing ? 'edit' : 'create', Boolean(!editing && value && value.status !== 'complete')] as const;
			const next = ui ? await editGoalPanel(ui, ...editArguments) : await editGoal(app, ...editArguments);
			if (!next) return false;
			if (!stillHere()) throw new Error(text.changed);
			const latest = current.current;
			const updated: ChatGoal = editing && latest ? {
				...latest, ...next, status: 'paused', reason: 'manual', evidence: undefined,
			} : { ...next, status: 'active', usedRounds: 0, totalRounds: 0 };
			if (!save(updated)) return false;
			if (running.current) stopRunning();
			setOpened(true);
			return true;
		} finally {
			changing.current = false;
		}
	}

	return { value: goal, opened, setOpened, working, error, command, setError };
}

export function ChatGoalStatus({ goal }: { goal: ReturnType<typeof useChatGoal> }) {
	const text = goalText();
	const value = goal.value;
	function control(action: string) {
		void goal.command(action).catch((cause: unknown) => goal.setError(cause instanceof Error ? cause.message : text.saveFailed));
	}
	return <>
		{goal.error && <div role="alert" className="scribe-chat-error">{goal.error}</div>}
		{value && <details className="scribe-chat-goal" open={goal.opened} onToggle={(event) => goal.setOpened(event.currentTarget.open)}>
			<summary>{text.title} · {text[value.status]} · {value.usedRounds}/{value.maxRounds}</summary>
			<p>{value.objective}</p>
			<p>{text.current} {value.usedRounds}/{value.maxRounds} · {text.total} {value.totalRounds}</p>
			{value.status === 'paused' && value.reason && <p>{text.reasons[value.reason]}</p>}
			{value.status === 'active' && !goal.working && !goal.error && <p>{text.waiting}</p>}
			{value.evidence && <p><strong>{text.proof}</strong> · {value.evidence}</p>}
			<div className="scribe-modal-actions">
				{value.status === 'active' && <button type="button" onClick={() => control('pause')}>{text.pause}</button>}
				{value.status === 'paused' && <button type="button" onClick={() => control('resume')}>{text.resume}</button>}
				<button type="button" onClick={() => control('edit')}>{text.edit}</button>
				<button type="button" onClick={() => control('clear')}>{text.clear}</button>
			</div>
		</details>}
	</>;
}
