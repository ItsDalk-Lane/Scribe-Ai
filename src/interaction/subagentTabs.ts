import type { Workspace } from 'obsidian';
import { SUBAGENT_VIEW_TYPE } from '../constants';

export type SubagentTabState = { conversationId: string; agentId: string; name: string };

export function readSubagentTabState(state: unknown): SubagentTabState | undefined {
	if (typeof state !== 'object' || !state) return;
	const { conversationId, agentId, name } = state as Partial<SubagentTabState>;
	if (typeof conversationId === 'string' && conversationId && typeof agentId === 'string' && agentId
		&& typeof name === 'string' && name) return { conversationId, agentId, name };
	return undefined;
}

export class SubagentTabs {
	private opening = new Map<string, Promise<void>>();

	constructor(private workspace: Workspace) {}

	open(target: SubagentTabState, unavailable: string): Promise<void> {
		const key = JSON.stringify([target.conversationId, target.agentId]);
		const pending = this.opening.get(key);
		if (pending) return pending;
		const opening = this.reveal(target, unavailable).finally(() => this.opening.delete(key));
		this.opening.set(key, opening);
		return opening;
	}

	private async reveal(target: SubagentTabState, unavailable: string) {
		const { workspace } = this;
		const existing = workspace.getLeavesOfType(SUBAGENT_VIEW_TYPE).find((leaf) => {
			const state = leaf.getViewState().state;
			return leaf.getRoot() === workspace.rightSplit && state?.conversationId === target.conversationId && state.agentId === target.agentId;
		});
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) throw new Error(unavailable);
		try {
			await leaf.setViewState({ type: SUBAGENT_VIEW_TYPE, state: target, active: true });
			await workspace.revealLeaf(leaf);
		} catch (error) {
			leaf.detach();
			throw error;
		}
	}

	closeConversation(conversationId: string) {
		for (const leaf of this.workspace.getLeavesOfType(SUBAGENT_VIEW_TYPE)) {
			if (leaf.getViewState().state?.conversationId === conversationId) leaf.detach();
		}
	}
}
