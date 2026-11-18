import { diffArrays } from 'diff';

export type ApprovalDiffRow = {
	kind: 'context' | 'remove' | 'add';
	oldLine?: number;
	newLine?: number;
	text: string;
	ending?: 'CRLF' | 'CR' | 'none';
};

const contextLines = 2;
const maxPreviewRows = 400;
const maxComparisonChars = 1_000_000;

function row(line: string, kind: ApprovalDiffRow['kind'], oldLine?: number, newLine?: number): ApprovalDiffRow {
	const ending = line.endsWith('\r\n') ? 'CRLF' : line.endsWith('\r') ? 'CR' : line.endsWith('\n') ? undefined : 'none';
	return { kind, oldLine, newLine, text: line.replace(/(?:\r\n|\r|\n)$/u, ''), ending };
}

function lines(text: string): string[] {
	return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? [];
}

/** 结果过大时由界面展示完整内容，避免省略任何改动。 */
export function approvalDiff(before: string, after: string): ApprovalDiffRow[][] | null {
	if (before === after) return [];
	if (before.length + after.length > maxComparisonChars) return null;
	const changes = diffArrays(lines(before), lines(after), { timeout: 60, maxEditLength: maxPreviewRows });
	if (!changes) return null;

	const groups: ApprovalDiffRow[][] = [];
	let leading: ApprovalDiffRow[] = [];
	let group: ApprovalDiffRow[] | undefined;
	let oldLine = 1;
	let newLine = 1;
	let visibleRows = 0;
	for (const [index, change] of changes.entries()) {
		const size = change.value.length;
		if (change.added || change.removed) {
			if (!group) {
				group = leading;
				groups.push(group);
				visibleRows += group.length;
			}
			visibleRows += size;
			if (visibleRows > maxPreviewRows) return null;
			for (const line of change.value) {
				group.push(change.added ? row(line, 'add', undefined, newLine++) : row(line, 'remove', oldLine++));
			}
			continue;
		}

		const merge = size <= contextLines * 2 && index < changes.length - 1;
		if (group) {
			const following = change.value.slice(0, merge ? size : contextLines);
			visibleRows += following.length;
			if (visibleRows > maxPreviewRows) return null;
			group.push(...following.map((line, offset) => row(line, 'context', oldLine + offset, newLine + offset)));
			if (!merge) group = undefined;
		}
		const leadingStart = Math.max(0, size - contextLines);
		leading = change.value.slice(leadingStart).map((line, offset) => (
			row(line, 'context', oldLine + leadingStart + offset, newLine + leadingStart + offset)
		));
		oldLine += size;
		newLine += size;
	}
	return groups;
}
