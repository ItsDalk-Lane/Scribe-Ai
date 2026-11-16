import { notImplemented } from '../../types';
import type { ConversationStore } from '../../types';

/** 会话记录的保存与恢复 */
export function createConversationStore(): ConversationStore {
	return {
		load: async () => [],
		append: () => notImplemented('会话记录保存'),
	};
}
