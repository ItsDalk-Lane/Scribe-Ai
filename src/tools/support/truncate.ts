/** 工具结果的长度控制，避免超长内容占满模型上下文 */
export function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n…（已截断 ${text.length - limit} 字）`;
}
