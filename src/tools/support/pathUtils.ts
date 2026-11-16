/** 工具操作路径的处理与校验：统一为正斜杠并拒绝越出笔记库的路径 */
export function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function isInsideVault(path: string): boolean {
	return !normalizeVaultPath(path).split('/').includes('..');
}
