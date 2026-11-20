import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { shimmerBands } from '../shimmerBands';

export default memo(function ShimmerText({ text }: { text: string }) {
	const element = useRef<HTMLSpanElement>(null);
	const characters = useMemo(() => Array.from(text), [text]);
	const length = characters.length;
	const [bands, setBands] = useState<string>();

	useEffect(() => {
		const doc = element.current?.ownerDocument;
		const win = doc?.defaultView;
		if (!doc || !win) return;
		const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
		let frame = 0;
		let lastFrame = -Infinity;
		let previousBands: string | undefined;

		const tick = () => {
			if (doc.hidden || motion.matches) return;
			frame = win.requestAnimationFrame(tick);
			const now = win.performance.now();
			if (now - lastFrame < 33) return;
			lastFrame = now;
			const next = shimmerBands(length, now);
			if (next !== previousBands) {
				previousBands = next;
				setBands(next);
			}
		};

		const sync = () => {
			win.cancelAnimationFrame(frame);
			if (motion.matches) {
				previousBands = undefined;
				setBands(undefined);
			} else if (!doc.hidden) {
				frame = win.requestAnimationFrame(tick);
			}
		};
		sync();
		doc.addEventListener('visibilitychange', sync);
		motion.addEventListener('change', sync);
		return () => {
			win.cancelAnimationFrame(frame);
			doc.removeEventListener('visibilitychange', sync);
			motion.removeEventListener('change', sync);
		};
	}, [length]);

	const runs = [];
	if (bands?.length === length) {
		let start = 0;
		for (let end = 1; end <= length; end++) {
			const band = bands[start];
			if (bands[end] === band) continue;
			runs.push(<span key={start} data-band={band}>{characters.slice(start, end).join('')}</span>);
			start = end;
		}
	}
	return <span ref={element} className="scribe-working-shimmer" aria-hidden="true">{runs.length ? runs : text}</span>;
});
