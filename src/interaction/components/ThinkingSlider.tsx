import { useLayoutEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { thinkingLabel, uiText } from '../uiText';

export interface ThinkingSelection {
	levels: readonly string[];
	level?: string;
}

export default function ThinkingSlider({ levels, level, disabled, onChange }:
	ThinkingSelection & { disabled: boolean; onChange: (level: string) => void }) {
	const text = uiText();
	const index = Math.max(0, level ? levels.indexOf(level) : 0);
	const lastIndex = useRef(index);
	const thumb = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => { lastIndex.current = index; });
	const last = levels.length - 1;
	const current = levels[index];
	if (!current) return null;
	const locked = disabled || last === 0;
	const label = thinkingLabel(text, current);

	function select(next: number) {
		const clamped = Math.min(last, Math.max(0, next));
		const value = levels[clamped];
		if (locked || !value || clamped === lastIndex.current) return;
		lastIndex.current = clamped;
		onChange(value);
	}

	function fromPointer(event: PointerEvent<HTMLDivElement>) {
		const { left, width } = event.currentTarget.getBoundingClientRect();
		const thumbWidth = thumb.current?.offsetWidth ?? 0;
		const travel = Math.max(1, width - thumbWidth);
		select(Math.round(last * (event.clientX - left - thumbWidth / 2) / travel));
	}

	return <section className="scribe-thinking-card-slider" aria-label={text.thinkingLevel}>
		<div className="scribe-thinking-caption"><span>{text.thinkingLevel}</span><strong title={label}>{label}</strong></div>
		<div className="scribe-thinking-track" role="slider" tabIndex={locked ? -1 : 0} aria-disabled={locked || undefined}
			aria-label={text.thinkingLevel} aria-valuemin={1} aria-valuemax={levels.length} aria-valuenow={index + 1} aria-valuetext={label}
			style={{ '--scribe-level-progress': last ? index / last : 0.5 } as CSSProperties}
			onKeyDown={(event) => {
				if (locked || event.nativeEvent.isComposing) return;
				const keys: Partial<Record<string, number>> = {
					ArrowLeft: lastIndex.current - 1, ArrowRight: lastIndex.current + 1, Home: 0, End: last,
				};
				const next = keys[event.key];
				if (next === undefined) return;
				event.preventDefault();
				select(next);
			}}
			onPointerDown={(event) => {
				if (locked || event.button !== 0 || !event.isPrimary) return;
				event.currentTarget.focus({ preventScroll: true });
				event.currentTarget.setPointerCapture(event.pointerId);
				fromPointer(event);
			}}
			onPointerMove={(event) => {
				if (!locked && event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
			}}>
			<div className="scribe-thinking-ticks" aria-hidden="true">
				{levels.map((item, tick) => <span key={item} data-state={tick === index ? 'current' : tick < index ? 'filled' : undefined} />)}
			</div>
			<span ref={thumb} className="scribe-thinking-thumb" aria-hidden="true" />
		</div>
	</section>;
}
