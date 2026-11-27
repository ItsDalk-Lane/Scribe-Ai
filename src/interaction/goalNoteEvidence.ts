import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Message } from '../types';
import { maskMarkdownLiterals } from './chatMedia';

interface NoteObservation {
	/** 只取同一次回执的连续正文，不把不同版本或不同授权片段拼在一起。 */
	body?: string;
	start: number;
	digest?: string;
}

export function goalNoteObservations(messages: readonly Message[], notePath: (path: unknown) => path is string) {
	const latest = new Map<string, NoteObservation>();
	const changed = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== 'tool' || msg.isError !== false || msg.skipped) continue;
		let path: string;
		let body: string | undefined;
		let start = 1;
		if (msg.noteChange && (msg.toolName === 'Edit' || msg.toolName === 'Write')) {
			path = msg.noteChange.path;
			if (!notePath(path)) continue;
			changed.add(path);
			if ('after' in msg.noteChange) body = msg.noteChange.after;
		} else if (msg.toolName === 'Read') {
			const [header, ...lines] = msg.content.split(/\r?\n/u);
			const match = /^(.+)（(?:第 (\d+)–(\d+) 行|(空文件)|指定范围内没有可读取的行)）$/u.exec(header ?? '');
			if (!notePath(match?.[1])) continue;
			path = match[1];
			if (match[4]) body = '';
			else if (match[2]) {
				start = Number(match[2]);
				const count = Number(match[3]) - start + 1;
				const page = lines.slice(0, count);
				if (count > 0 && page.length === count && page.every((line, i) => line.startsWith(`${start + i}\t`))
					&& !lines.slice(count).some((line) => line.includes('截断'))) {
					body = page.map((line) => line.slice(line.indexOf('\t') + 1)).join('\n');
				}
			}
		} else continue;
		const digest = body === undefined ? undefined : createHash('sha256').update(JSON.stringify([path, start, body])).digest('hex');
		latest.set(path, { body, start, digest });
	}
	return { latest, changed };
}

interface GoalLink { target: string; label?: string }
type NoteCondition = { path: string } & ({ title: string } | { links: GoalLink[] });

// 用户的条件必须完整匹配。文件名有空格时可以用双链或反引号明确边界。
const filename = /(?:\[\[([^#|[\]\r\n]+\.md)\]\]|`([^`\r\n]+\.md)`|([^\s[\]`：:，,]+?\.md))/iu.source;
const namedNote = new RegExp('^(?:(?:在|向|将|把|为)\\s*|(?:in|the note)\\s+)?' + filename + '\\s*(?:中|内)?\\s*(.*)$', 'iu');
const titleFirst = new RegExp('^(?:set\\s+)?(?:the\\s+)?(?:title|h1)\\s+of\\s+' + filename + '\\s+(.+)$', 'iu');
const linkMarkup = /\[\[([^#[\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]|\[([^[\]\r\n]*)\]\(\s*(?:<([^<>\r\n]+)>|([^()\s<>]+))\s*\)/gu;

function goalLink(raw: string, file: string, relative: boolean, label?: string): GoalLink | undefined {
	let target = raw;
	if (/^https:\/\//iu.test(target)) {
		try { target = new URL(target).href; } catch { return; }
	} else {
		if (/[#?|\\:]/u.test(target) || target.startsWith('/')) return;
		if (relative) {
			try { target = decodeURIComponent(target); } catch { return; }
			if (!target.toLowerCase().endsWith('.md') || /[#?|\\:]/u.test(target) || target.startsWith('/')) return;
			target = posix.normalize(posix.join(posix.dirname(file), target));
		}
		if (!target || target.split('/').some((part) => !part || part === '..' || part === '.')) return;
		target = target.replace(/\.md$/iu, '');
	}
	return { target, ...(label && { label }) };
}

function inlineLink(match: RegExpExecArray, file: string) {
	return match[1] ? goalLink(match[1], file, false, match[2])
		: goalLink(match[4] ?? match[5]!, file, true, match[3]);
}

function specifiedLinks(condition: string, path: string) {
	const match = /^(?:(?:应|必须|需)?(?:包含|添加|补齐|补上|加入)\s*(?:(?:链接(?:到|至|[：:])?|指向)\s*)?|(?:(?:must|should)\s+)?(?:contains?|includes?|has|add)\s+(?:(?:the\s+)?(?:links?\s+to|links?\s*:)\s*)?)(.+?)\s*(?:(?:这|的)?(?:([一二两三四五六七八九十\d]+)条)?(?:笔记|内部|双向)?链接)?$/iu.exec(condition);
	let rest = match?.[1]?.trim();
	if (!rest) return;
	const links: GoalLink[] = [];
	const markup = new RegExp('^(?:' + linkMarkup.source + ')', 'u');
	while (rest) {
		const entry = markup.exec(rest);
		const plain: RegExpExecArray | null = entry ? null : /^(?:https:\/\/[^\s，、,<>\][()]+|[\w./-]+)/iu.exec(rest);
		if (!entry && (!plain || !/链接|links?/iu.test(condition))) return;
		const link = entry ? inlineLink(entry, path) : goalLink(plain![0], path, false);
		if (!link) return;
		links.push(link);
		rest = rest.slice((entry ?? plain)![0].length).trimStart();
		if (!rest) break;
		const separator = /^(?:(?:[、,，]\s*)?(?:and\s+|以及|和|与|及)|[、,，])\s*/iu.exec(rest);
		if (!separator) return;
		rest = rest.slice(separator[0].length);
		if (!rest) return;
	}
	const number = match?.[2]?.replace('两', '二');
	if (number) {
		const count = /^\d+$/u.test(number) ? Number(number) : ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'].indexOf(number) + 1;
		if (count !== new Set(links.map((link) => link.target)).size) return;
	}
	return links;
}

export function localNoteCondition(criterion: string): NoteCondition | undefined {
	const text = criterion.trim().replace(/[。.]$/u, '');
	const first = titleFirst.exec(text);
	const target = first ?? namedNote.exec(text);
	if (!target) return;
	const path = (target[1] ?? target[2] ?? target[3])!;
	const condition = first ? 'title ' + target[4]! : target[4]!;
	const title = /^(?:(?:的)?(?:一级标题|标题|H1)\s*(?:应为|必须为|必须等于|等于|为|是|改为|设为|设置为|=|：|:)|(?:'s\s+)?(?:title|h1)\s+(?:must be|should be|equals|is|to)|(?:has|must have)\s+(?:the\s+)?(?:title|h1))\s*(?:「([^」]+)」|“([^”]+)”|"([^"]+)"|`([^`]+)`|'([^']+)'|([\p{L}\p{N}_ -]+))$/iu.exec(condition);
	if (title) {
		if (title[6] && /并|同时|以及|且|还要|不得|不能|不要|或者|\b(?:and|or|with|without|but|except)\b/iu.test(title[6])) return;
		const exact = title.slice(1).find(Boolean)?.trim();
		return exact ? { path, title: exact } : undefined;
	}
	const links = specifiedLinks(condition, path);
	return links && { path, links };
}

export function noteConditionMet(condition: NoteCondition, observation: NoteObservation | undefined): boolean {
	if (observation?.start !== 1 || observation.body === undefined) return false;
	const body = /^---[ \t]*\r?\n/u.test(observation.body)
		? observation.body.replace(/^---[ \t]*\r?\n[\s\S]*?(?:^---[ \t]*\r?$|(?![\s\S]))/mu, '') : observation.body;
	// HTML 内容和数学表达式中的标记不会作为普通 Markdown 证据。
	const nonMarkdown = /<(?<tag>pre|code|script|style|textarea|div|table)\b[^>]*>[\s\S]*?(?:<\/\k<tag>\s*>|(?![\s\S]))|(?<!\\)\$\$[\s\S]*?(?:(?<!\\)\$\$|(?![\s\S]))|(?<![\\$])\$(?!\s)[^\n$]*?[^\s$]\$(?!\$)/giu;
	const source = maskMarkdownLiterals(body).replace(nonMarkdown, (part) => part.replace(/[^\r\n]/g, ' '));
	if ('title' in condition) {
		// 忽略代码中的伪标题，但保留标题原文，防止屏蔽片段后把不同标题认成相同。
		const heading = /^ {0,3}#[ \t]+[^\r\n]+/mu.exec(source);
		return Boolean(heading && body.slice(heading.index, heading.index + heading[0].length)
			.replace(/^ {0,3}#[ \t]+/u, '').replace(/[ \t]+#+[ \t]*$/u, '').trim() === condition.title);
	}
	const found = new Map<string, Set<string | undefined>>();
	for (const match of source.matchAll(linkMarkup)) {
		if (match.index && /[!\\]/u.test(source[match.index - 1]!)) continue;
		const link = inlineLink(match, condition.path);
		if (!link) continue;
		const labels = found.get(link.target) ?? new Set<string | undefined>();
		labels.add(link.label);
		found.set(link.target, labels);
	}
	return condition.links.every(({ target, label }) => label ? found.get(target)?.has(label) : found.has(target));
}
