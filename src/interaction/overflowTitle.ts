export function updateOverflowTitle(element: HTMLElement, text: Element | null = element) {
	element.title = text && (text.scrollWidth > text.clientWidth || text.scrollHeight > text.clientHeight)
		? text.textContent ?? '' : '';
}
