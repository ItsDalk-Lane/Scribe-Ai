import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { IconName } from 'obsidian';
import { createRoot } from 'react-dom/client';
import App from './App';
import { CHAT_VIEW_DISPLAY, CHAT_VIEW_ICON, CHAT_VIEW_TYPE } from '../constants';
import type ScribeAiPlugin from '../main';

/** Obsidian 聊天视图的宿主接入：视图生命周期归宿主，界面内容归 App */
export class ChatView extends ItemView {
	private root: ReturnType<typeof createRoot> | null = null;

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
		this.root.render(<App services={this.plugin.services} />);
	}

	override async onClose(): Promise<void> {
		this.root?.unmount();
		this.root = null;
	}
}
