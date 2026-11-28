import { parseLinktext } from 'obsidian';
import type { App, Component } from 'obsidian';
import { isAbsolute, win32 } from 'node:path';
import { bareChatMedia, chatMediaKind, remoteChatMedia } from './chatMedia';
import type { ChatMediaKind } from './chatMedia';
import { imagePreviewLabel, openImagePreview } from './imagePreview';
import { tr } from './skills/dialog';

const ignored = 'pre, code, .internal-embed, script, style';
const zoomable = 'img.scribe-chat-zoomable';

function mediaAction(kind: ChatMediaKind) {
	if (kind === 'image') return imagePreviewLabel();
	if (kind === 'video') return tr('播放视频', 'Play video');
	return tr('播放音频', 'Play audio');
}

function fileLabel(source: string) {
	const path = URL.parse(source)?.pathname ?? source;
	return path.slice(path.lastIndexOf('/') + 1);
}

function statusForMediaError(code: number | undefined) {
	if (code === 3) return tr('媒体无法解码。', 'The media could not be decoded.');
	if (code === 4) return tr('媒体地址已失效或格式无法播放。', 'The media is unavailable or its format is unsupported.');
	return tr('媒体加载失败，请打开原链接查看。', 'Could not load the media. Open the original link.');
}

function addPlayer(link: HTMLAnchorElement, kind: 'audio' | 'video', source: string, play: boolean, host: Component) {
	const win = link.ownerDocument.defaultView ?? window;
	const player = win.createEl(kind);
	player.addClass('scribe-chat-player');
	player.controls = true;
	if (kind === 'video') player.setAttribute('playsinline', '');
	player.preload = 'metadata';
	player.setAttribute('aria-label', link.textContent?.trim() || mediaAction(kind));
	link.after(player);
	link.hidden = true;
	player.tabIndex = 0;
	host.registerDomEvent(player, 'error', () => {
		if (!player.isConnected) return;
		const status = win.createSpan();
		status.className = 'scribe-chat-media-error';
		status.setAttribute('role', 'status');
		status.textContent = statusForMediaError(player.error?.code);
		player.replaceWith(status);
		link.hidden = false;
		link.removeClass('scribe-chat-media-link');
		link.removeAttribute('aria-label');
		if (play) link.focus({ preventScroll: true });
	});
	host.register(() => {
		player.pause();
		player.removeAttribute('src');
		player.load();
	});
	player.src = source;
	if (play) {
		player.focus({ preventScroll: true });
		void player.play().catch(() => { /* Native controls allow another play attempt. */ });
	}
}

function linkifyBareMedia(root: HTMLElement) {
	const win = root.ownerDocument.defaultView ?? window;
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		if (!node.parentElement?.closest(`a, button, ${ignored}`) && /https?:\/\//iu.test(node.data)) nodes.push(node);
	}
	for (const node of nodes) {
		const fragment = win.createFragment();
		let start = 0;
		for (const { index, source, label } of bareChatMedia(node.data)) {
			fragment.append(node.data.slice(start, index));
			const link = win.createEl('a');
			link.className = 'external-link';
			link.href = source;
			link.textContent = label;
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
			fragment.append(link);
			start = index + label.length;
		}
		if (start) {
			fragment.append(node.data.slice(start));
			node.replaceWith(fragment);
		}
	}
}

export function renderChatMedia(app: App, root: HTMLElement, sourcePath: string, host: Component) {
	const win = root.ownerDocument.defaultView ?? window;
	let closeImage: (() => void) | undefined;
	const preview = (source: string, label: string, trigger: HTMLElement, remote = false) => {
		closeImage?.();
		closeImage = openImagePreview(app, source, label, trigger, remote);
	};
	host.register(() => closeImage?.());

	linkifyBareMedia(root);
	for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href], a[data-href]'))) {
		if (link.closest(ignored) || link.querySelector('img')) continue;
		const href = link.dataset.href ?? link.getAttribute('href') ?? '';
		const remote = remoteChatMedia(href);
		if (remote) {
			const label = link.textContent?.trim() || fileLabel(remote.source);
			if (!link.textContent?.trim()) link.textContent = label;
			link.addClass('scribe-chat-media-link');
			link.setAttribute('aria-label', `${mediaAction(remote.kind)} · ${label}`);
			host.registerDomEvent(link, 'click', (event) => {
				if (!link.hasClass('scribe-chat-media-link') || event.defaultPrevented || event.button !== 0
					|| event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
				event.preventDefault();
				event.stopPropagation();
				if (remote.kind === 'image') preview(remote.source, label, link, true);
				else addPlayer(link, remote.kind, remote.source, true, host);
			});
			continue;
		}
		const { path } = parseLinktext(href);
		if (!path || isAbsolute(path) || win32.isAbsolute(path) || URL.parse(path)) continue;
		let decoded: string;
		try { decoded = decodeURIComponent(path); } catch { decoded = path; }
		if (!chatMediaKind(decoded) || isAbsolute(decoded) || win32.isAbsolute(decoded) || decoded.includes('\\')
			|| decoded.includes('\0') || URL.parse(decoded)) continue;
		const file = app.vault.getFileByPath(decoded) ?? app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
		const kind = file && chatMediaKind(file.path);
		if (!file || !kind) continue;
		const source = app.vault.getResourcePath(file);
		if (kind !== 'image') {
			addPlayer(link, kind, source, false, host);
			continue;
		}
		const image = win.createEl('img');
		image.alt = link.textContent?.trim() || file.name;
		host.registerDomEvent(image, 'error', () => {
			image.replaceWith(link);
			const status = win.createSpan();
			status.className = 'scribe-chat-media-error';
			status.setAttribute('role', 'status');
			status.textContent = tr('图片无法加载。', 'Could not load the image.');
			link.after(status);
		});
		link.replaceWith(image);
		image.src = source;
	}

	const armImage = (image: HTMLImageElement) => {
		if (image.matches(zoomable) || image.closest('pre, code, button')) return;
		image.addClass('scribe-chat-zoomable');
		const trigger = image.closest('a') ?? image;
		if (trigger === image) {
			trigger.tabIndex = 0;
			trigger.setAttribute('role', 'button');
		}
		trigger.setAttribute('aria-label', `${imagePreviewLabel()}${image.alt ? ` · ${image.alt}` : ''}`);
	};
	const scanImages = (element: Element) => {
		if (element.instanceOf(HTMLImageElement)) armImage(element);
		element.querySelectorAll<HTMLImageElement>('img').forEach(armImage);
	};
	scanImages(root);
	// Obsidian 的笔记库嵌入可能在 Markdown 首次渲染之后才插入图片。
	if (root.querySelector('.internal-embed')) {
		const observer = new win.MutationObserver((records) => {
			for (const { addedNodes } of records) addedNodes.forEach((node) => {
				if (node.nodeType === 1) scanImages(node as Element);
			});
		});
		observer.observe(root, { childList: true, subtree: true });
		host.register(() => observer.disconnect());
	}

	const enlarge = (event: MouseEvent | KeyboardEvent) => {
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
		if ('button' in event ? event.button !== 0 : event.key !== 'Enter' && event.key !== ' ') return;
		const target = event.target as Element | null;
		const image = target?.closest?.<HTMLImageElement>(zoomable)
			?? (target?.matches?.('a') && !('button' in event) ? target.querySelector<HTMLImageElement>(zoomable) : null);
		const source = image?.currentSrc || image?.src;
		if (!image || !source) return;
		event.preventDefault();
		event.stopPropagation();
		preview(source, image.alt, image.closest('a') ?? image);
	};
	host.registerDomEvent(root, 'click', enlarge, true);
	host.registerDomEvent(root, 'keydown', enlarge, true);
}
