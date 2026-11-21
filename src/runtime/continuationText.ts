import type { Message } from '../types';

export function isSteeringMessage(message: Message | undefined): boolean {
	return message?.role === 'user' && message.id?.startsWith('steer:') === true;
}

export function latestIncompleteReply(messages: Message[]): string | undefined {
	const fragments: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (isSteeringMessage(message)) continue;
		if (message.role !== 'assistant' || (!message.incomplete && !message.truncated)) break;
		fragments.push(message.content);
	}
	return fragments.length ? fragments.reverse().join('') : undefined;
}

const nextActionChinese = new RegExp(
	/(?:^|[，,]\s*)(?:(?:接下[来來]|下一步|[现現]在)[，,\s]*(?:我[们們]?)?(?:[将將会會要]|需要)?|我[们們]?(?:接下[来來]|[现現]在)?(?:[将將会會要先再]|[还還]要|[还還]?需要)|[让讓]我)\s*/u.source
	+ /(?:先|再|[继繼][续續]|[开開]始|去){0,2}\s*/u.source
	+ /(?:做|[读讀]|看|[检檢]查|核[对對]|[验驗][证證]|[执執]行|[运運]行|查找|搜[索尋]|[写寫]|改|建立|[创創]建|[处處]理|分析|整理|[测測][试試]|修[复復]|确[认認]|確認|打[开開]|[说說]明|[继繼][续續])/u.source,
	'u',
);
const nextActionEnglish = new RegExp(
	/(?:^|,\s*)(?:let me|(?:now |next,? )?(?:i|we)(?:['’]ll| (?:will|must|need to|have to))|the next step is to)\s+/iu.source
	+ /(?:now |first |continue to )?(?:read|check|verify|run|search|write|create|edit|update|test|fix|inspect|analyze|do|continue)\b/iu.source,
	'iu',
);
const unfinishedTail = /(?:[,，;；:：（([{]|以及|或者|因[为為]|所以|然[后後]|\b(?:and|or|but|with|because))$/iu;

export function mayHaveStoppedEarly(messages: readonly Message[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === 'user') break;
		if (message.role !== 'assistant' || message.incomplete) continue;
		const text = message.content.trimEnd();
		if (!text.trimStart()) continue;
		let fence: string | undefined;
		for (const [, marker = '', rest = ''] of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gmu)) {
			if (fence) {
				if (marker.startsWith(fence) && !rest.trim()) fence = undefined;
			} else if (!marker.startsWith('`') || !rest.includes('`')) fence = marker;
		}
		if (fence || unfinishedTail.test(text)) return true;
		if (/[?？]$/u.test(text)) return false;
		const lastSentence = text.slice(-160).replace(/[。.!！]$/u, '').split(/[。！？!?\r\n]|\.\s+/u).at(-1)?.trim() ?? '';
		return nextActionChinese.test(lastSentence) || nextActionEnglish.test(lastSentence);
	}
	return false;
}

export function newContinuationText(previous: string, next: string): string {
	const resumed = next.replace(/^(?:[ \t]*\r?\n)+/u, '');
	const repeats = (overlap: string) => resumed.startsWith(overlap) && overlap.trim().length >= 3 && /[\p{L}\p{N}]/u.test(overlap);
	if (repeats(previous)) return resumed.slice(previous.length);
	// shortcut: 除完整重复外，只匹配最近八行中完全相同的尾部，其他改写需可靠的对齐依据。
	const lines = previous.split('\n').slice(-8);
	for (let index = 0; index < lines.length; index++) {
		const overlap = lines.slice(index).join('\n');
		if (repeats(overlap)) {
			return resumed.slice(overlap.length);
		}
	}
	return next;
}
