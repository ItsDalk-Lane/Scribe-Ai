import type { App } from 'obsidian';
import type { ExecutionMode } from '../types';

export function executionModeKey(conversationId?: string): string {
	return conversationId ? `scribe-ai:execution-mode:${conversationId}` : 'scribe-ai:last-execution-mode';
}

export function loadExecutionMode(app: Pick<App, 'loadLocalStorage'>, conversationId?: string): ExecutionMode {
	try {
		const mode: unknown = app.loadLocalStorage(executionModeKey(conversationId));
		if (mode === 'ask' || mode === 'auto-review' || mode === 'full-access') return mode;
	} catch {
		// 损坏的模式记录按缺失处理。
	}
	return 'ask';
}

export interface TabPaneState {
	conversation: { id: string; runs: readonly unknown[]; queue?: readonly unknown[]; hasGoal?: true };
	open: boolean;
	unread?: boolean;
	hasDraft: boolean;
	status?: string;
	title?: string;
	customTitle?: string;
}

// 当前标签页内新开对话：新页占原标签位，脏页收起保留，避免切页丢失草稿或运行中的任务。
export function replaceActiveTabPane<P extends TabPaneState>(
	workspace: { activeId: string; panes: readonly P[] },
	replacement: P,
	pendingTitles: ReadonlyMap<string, unknown>,
): { activeId: string; panes: P[] } {
	const index = workspace.panes.findIndex(({ conversation }) => conversation.id === workspace.activeId);
	const previous = workspace.panes[index];
	if (!previous) return { activeId: workspace.activeId, panes: [...workspace.panes] };
	const keep = previous.hasDraft || Boolean(previous.status) || Boolean(previous.title) || Boolean(previous.customTitle)
		|| previous.conversation.runs.length > 0 || Boolean(previous.conversation.queue?.length) || previous.conversation.hasGoal;
	let panes: P[] = workspace.panes.map((pane, at) => at === index ? replacement : pane);
	if (keep) panes = [...panes, { ...previous, open: false, unread: false }];
	const idle = panes.filter((pane) => !pane.open && !pane.status && !pane.unread && !pane.hasDraft
		&& !pendingTitles.has(pane.conversation.id));
	if (idle.length > 3) {
		const evicted = new Set(idle.slice(0, -3));
		panes = panes.filter((pane) => !evicted.has(pane));
	}
	return { activeId: replacement.conversation.id, panes };
}
