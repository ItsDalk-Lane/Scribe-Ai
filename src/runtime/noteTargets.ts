import { resolve } from 'node:path';

const writeStart = /^\s*(?:请(?:帮我)?\s*|(?:please|then)\s+)?(?:依次|分别|先)?\s*(?:创建|新建|写入|写出|写(?=\s|[`"“一两三四五六七八九十\d]|\[\[)|保存|修改|编辑|更新|(?:create|write|save|edit|update)\s+)\s*(?:(?:这)?(?:[一两三四五六七八九十]|\d+)篇笔记\s*[：:]?\s*)?/iu;

export function explicitNoteTargets(instruction: string, cwd: string): Map<string, string> {
	const targets = new Map<string, string>();
	const path = /(?:`[^`]+\.md`|"[^"]+\.md"|“[^”]+\.md”|\[\[[^\]|#]+\.md\]\]|[\p{L}\p{N}\p{M}_./\\:+-]+?\.md)/iyu;
	const separator = /\s*(?:[、，,]|以及|和|与|\band\b)\s*/iyu;
	const end = /\s*(?:(?:这)?(?:[一两三四五六七八九十]|\d+)篇(?:笔记)?|笔记)?\s*\.?\s*$/yu;
	// shortcut: 只识别独立的明确写入句及其 .md 路径列表，自由表述的交付目标需另有可靠的确认方式。
	const prose = instruction.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, '');
	for (const clause of prose.split(/[\r\n。；;！!？?]/u)) {
		const prefix = writeStart.exec(clause)?.[0];
		if (!prefix) continue;
		const listed: string[] = [];
		path.lastIndex = prefix.length;
		for (let match = path.exec(clause); match; match = path.exec(clause)) {
			listed.push(match[0].replace(/^(?:`|"|“|\[\[)|(?:`|"|”|\]\])$/gu, ''));
			end.lastIndex = path.lastIndex;
			if (end.test(clause)) {
				for (const target of listed) targets.set(resolve(cwd, target), target);
				break;
			}
			separator.lastIndex = path.lastIndex;
			if (!separator.test(clause)) break;
			path.lastIndex = separator.lastIndex;
		}
	}
	return targets;
}
