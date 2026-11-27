import { directoryWriteGuard } from '../orchestration/context/promptContext';
import { realpath } from 'node:fs/promises';
import { canUseToolWhileAnswering, taskMessage } from '../orchestration/context/contextBuilder';
import { isCachedImagePath } from '../orchestration/storage/paths';
import { toolAbsolutePath } from '../tools/support/pathUtils';
import type { Message, NoteRef, RunContext, SubagentNote, ToolCall } from '../types';
import { isDirectMcpToolName } from '../tools/support/toolInput';
import { normalizeModelIntent } from './responseIntent';

async function canSteerWithRefs(ctx: RunContext, refs: NoteRef[]): Promise<boolean> {
	const { cwd, permissions } = ctx;
	const readable = await Promise.all(refs.map(async ({ path, lines, pastedImage }) => {
		try {
			if (pastedImage && !lines) return isCachedImagePath(path, ctx.task.request.conversationId);
			const absolute = toolAbsolutePath(cwd, path);
			if (!permissions.canRead(absolute)) return false;
			const canonical = await realpath(absolute);
			const allowed = permissions.readLines?.(canonical);
			return permissions.canRead(canonical) && (!allowed || Boolean(lines && lines[0] >= allowed[0] && lines[1] <= allowed[1]));
		} catch {
			return false;
		}
	}));
	return readable.every(Boolean);
}

export async function readSteering(ctx: RunContext) {
	const messages: (Message & { id: string })[] = [];
	for (const { id, request } of ctx.takeSteering?.() ?? []) {
		if (!request.refs.length || await canSteerWithRefs(ctx, request.refs)) messages.push({ ...taskMessage(request), id: `steer:${id}` });
		else ctx.rejectSteering?.([id]);
	}
	ctx.signal.throwIfAborted();
	return messages;
}

export function hasNewInboxMessage(ctx: RunContext, previouslyRead: readonly SubagentNote[] | undefined, userOnly = false) {
	return ctx.inbox?.().some((note) => (note.from === 'user' || (!userOnly && ctx.collaboration))
		&& !previouslyRead?.some(({ id }) => id === note.id)) === true;
}

export async function waitForTurnInput(ctx: RunContext) {
	const { collaboration, signal } = ctx;
	if (!collaboration) return;
	for (;;) {
		const changed = ctx.nextSteeringSignal?.();
		if ((await readSteering(ctx)).length) return;
		try {
			await collaboration.waitForProgress(changed ? AbortSignal.any([signal, changed]) : signal);
			return;
		} catch (error) {
			signal.throwIfAborted();
			if (!changed?.aborted) throw error;
		}
	}
}

/** Check at admission time so that an instruction received during A can stop B from starting. */
export function batchAdmission(ctx: RunContext, inbox: readonly SubagentNote[] | undefined, answering: boolean,
	resumeCheck?: (call: ToolCall) => Promise<string | undefined>, requiredToolIntents?: ReadonlySet<string>) {
	let preempted = false;
	const userHasSteered = async () => {
		if (!preempted) preempted = hasNewInboxMessage(ctx, inbox, true) || (await readSteering(ctx)).length > 0;
		return preempted;
	};
	return {
		userHasSteered,
		skip: async (call: ToolCall) => {
			if (await userHasSteered()) return '用户发来新的插话，此项调用尚未执行。请按新指令决定下一步。';
			if ((answering || ctx.collaboration?.pending().questions) && (!answering || !canUseToolWhileAnswering(call))) {
				return '本轮优先答复子 Agent。已保留此前完成的操作，请在后续轮次继续。';
			}
			if (!isDirectMcpToolName(call.name) && requiredToolIntents?.has(call.name)
				&& !normalizeModelIntent((call.input as { intent?: unknown } | null)?.intent)) {
				return '工具未执行。请提供 intent，写一条不超过 48 字的简体中文操作说明。';
			}
			return await resumeCheck?.(call) ?? await directoryWriteGuard(ctx, call);
		},
	};
}
