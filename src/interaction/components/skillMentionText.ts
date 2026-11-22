import type { SkillMention, SkillRegistry } from '../../types';
import { bindSkillMentions, isSkillMentionAt, skillNameTokens } from '../../skills/mentions';

export interface SkillDraft {
	instruction: string;
	skillMentions?: SkillMention[];
	skillScope?: string[];
}

export async function prepareSkillMentions(draft: SkillDraft, registry: SkillRegistry, scope: string[]): Promise<SkillMention[]> {
	const { instruction, skillMentions = [] } = draft;
	if (!skillMentions.length && !skillNameTokens(instruction).length) return [];
	return bindSkillMentions(instruction, skillMentions, await registry.list([], '', scope));
}

export function skillQuery(text: string, cursor: number) {
	const token = /(?<![\p{L}\p{N}_$])(\$[\p{L}\p{N}_:.-]*)$/u.exec(text.slice(0, cursor))?.[1];
	if (!token) return;
	const tail = /^[\p{L}\p{N}_:-]*(?:\.[\p{L}\p{N}_:-]+)*/u.exec(text.slice(cursor))?.[0] ?? '';
	return { start: cursor - token.length, end: cursor + tail.length, query: token.slice(1) + tail };
}

function afterEdit(mentions: readonly SkillMention[], next: string, start: number, end: number, difference: number): SkillMention[] {
	return mentions.flatMap((mention) => {
		const moved = mention.end <= start ? mention : mention.start >= end
			? { ...mention, start: mention.start + difference, end: mention.end + difference } : undefined;
		return moved && isSkillMentionAt(next, moved) ? [moved] : [];
	});
}

export function editSkillText(draft: SkillDraft, instruction: string, cursor: number): SkillDraft {
	const previous = draft.instruction;
	const mentions = draft.skillMentions ?? [];
	if (!mentions.length || previous === instruction) return { instruction, skillMentions: mentions };
	// 用输入后的光标区分文本相同、来源不同的相邻提及，避免误保留另一个来源。
	const difference = instruction.length - previous.length;
	let nextEnd = cursor;
	let oldEnd = cursor - difference;
	if (oldEnd < 0 || oldEnd > previous.length || previous.slice(oldEnd) !== instruction.slice(cursor)) {
		oldEnd = previous.length;
		nextEnd = instruction.length;
		while (oldEnd && nextEnd && previous[oldEnd - 1] === instruction[nextEnd - 1]) { oldEnd--; nextEnd--; }
	}
	let start = 0;
	while (start < oldEnd && start < nextEnd && previous[start] === instruction[start]) start++;
	return { instruction, skillMentions: afterEdit(mentions, instruction, start, oldEnd, difference) };
}

export function insertSkill(draft: SkillDraft, start: number, end: number, skill: { id: string; name: string; sourceLabel?: string }) {
	const token = `$${skill.name}`;
	const suffix = draft.instruction.slice(end);
	const before = draft.instruction.slice(0, start);
	const spaceBefore = /[\p{L}\p{N}_$]$/u.test(before) ? ' ' : '';
	const nameStart = start + spaceBefore.length;
	const nameEnd = nameStart + token.length;
	const spaceAfter = !suffix || /^(?:[\p{L}\p{N}_:-]|\.[\p{L}\p{N}_:-])/u.test(suffix) ? ' ' : '';
	const instruction = before + spaceBefore + token + spaceAfter + suffix;
	const kept = afterEdit(draft.skillMentions ?? [], instruction, start, end, instruction.length - draft.instruction.length);
	const skillMentions = [...kept, { id: skill.id, name: skill.name, sourceLabel: skill.sourceLabel, start: nameStart, end: nameEnd }].sort((a, b) => a.start - b.start);
	return { instruction, skillMentions, cursor: nameEnd + (spaceAfter || /^\s/u.test(suffix) ? 1 : 0) };
}

export function sliceSkillMentions(draft: SkillDraft, start: number, end: number): SkillMention[] {
	return (draft.skillMentions ?? []).filter((mention) => mention.start >= start && mention.end <= end)
		.map((mention) => ({ ...mention, start: mention.start - start, end: mention.end - start }));
}

export type SkillMentionPart = string | { text: string; mention: true };
export function skillMentionParts(text: string, mentions: readonly SkillMention[] = []): SkillMentionPart[] {
	const parts: SkillMentionPart[] = [];
	let at = 0;
	for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
		if (mention.start < at || mention.start < 0 || mention.end > text.length || mention.start >= mention.end) continue;
		if (mention.start > at) parts.push(text.slice(at, mention.start));
		parts.push({ text: text.slice(mention.start, mention.end), mention: true });
		at = mention.end;
	}
	if (at < text.length || !parts.length) parts.push(text.slice(at));
	return parts;
}
