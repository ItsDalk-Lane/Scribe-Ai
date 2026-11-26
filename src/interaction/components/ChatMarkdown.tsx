import { Component, Keymap, MarkdownRenderer, Notice, parseLinktext } from 'obsidian';
import type { App } from 'obsidian';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deferChatMediaEmbeds } from '../chatMedia';
import { renderChatMedia } from '../renderChatMedia';
import { splitMarkdownBlocks } from '../markdownBlocks';
import { resolveInlineNote } from '../noteCitations';
import { uiText } from '../uiText';

const wikilinkSource = /\\[\\[!]|(?<!`)(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)|!?\[\[(?<wiki>[^\][\r\n]+)\]\]/gu;

// 渲染后的链接会去掉双链两端的空格，从原文取回失效双链的完整写法。
function originalWikilinks(markdown: string): Map<string, string[]> {
	const originals = new Map<string, string[]>();
	for (const { 0: raw, groups } of markdown.matchAll(wikilinkSource)) {
		if (!groups?.wiki || !raw.startsWith('[[')) continue;
		const separator = groups.wiki.indexOf('|');
		const href = (separator < 0 ? groups.wiki : groups.wiki.slice(0, separator).replace(/\\$/u, '')).trim();
		const alias = separator < 0 ? null : groups.wiki.slice(separator + 1).trim();
		const key = JSON.stringify([href, alias]);
		const matches = originals.get(key);
		if (matches) matches.push(raw);
		else originals.set(key, [raw]);
	}
	return originals;
}

function replaceMissingLinks(element: HTMLElement, markdown: string, resolves: (href: string) => boolean) {
	let originals: Map<string, string[]> | undefined;
	for (const link of Array.from(element.querySelectorAll<HTMLAnchorElement>('a.internal-link[data-href]'))) {
		const href = link.dataset.href;
		if (!href || link.closest('.internal-embed') || resolves(href)) continue;
		originals ??= originalWikilinks(markdown);
		const alias = link.hasAttribute('aria-label') ? link.textContent : null;
		const raw = originals.get(JSON.stringify([href, alias]))?.shift();
		link.replaceWith(raw ?? link.textContent ?? '');
	}
}

function linkInlineNotes(app: App, element: HTMLElement, host: Component) {
	for (const code of Array.from(element.querySelectorAll('code'))) {
		if (code.closest('pre, a, button, .internal-embed')) continue;
		const candidate = code.textContent ?? '';
		const note = resolveInlineNote(app.vault, candidate);
		if (!note) continue;
		const link = element.createEl('a', { cls: 'internal-link', href: '#', title: note.file.path + note.subpath });
		code.replaceWith(link);
		link.append(code);
		const open = async (event: MouseEvent) => {
			if (event.defaultPrevented || event.button > 1) return;
			event.preventDefault();
			try {
				const exact = resolveInlineNote(app.vault, candidate);
				if (!exact) throw new Error();
				await app.workspace.getLeaf('tab').openFile(exact.file, {
					active: true, eState: exact.subpath ? { subpath: exact.subpath } : undefined,
				});
			} catch {
				new Notice(uiText().chatCitationUnavailable);
			}
		};
		host.registerDomEvent(link, 'click', (event) => void open(event));
		host.registerDomEvent(link, 'auxclick', (event) => void open(event));
	}
}

const MarkdownBlock = memo(function MarkdownBlock({ app, markdown, sourcePath, media }: { app: App; markdown: string; sourcePath: string; media: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const slot = ref.current;
		if (!slot) return;
		const rendered = slot.createDiv({ cls: 'scribe-markdown-block markdown-rendered' });
		const host = new Component();
		host.load();
		const resolves = (href: string) => Boolean(app.metadataCache.getFirstLinkpathDest(parseLinktext(href).path, sourcePath));
		// 静态渲染器生成链接，点击时由 Obsidian 工作区处理笔记路径和锚点。
		const openLink = (event: MouseEvent) => {
			if (event.defaultPrevented || event.button > 1) return;
			const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a.internal-link[data-href]');
			const href = link?.dataset.href;
			if (!href || link?.closest('.internal-embed')) return;
			event.preventDefault();
			if (resolves(href)) void app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(event) || 'tab');
		};
		host.registerDomEvent(rendered, 'click', openLink);
		host.registerDomEvent(rendered, 'auxclick', openLink);
		void (async () => {
			try {
				await MarkdownRenderer.render(app, deferChatMediaEmbeds(markdown), rendered, sourcePath, host);
				if (rendered.parentNode === slot) {
					replaceMissingLinks(rendered, markdown, resolves);
					linkInlineNotes(app, rendered, host);
					if (media) renderChatMedia(app, rendered, sourcePath, host);
				}
			} catch {
				if (rendered.parentNode === slot) rendered.textContent = markdown;
			}
		})();
		return () => {
			host.unload();
			rendered.remove();
		};
	}, [app, markdown, sourcePath, media]);
	return <div ref={ref} />;
});

export default memo(function ChatMarkdown({ app, content, media = false }: { app: App; content: string; media?: boolean }) {
	// 固定这条消息的相对链接来源，流式追加时保留之前的渲染块。
	const [sourcePath] = useState(() => app.workspace.getActiveFile()?.path ?? '');
	const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
	return (
		<div className="scribe-answer-markdown">
			{blocks.map((block, index) => <MarkdownBlock key={index} app={app} markdown={block.text} sourcePath={sourcePath} media={media} />)}
		</div>
	);
});
