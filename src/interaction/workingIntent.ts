import type { Message } from '../types';
import { isDirectMcpToolName } from '../tools/support/toolInput';
import { normalizeModelIntent } from '../runtime/responseIntent';

export function toolWorkingIntent(input: unknown): string | undefined {
	const value = input as { intent?: unknown; i?: unknown } | null;
	return normalizeModelIntent(value?.intent) ?? normalizeModelIntent(value?.i);
}

export function workingIntent(messages: readonly Message[], pendingId?: string): string | undefined {
	const calls = [...messages].reverse().find(({ role }) => role === 'assistant')?.toolCalls;
	if (!calls?.length) return undefined;
	const pendingIndex = calls.findIndex(({ id }) => id === pendingId);
	// 一次响应可包含多个工具请求，依执行顺序显示到当前这一项为止。
	for (let index = pendingIndex < 0 ? calls.length - 1 : pendingIndex; index >= 0; index--) {
		const call = calls[index];
		if (!call || isDirectMcpToolName(call.name)) continue;
		const intent = toolWorkingIntent(call.input);
		if (intent) return intent;
	}
	return undefined;
}
