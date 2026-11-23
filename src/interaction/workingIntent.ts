import type { Message } from '../types';
import { isMcpToolName } from '../tools/support/toolInput';
import { normalizeModelIntent } from '../runtime/responseIntent';

export function workingIntent(messages: readonly Message[], pendingId?: string): string | undefined {
	const calls = [...messages].reverse().find(({ role }) => role === 'assistant')?.toolCalls;
	if (!calls?.length) return undefined;
	const pendingIndex = calls.findIndex(({ id }) => id === pendingId);
	// 一次响应可包含多个工具请求，依执行顺序显示到当前这一项为止。
	for (let index = pendingIndex < 0 ? calls.length - 1 : pendingIndex; index >= 0; index--) {
		const call = calls[index];
		if (!call || isMcpToolName(call.name)) continue;
		const { input } = call;
		if (!input || typeof input !== 'object' || !('i' in input)) continue;
		const intent = normalizeModelIntent(input.i);
		if (intent) return intent;
	}
	return undefined;
}
