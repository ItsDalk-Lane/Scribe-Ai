import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { parseNoteCitations } from './noteCitations';
import type { NoteCitation } from './noteCitations';

type RenderCitation = (citation: NoteCitation, key: number) => ReactNode;

const fencePattern = /^( {0,3})(`{3,}|~{3,})(.*)$/u;
const headingPattern = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/u;
const rulePattern = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const quotePattern = /^ {0,3}>[ \t]?(.*)$/u;
const listPattern = /^( {0,3})([-+*]|\d{1,9}[.)])[ \t]+(.*)$/u;
const tableRule = /^:?-{3,}:?$/u;
const maxNesting = 12;

// 引用和行内代码中的竖线属于原文，表格只用其余竖线分列。
const inlineSyntax = /\\(?:!?\[\[[^[\]]+\]\]|[\\`*_[\]|~])|!?\[\[[^[\]]+\]\]|(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)|\*+|_+|~+|\|/gu;

function renderInline(line: string, cite: RenderCitation): ReactNode[] {
	const groups: Array<{ marker: string; key: number; children: ReactNode[] }> = [
		{ marker: '', key: 0, children: [] },
	];
	let group = groups[0]!;
	let offset = 0;
	for (const { 0: raw, 1: ticks, 2: code, index } of line.matchAll(inlineSyntax)) {
		if (index > offset) group.children.push(line.slice(offset, index));
		offset = index + raw.length;

		if (ticks || raw.startsWith('[[')) {
			const [citation] = ticks && ticks !== '`' ? [] : parseNoteCitations(raw);
			if (typeof citation === 'object' && citation.raw === raw) group.children.push(cite(citation, index));
			else group.children.push(ticks ? <code key={index}>{code}</code> : raw);
		} else if (raw.startsWith('\\')) {
			group.children.push(raw.includes('[[') ? raw : raw.slice(1));
		} else if (/^(?:\*{1,2}|_{1,2}|~~)$/u.test(raw)) {
			const left = line[index - 1] ?? '';
			const right = line[offset] ?? '';
			const withinWord = raw.startsWith('_') && /[\p{L}\p{N}]/u.test(left) && /[\p{L}\p{N}]/u.test(right);
			if (!withinWord && group.marker === raw && /\S/u.test(left)) {
				const tag = raw === '~~' ? 'del' : raw.length === 2 ? 'strong' : 'em';
				const formatted = createElement(tag, { key: group.key }, group.children);
				groups.pop();
				group = groups[groups.length - 1]!;
				group.children.push(formatted);
			} else if (!withinWord && /\S/u.test(right) && groups.length < maxNesting) {
				group = { marker: raw, key: index, children: [] };
				groups.push(group);
			} else group.children.push(raw);
		} else group.children.push(raw);
	}
	if (offset < line.length) group.children.push(line.slice(offset));
	return groups.flatMap(({ marker, children }) => marker ? [marker, ...children] : children);
}

function tableCells(line: string): string[] | null {
	if (!line.includes('|')) return null;
	const text = line.trim();
	const cells: string[] = [];
	let offset = 0;
	for (const { 0: raw, index } of text.matchAll(inlineSyntax)) {
		if (raw !== '|') continue;
		cells.push(text.slice(offset, index).trim());
		offset = index + 1;
	}
	if (!cells.length) return null;
	cells.push(text.slice(offset).trim());
	if (text.startsWith('|')) cells.shift();
	if (offset === text.length) cells.pop();
	return cells;
}

function tableHeader(line: string, next: string): string[] | null {
	if (!/^[\s:|-]+$/u.test(next)) return null;
	const rules = tableCells(next);
	if (!rules?.length || !rules.every(cell => tableRule.test(cell))) return null;
	const cells = tableCells(line);
	return cells?.length === rules.length ? cells : null;
}

function startsBlock(line: string): boolean {
	return !line.trim() || fencePattern.test(line) || headingPattern.test(line)
		|| rulePattern.test(line) || quotePattern.test(line) || listPattern.test(line);
}

// shortcut: 仅渲染答复常用的 Markdown 子集；需要完整语法时再采用可审计的解析器。
function renderBlocks(lines: string[], cite: RenderCitation, depth: number): ReactNode[] {
	if (depth >= maxNesting) return [<p key={0}>{lines.join('\n')}</p>];
	const blocks: ReactNode[] = [];
	let pos = 0;
	while (pos < lines.length) {
		const key = pos;
		const line = lines[pos++]!;
		if (!line.trim()) continue;

		const fence = fencePattern.exec(line);
		if (fence) {
			const indent = fence[1]!.length;
			const marker = fence[2]!;
			const code: string[] = [];
			while (pos < lines.length) {
				const next = lines[pos++]!;
				const closing = fencePattern.exec(next);
				if (closing?.[2]?.startsWith(marker) && !closing[3]?.trim()) break;
				code.push(next.slice(Math.min(indent, /^ */u.exec(next)![0].length)));
			}
			blocks.push(<pre key={key} className="scribe-chat-pre" tabIndex={0}><code>{code.join('\n')}</code></pre>);
			continue;
		}

		const heading = headingPattern.exec(line);
		if (heading) {
			const text = heading[2]!.trimEnd().replace(/(?:^|[ \t])#+$/u, '').trimEnd();
			blocks.push(createElement(`h${heading[1]!.length}`, { key }, renderInline(text, cite)));
			continue;
		}
		if (rulePattern.test(line)) {
			blocks.push(<hr key={key} />);
			continue;
		}

		const quote = quotePattern.exec(line);
		if (quote) {
			const quoted = [quote[1]!];
			while (pos < lines.length) {
				const next = quotePattern.exec(lines[pos]!);
				if (!next) break;
				quoted.push(next[1]!);
				pos++;
			}
			blocks.push(<blockquote key={key}>{renderBlocks(quoted, cite, depth + 1)}</blockquote>);
			continue;
		}

		const firstItem = listPattern.exec(line);
		if (firstItem) {
			const indent = firstItem[1]!.length;
			const marker = firstItem[2]!;
			const ordered = /^\d/u.test(marker);
			const items: ReactNode[] = [];
			let item: RegExpExecArray | null = firstItem;
			while (item && item[1]!.length === indent && /^\d/u.test(item[2]!) === ordered) {
				const itemLines = [item[3]!];
				const bodyIndent = item[0].length - itemLines[0]!.length;
				while (pos < lines.length) {
					const next = lines[pos]!;
					if (!next.trim()) itemLines.push('');
					else if (next.startsWith(' '.repeat(bodyIndent))) itemLines.push(next.slice(bodyIndent));
					else break;
					pos++;
				}
				items.push(<li key={items.length}>{renderBlocks(itemLines, cite, depth + 1)}</li>);
				const next = lines[pos] ?? '';
				item = rulePattern.test(next) ? null : listPattern.exec(next);
				if (item && item[1]!.length === indent && /^\d/u.test(item[2]!) === ordered) pos++;
			}
			blocks.push(ordered ? <ol key={key} start={Number.parseInt(marker, 10)}>{items}</ol> : <ul key={key}>{items}</ul>);
			continue;
		}

		const next = lines[pos] ?? '';
		const headers = tableHeader(line, next);
		if (headers) {
			const rows: string[][] = [];
			pos++;
			while (pos < lines.length && !startsBlock(lines[pos]!)) {
				const cells = tableCells(lines[pos]!);
				if (!cells) break;
				rows.push(cells);
				pos++;
			}
			blocks.push(
				<div key={key} className="scribe-answer-table-scroll" tabIndex={0}>
					<table>
						<thead><tr>{headers.map((cell, col) => <th key={col} scope="col">{renderInline(cell, cite)}</th>)}</tr></thead>
						<tbody>{rows.map((row, i) => (
							<tr key={i}>{headers.map((_, col) => <td key={col}>{renderInline(row[col] ?? '', cite)}</td>)}</tr>
						))}</tbody>
					</table>
				</div>,
			);
			continue;
		}
		if (/^ {0,3}(?:=+|-+)[ \t]*$/u.test(next)) {
			pos++;
			const Heading = next.trimStart().startsWith('=') ? 'h1' : 'h2';
			blocks.push(<Heading key={key}>{renderInline(line.trim(), cite)}</Heading>);
			continue;
		}

		const paragraph = [line];
		while (pos < lines.length && !startsBlock(lines[pos]!) && !tableHeader(lines[pos]!, lines[pos + 1] ?? '')) {
			paragraph.push(lines[pos++]!);
		}
		blocks.push(<p key={key}>{paragraph.map((text, i) => (
			<Fragment key={i}>{i > 0 && <br />}{renderInline(text, cite)}</Fragment>
		))}</p>);
	}
	return blocks;
}

export function renderAnswerMarkdown(content: string, cite: RenderCitation): ReactNode[] {
	return renderBlocks(content.split(/\r\n?|\n/u), cite, 0);
}
