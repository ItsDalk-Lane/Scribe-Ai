import { randomUUID } from 'node:crypto';
import { Notice } from 'obsidian';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type ScribeAiPlugin from '../main';
import { MissingConversationError } from '../types';
import type { ConversationSnapshot, ConversationSummary } from '../types';
import App from './App';
import { replaceActiveTabPane } from './chatTabWorkspace';
import ChatTabBar from './components/ChatTabBar';
import { uiText } from './uiText';

export interface ChatTabActivity {
	status?: 'running' | 'attention' | 'error';
	title?: string;
	hasDraft: boolean;
}

interface Pane extends ChatTabActivity {
	conversation: ConversationSnapshot;
	open: boolean;
	unread?: boolean;
	customTitle?: string;
	initialError?: string;
	openedAt: number;
}

interface Workspace {
	activeId: string;
	panes: Pane[];
}

function newPane(conversation: ConversationSnapshot = { id: randomUUID(), runs: [] }): Pane {
	return { conversation, open: true, hasDraft: false, openedAt: Date.now() };
}

export default function ChatTabs({ plugin }: { plugin: ScribeAiPlugin }) {
	const text = uiText();
	const { conversations, sessions } = plugin.services.orchestration;
	const [workspace, setWorkspace] = useState<Workspace>();
	const [index, setIndex] = useState<ConversationSummary[]>([]);
	const mounted = useRef(false);
	const activePane = useRef<string>(undefined);
	const unopenedPane = useRef<string>(undefined);
	const selection = useRef(0);
	const refreshVersion = useRef(0);
	const pendingTitles = useRef(new Map<string, string>());

	useEffect(() => {
		mounted.current = true;
		let closed = false;
		void Promise.allSettled([sessions.listConversations(), sessions.openConversation()]).then(([history, last]) => {
			if (closed) return;
			if (history.status === 'fulfilled') setIndex(history.value);
			const pane = newPane(last.status === 'fulfilled' ? last.value ?? undefined : undefined);
			if (history.status === 'rejected' || last.status === 'rejected') pane.initialError = text.chatHistoryError;
			if (last.status === 'rejected' || !last.value) unopenedPane.current = pane.conversation.id;
			setWorkspace({ activeId: pane.conversation.id, panes: [pane] });
		});
		return () => { closed = true; mounted.current = false; };
	}, [sessions, text.chatHistoryError]);

	const activeId = workspace?.activeId;
	useLayoutEffect(() => { activePane.current = activeId; }, [activeId]);
	const active = workspace?.panes.find(({ conversation }) => conversation.id === activeId);
	const remember = activeId !== unopenedPane.current || Boolean(active?.status || active?.title);
	useEffect(() => {
		if (activeId && remember) void conversations.setLastOpened(activeId).catch(() => {
			if (mounted.current) new Notice(text.saveFailed);
		});
	}, [activeId, conversations, remember, text.saveFailed]);

	const refresh = useCallback(async () => {
		const version = ++refreshVersion.current;
		const rows = await sessions.listConversations();
		for (const row of rows) {
			const title = pendingTitles.current.get(row.id);
			if (!title) continue;
			await sessions.renameConversation(row.id, title);
			if (pendingTitles.current.get(row.id) === title) pendingTitles.current.delete(row.id);
			row.title = title;
		}
		if (mounted.current && version === refreshVersion.current) setIndex(rows);
	}, [sessions]);

	function show(pane: Pane, activate = true) {
		const id = pane.conversation.id;
		if (activate) selection.current++;
		setWorkspace((current) => {
			if (!current) return current;
			const exists = current.panes.some(({ conversation }) => conversation.id === id);
			return {
				activeId: activate ? id : current.activeId,
				panes: exists ? current.panes.map((tab) => tab.conversation.id === id
					? { ...tab, open: true, unread: activate ? false : tab.unread } : tab)
					: [...current.panes, pane],
			};
		});
	}

	function newConversationInActiveTab() {
		selection.current++;
		const pane = newPane();
		unopenedPane.current = pane.conversation.id;
		setWorkspace((current) => current && replaceActiveTabPane(current, pane, pendingTitles.current));
	}

	async function openHistory(id: string) {
		const existing = workspace?.panes.find(({ conversation }) => conversation.id === id);
		if (existing) {
			show(existing);
			return;
		}
		const version = ++selection.current;
		const snapshot = await conversations.load(id);
		if (!mounted.current || version !== selection.current) return;
		if (!snapshot.runs.length && !snapshot.queue?.length) {
			setIndex((previous) => previous.filter((row) => row.id !== id));
			throw new MissingConversationError(text.chatHistoryError);
		}
		show(newPane(snapshot));
	}

	function close(id: string, remove = false) {
		selection.current++;
		const fallback = newPane();
		setWorkspace((current) => {
			if (!current) return current;
			const open = current.panes.filter((pane) => pane.open);
			const index = open.findIndex(({ conversation }) => conversation.id === id);
			const next = open[index + 1] ?? open[index - 1];
			let panes = current.panes.flatMap((pane) => pane.conversation.id !== id ? [pane]
				: remove || (!pane.hasDraft && !pane.status && !pane.title && !pane.customTitle && !pane.conversation.runs.length
					&& !pane.conversation.queue?.length) ? [] : [{ ...pane, open: false }]);
			let selected = current.activeId;
			if (selected === id) {
				selected = (next ?? fallback).conversation.id;
				panes = next ? panes.map((pane) => pane.conversation.id === selected ? { ...pane, unread: false } : pane)
					: [...panes, fallback];
			}
			const idle = panes.filter((pane) => !pane.open && !pane.status && !pane.unread && !pane.hasDraft
				&& !pendingTitles.current.has(pane.conversation.id));
			if (idle.length > 3) {
				const evicted = new Set(idle.slice(0, -3));
				panes = panes.filter((pane) => !evicted.has(pane));
			}
			return { activeId: selected, panes };
		});
	}

	const updateActivity = useCallback((id: string, activity: ChatTabActivity) => {
		setWorkspace((current) => {
			if (!current) return current;
			const pane = current.panes.find(({ conversation }) => conversation.id === id);
			if (!pane || (pane.status === activity.status && pane.title === activity.title && pane.hasDraft === activity.hasDraft)) return current;
			const needsAttention = current.activeId !== id && pane.status !== activity.status && (
				activity.status === 'attention' || activity.status === 'error' || (Boolean(pane.status) && !activity.status)
			);
			return { ...current, panes: current.panes.map((tab) => tab === pane ? {
				...tab, ...activity, unread: needsAttention || pane.unread,
			} : tab) };
		});
	}, []);

	async function rename(id: string, title: string) {
		const name = title.trim();
		if (!name || name.length > 120) return false;
		try {
			const snapshot = await conversations.load(id);
			if (snapshot.runs.length || snapshot.queue?.length) {
				await sessions.renameConversation(id, name);
				pendingTitles.current.delete(id);
			} else if (workspace?.panes.some(({ conversation }) => conversation.id === id)) {
				pendingTitles.current.set(id, name);
			} else return false;
			refreshVersion.current++;
			setIndex((previous) => previous.map((row) => row.id === id ? { ...row, title: name } : row));
			setWorkspace((current) => current && { ...current, panes: current.panes.map((pane) =>
				pane.conversation.id === id ? { ...pane, customTitle: name } : pane) });
			return true;
		} catch {
			new Notice(text.chatRenameError);
			return false;
		}
	}

	async function remove(id: string) {
		await sessions.deleteConversation(id);
		pendingTitles.current.delete(id);
		refreshVersion.current++;
		setIndex((previous) => previous.filter((row) => row.id !== id));
		close(id, true);
	}

	if (!workspace) return <div className="scribe-chat-workspace"><p className="scribe-chat-loading" role="status">{text.chatLoadingHistory}</p></div>;

	const saved = new Map(index.map((row) => [row.id, row]));
	const all = index.concat(workspace.panes.flatMap((pane) => {
		const { id } = pane.conversation;
		if (saved.has(id) || (pane.open && !pane.status) || !(pane.hasDraft || pane.status || pane.title || pane.customTitle)) return [];
		return [{ id, title: pane.customTitle ?? pane.title ?? text.chatUntitled, updatedAt: pane.openedAt }];
	}));
	const tabs = workspace.panes.filter((pane) => pane.open).map((pane) => ({
		id: pane.conversation.id,
		title: pane.customTitle ?? saved.get(pane.conversation.id)?.title ?? pane.title ?? text.chatUntitled,
		status: pane.status ?? (pane.unread ? 'attention' as const : undefined),
	}));

	return <div className="scribe-chat-workspace">
		<ChatTabBar tabs={tabs} activeId={workspace.activeId} onNew={() => show(newPane())}
			onActivate={(id) => { const pane = workspace.panes.find(({ conversation }) => conversation.id === id); if (pane) show(pane); }}
			onClose={close} onRename={rename} />
		{workspace.panes.map(({ conversation, initialError }) => {
			const selected = conversation.id === workspace.activeId;
			return <div key={conversation.id} className="scribe-chat-tab-panel" id={`scribe-tab-panel-${conversation.id}`}
				role="tabpanel" aria-labelledby={`scribe-tab-${conversation.id}`} hidden={!selected}>
				<App plugin={plugin} conversation={conversation} selected={selected} conversations={all} initialError={initialError ?? ''}
					onNew={newConversationInActiveTab} onOpen={openHistory} onRename={rename} onDelete={remove} onRefresh={refresh}
					onFork={(snapshot) => show(newPane(snapshot), activePane.current === conversation.id)} onActivity={updateActivity} />
			</div>;
		})}
	</div>;
}
