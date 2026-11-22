import type { SkillInfo, SkillMention } from '../types';

export class SkillSteeringError extends Error {
	constructor(readonly messageId: string, message: string) { super(message); }
}

export class SkillAccessChangedError extends Error {}

export function skillNameTokens(text: string) {
	return Array.from(text.matchAll(/(?<![\p{L}\p{N}_$])\$([\p{L}\p{N}_:-]+(?:\.[\p{L}\p{N}_:-]+)*)/gu),
		(match) => ({ name: match[1]!, start: match.index, end: match.index + match[0].length }));
}

export function isSkillMentionAt(text: string, mention: SkillMention): boolean {
	return Number.isSafeInteger(mention.start) && Number.isSafeInteger(mention.end)
		&& mention.start >= 0 && mention.end === mention.start + mention.name.length + 1
		&& text.slice(mention.start, mention.end) === '$' + mention.name
		&& !/[\p{L}\p{N}_$]$/u.test(text.slice(0, mention.start))
		&& !/^(?:[\p{L}\p{N}_:-]|\.[\p{L}\p{N}_:-])/u.test(text.slice(mention.end));
}

export function bindSkillMentions(text: string, mentions: readonly SkillMention[], items: readonly SkillInfo[]): SkillMention[] {
	const bound = new Map<number, SkillMention>();
	for (const mention of mentions) {
		if (!isSkillMentionAt(text, mention)) continue;
		const item = items.find((entry) => entry.id === mention.id && entry.name === mention.name);
		if (!item) throw new Error(`找不到原先选择的技能「${mention.name}」，请检查共享目录或重新选择。`);
		if (!item.enabled || !item.manual) throw new Error(`技能「${item.name}」已停用或不允许手动选择。`);
		bound.set(mention.start, { ...mention, sourceLabel: item.sourceLabel });
	}
	for (const token of skillNameTokens(text)) {
		if (bound.has(token.start)) continue;
		const sameName = items.filter((item) => item.name === token.name && item.manual && item.enabled);
		if (sameName.length > 1) throw new Error(`有多项技能名为「${token.name}」，请在 $ 菜单选择来源。`);
		const item = sameName[0];
		if (item) bound.set(token.start, { ...token, id: item.id, sourceLabel: item.sourceLabel });
	}
	return [...bound.values()].sort((a, b) => a.start - b.start);
}
