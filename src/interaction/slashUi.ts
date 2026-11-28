/**
 * Async UI used by slash commands. The panel replaces the command list in place
 * instead of opening a centered modal.
 */
export interface SlashUi {
	choose<T>(title: string, items: readonly T[] | ((query: string) => readonly T[]), label: (item: T) => string,
		search?: boolean): Promise<T | undefined>;
	prompt(title: string, initial?: string, multiline?: boolean): Promise<string | undefined>;
	confirm(title: string, message: string, confirmText?: string): Promise<boolean>;
	/** Resolves true when closed with the close button, false when backing out. */
	show(title: string, lines: readonly string[]): Promise<boolean>;
	/** Resolves true when closed with the close button, false when backing out. */
	panel(title: string, draw: (host: HTMLElement) => (() => void) | void): Promise<boolean>;
	custom<T>(title: string, draw: (host: HTMLElement, done: (value: T | undefined) => void) => (() => void) | void): Promise<T | undefined>;
}
