import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { IconName } from 'obsidian';
import { createRoot } from 'react-dom/client';
import ChatTabs from './ChatTabs';
import { CHAT_VIEW_DISPLAY, CHAT_VIEW_ICON, CHAT_VIEW_TYPE } from '../constants';
import type ScribeAiPlugin from '../main';
import type { HistoryTrigger } from './components/ChatNavigation';
import type { SkillDraft } from './components/skillMentionText';
import { uiText } from './uiText';

/** Obsidian 聊天视图的宿主接入：视图生命周期归宿主，界面内容归 App */
export class ChatView extends ItemView {
	private root: ReturnType<typeof createRoot> | null = null;
	private openTab?: (draft?: SkillDraft) => void;
	private toggleHistory?: () => void;
	private readonly historyTrigger: HistoryTrigger;
	private waiting: { draft: SkillDraft; opened: () => void; closed: () => void }[] = [];

	openSkillDraft(draft: SkillDraft): Promise<void> {
		if (this.openTab) {
			this.openTab(draft);
			return Promise.resolve();
		}
		return new Promise((opened, reject) => this.waiting.push({ draft, opened, closed: () => reject(new Error('聊天窗口已关闭。')) }));
	}

	private registerTabOpener = (open?: (draft?: SkillDraft) => void) => {
		this.openTab = open;
		if (open) for (const { draft, opened } of this.waiting.splice(0)) {
			open(draft);
			opened();
		}
	};

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ScribeAiPlugin,
	) {
		super(leaf);
		const text = uiText();
		this.addAction('message-square-plus', text.chatNewTab, () => this.openTab?.());
		const button = this.addAction('history', text.chatHistory, () => this.toggleHistory?.());
		button.setAttribute('aria-haspopup', 'dialog');
		button.setAttribute('aria-expanded', 'false');
		this.historyTrigger = { button, registerToggle: (toggle) => { this.toggleHistory = toggle; } };
	}

	override getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return CHAT_VIEW_DISPLAY;
	}

	override getIcon(): IconName {
		return CHAT_VIEW_ICON;
	}

	override async onOpen(): Promise<void> {
		this.root = createRoot(this.contentEl);
		this.root.render(<ChatTabs plugin={this.plugin} registerTabOpener={this.registerTabOpener} historyTrigger={this.historyTrigger} />);
	}

	override async onClose(): Promise<void> {
		this.openTab = undefined;
		this.toggleHistory = undefined;
		for (const item of this.waiting.splice(0)) item.closed();
		this.root?.unmount();
		this.root = null;
	}
}
