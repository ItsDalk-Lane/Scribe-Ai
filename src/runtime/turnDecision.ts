import type { ModelResponse, RunContext } from '../types';

/** A model response ends one inference. The task can still have input or collaboration to handle. */
export function nextTurnAction(response: ModelResponse, content: string, boundary: {
	newInput: boolean;
	collaboration?: ReturnType<NonNullable<RunContext['collaboration']>['pending']>;
	checkEmptyReply: boolean;
}) {
	if (response.stopReason === 'limit') {
		return !response.structuredOutput && content.trim() ? 'continue-text' : 'stop-at-limit';
	}
	if (response.toolCalls.length) return 'run-tools';
	if (response.stopReason === 'tool-calls') return 'incomplete-calls';
	if (boundary.newInput) return 'handle-input';
	if (boundary.collaboration?.blocking) {
		return boundary.collaboration.actionable ? 'handle-collaboration' : 'wait-for-collaboration';
	}
	return boundary.checkEmptyReply ? 'check-empty-reply' : 'finish';
}
