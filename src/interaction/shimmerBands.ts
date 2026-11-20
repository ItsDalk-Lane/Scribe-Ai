export function shimmerBands(length: number, now: number): string {
	const padding = 10;
	const halfWidth = 6;
	const position = (now / 1000 * 30) % (length + 2 * padding);
	let bands = '';
	for (let index = 0; index < length; index++) {
		const distance = Math.abs(index + padding - position);
		const strength = distance >= halfWidth ? 0 : 0.5 * (1 + Math.cos(Math.PI * distance / halfWidth));
		bands += strength >= 0.65 ? '2' : strength >= 0.22 ? '1' : '0';
	}
	return bands;
}
