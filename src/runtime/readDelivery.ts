import type { FileReadPage, Message, ReadDelivery } from '../types';

type Range = [start: number, end: number];

function revisionKey(path: string, fingerprint: string): string {
	return JSON.stringify([path, fingerprint]);
}

export function createReadDelivery(): ReadDelivery {
	const offered = new WeakMap<Message, FileReadPage>();
	const received = new Map<string, Range[]>();
	const complete = new Set<string>();
	return {
		remember(message, page) {
			offered.set(message, page);
		},
		accept(messages) {
			for (const message of messages) {
				// 截短或丢弃的结果不会以原消息进入模型请求。
				const page = offered.get(message);
				if (!page) continue;
				offered.delete(message);
				const key = revisionKey(page.path, page.fingerprint);
				if (complete.has(key)) continue;
				const ranges = [...(received.get(key) ?? []), [page.start, page.end] as Range];
				ranges.sort((left, right) => left[0] - right[0]);
				const merged: Range[] = [];
				for (const range of ranges) {
					const previous = merged.at(-1);
					if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
					else merged.push([...range]);
				}
				if (merged.length === 1 && merged[0]![0] === 0 && merged[0]![1] === page.lineCount) {
					complete.add(key);
					received.delete(key);
				} else {
					received.set(key, merged);
				}
			}
		},
		hasFullRead: (path, fingerprint) => complete.has(revisionKey(path, fingerprint)),
	};
}
