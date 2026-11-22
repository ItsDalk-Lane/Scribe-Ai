import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { IconName } from 'obsidian';
import { createRoot } from 'react-dom/client';
import ChatTabs from './ChatTabs';
import { CHAT_VIEW_DISPLAY, CHAT_VIEW_ICON, CHAT_VIEW_TYPE } from '../constants';
import type ScribeAiPlugin from '../main';
import type { SkillDraft } from './components/skillMentionText';

/** Obsidian 聊天视图的宿主接入：视图生命周期归宿主，界面内容归 App */
export class ChatView extends ItemView {
	private root: ReturnType<typeof createRoot> | null = null;
	private acceptDraft?: (draft: SkillDraft) => void;
	private waiting: { draft: SkillDraft; opened: () => void; closed: () => void }[] = [];

	openSkillDraft(draft: SkillDraft): Promise<void> {
		if (this.acceptDraft) {
			this.acceptDraft(draft);
			return Promise.resolve();
		}
		return new Promise((opened, reject) => this.waiting.push({ draft, opened, closed: () => reject(new Error('聊天窗口已关闭。')) }));
	}

	private registerDraftTarget = (accept?: (draft: SkillDraft) => void) => {
		this.acceptDraft = accept;
		if (accept) for (const { draft, opened } of this.waiting.splice(0)) {
			accept(draft);
			opened();
		}
	};

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ScribeAiPlugin,
	) {
		super(leaf);
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
		this.root.render(<ChatTabs plugin={this.plugin} registerDraftTarget={this.registerDraftTarget} />);
	}

	override async onClose(): Promise<void> {
		this.acceptDraft = undefined;
		for (const item of this.waiting.splice(0)) item.closed();
		this.root?.unmount();
		this.root = null;
	}
}
