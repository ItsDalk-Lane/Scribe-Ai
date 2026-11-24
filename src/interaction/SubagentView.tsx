import { ItemView } from 'obsidian';
import type { ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { createRoot } from 'react-dom/client';
import { SUBAGENT_VIEW_TYPE } from '../constants';
import type ScribeAiPlugin from '../main';
import { MetricPopoverProvider } from './components/MetricPopover';
import { SubagentDetail } from './components/SubagentsPanel';
import { subagentUiText } from './subagentUiText';
import { readSubagentTabState } from './conversationViews';
import type { SubagentTabState } from './conversationViews';
import { uiText } from './uiText';

export class SubagentView extends ItemView {
	private root?: ReturnType<typeof createRoot>;
	private target?: SubagentTabState;
	private unsubscribe?: () => void;

	constructor(leaf: WorkspaceLeaf, private plugin: ScribeAiPlugin) { super(leaf); }

	override getViewType() { return SUBAGENT_VIEW_TYPE; }
	override getDisplayText() { return this.target?.name ?? subagentUiText().title; }
	override getIcon() { return 'users'; }
	override getState() { return this.target ? { ...this.target } : {}; }

	override async setState(state: unknown, result: ViewStateResult) {
		this.target = readSubagentTabState(state);
		this.subscribe();
		await super.setState(state, result);
	}

	override async onOpen() {
		this.root = createRoot(this.contentEl);
		this.subscribe();
	}

	override async onClose() {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.root?.unmount();
		this.root = undefined;
	}

	private subscribe() {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const { target, root } = this;
		const { sessions, skills } = this.plugin.services.orchestration;
		const controller = sessions.subagents;
		if (!root) return;
		if (!target || !controller) {
			root.render(null);
			return;
		}
		const { conversationId, agentId } = target;
		let loaded = false;
		const render = () => {
			if (this.target !== target || this.root !== root) return;
			const snapshot = controller.snapshot(conversationId);
			const agent = snapshot.agents.find(({ id }) => id === agentId);
			if (!agent) {
				const error = snapshot.error ?? (loaded ? uiText().chatHistoryError : undefined);
				root.render(error ? <p className="scribe-chat-error" role="alert">{error}</p> : null);
				return;
			}
			const names = new Map(snapshot.agents.map(({ id, name }) => [id, name]));
			root.render(<MetricPopoverProvider>
				<div className="scribe-app scribe-subagent-sidebar" data-layout="conversation">
					<SubagentDetail key={agent.id} agent={agent} app={this.app} skills={skills} submissions={snapshot.submissions}
						subagentNames={names} inspectSubagent={(id) => this.plugin.openSubagent(conversationId, id)}
						onCloseTab={() => this.leaf.detach()} />
				</div>
			</MetricPopoverProvider>);
		};
		this.unsubscribe = controller.subscribe(conversationId, render);
		render();
		const finish = () => { loaded = true; render(); };
		void controller.load(conversationId).then(finish, finish);
	}
}
