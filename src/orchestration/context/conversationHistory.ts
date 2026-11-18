import { Buffer } from 'node:buffer';
import type { ConversationSnapshot, Message, RunContext, SavedRun, ToolCall } from '../../types';

const agreementStart = /^(?:(?:我们)?(?:先)?约定|(?:修改|更新|取消|撤销)(?:刚才|之前|先前|原来)?的?约定|本(?:次)?对话(?:里|中)?|在(?:这个|本次)对话(?:里|中)?|今后|以后|从现在(?:起|开始)|接下来都|(?:from now on|throughout this conversation|for the rest of this (?:chat|conversation))\b)/iu;

function interruptedResult(run: SavedRun, call: ToolCall): Message {
	const mayHaveRun = run.step?.phase === 'tool' && run.step.call?.id === call.id;
	return {
		role: 'tool',
		toolCallId: call.id,
		toolName: call.name,
		isError: true,
		content: mayHaveRun
			? '上次任务在工具执行期间中断，结果未知。继续前请检查实际状态，避免重复操作。'
			: '上次任务结束时，此工具没有记录到执行结果。',
	};
}

/** 恢复对话上下文，并从用户原始指令保留明确约定。 */
export function conversationHistory(snapshot: ConversationSnapshot): Pick<RunContext, 'history' | 'agreements'> {
	const agreements: string[] = [];
	const history = snapshot.runs.flatMap((run) => {
		// shortcut: 只保留开头明确表示长期约定的短句，需要支持隐含约定时再引入语义摘要。
		const line = run.request.instruction.trim().split(/\r?\n/u, 1)[0] ?? '';
		if (!run.request.selection && agreementStart.test(line) && Buffer.byteLength(line) <= 768) agreements.push(line);
		const messages = [...run.state.messages];
		if (run.state.status === 'interrupted') {
			messages.push(...run.state.pendingCalls.map((call) => interruptedResult(run, call)));
		}
		// 旧版用独立字段保存停止前看到的回复。
		if (run.partial) messages.push({ role: 'assistant', content: run.partial, incomplete: true });
		if (run.state.status === 'interrupted') {
			messages.push({
				role: 'system',
				content: '上次任务已中断。尊重用户这次的新指令，基于已记录的结果继续。',
			});
		}
		return messages;
	});
	return { history, agreements };
}
