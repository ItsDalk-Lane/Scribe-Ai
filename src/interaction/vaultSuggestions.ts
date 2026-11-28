import type { App, TAbstractFile, TFolder } from 'obsidian';

export function isVaultFolder(item: TAbstractFile): item is TFolder {
	return 'children' in item;
}

export function vaultSuggestions<T extends TAbstractFile>(app: Pick<App, 'vault' | 'workspace'>, query: string,
	accepts: (item: TAbstractFile) => item is T, limit = 40): T[] {
	const { vault, workspace } = app;
	const privateRoots = [vault.configDir.toLowerCase(), '.scribe-ai'];
	const publicItem = ({ path }: TAbstractFile) => {
		const folded = path.toLowerCase();
		return !privateRoots.some((root) => folded === root || folded.startsWith(`${root}/`));
	};
	const needle = query.trim().toLocaleLowerCase();
	const results = new Map<string, T>();
	if (!needle) {
		for (const path of workspace.getLastOpenFiles().slice(0, limit)) {
			const item = vault.getAbstractFileByPath(path);
			if (item && publicItem(item) && accepts(item)) results.set(item.path, item);
		}
		for (const item of vault.getRoot().children) {
			if (results.size === limit) break;
			if (publicItem(item) && accepts(item)) results.set(item.path, item);
		}
		return [...results.values()];
	}
	const slash = query.lastIndexOf('/');
	const prefix = slash > 0 ? vault.getAbstractFileByPath(query.slice(0, slash).trim()) : null;
	if (prefix && isVaultFolder(prefix) && !publicItem(prefix)) return [];
	const ranked: T[][] = [[], [], [], [], []];
	const levels = [(prefix && isVaultFolder(prefix) ? prefix : vault.getRoot()).children[Symbol.iterator]()];
	while (levels.length) {
		const next = levels.at(-1)!.next();
		if (next.done) { levels.pop(); continue; }
		const item = next.value;
		if (!publicItem(item)) continue;
		if (isVaultFolder(item)) levels.push(item.children[Symbol.iterator]());
		if (!accepts(item)) continue;
		const name = item.name.toLocaleLowerCase();
		const path = item.path.toLocaleLowerCase();
		const rank = name === needle || path === needle ? 4 : name.startsWith(needle) ? 3
			: name.includes(needle) ? 2 : path.includes(needle) ? 1 : 0;
		if (rank && ranked[rank]!.length < limit) ranked[rank]!.push(item);
		if (ranked[4]!.length === limit) break;
	}
	return ranked.reverse().flat().slice(0, limit);
}
