import type { SlashCommandName } from './slashCommands';

// Display labels follow [English, Simplified Chinese, Traditional Chinese].
export const slashCommandLabels: Record<SlashCommandName, readonly [string, string, string]> = {
	presets: ['Presets', '预设', '預設'],
	approve: ['Approve', '批准', '批准'],
	skills: ['Skills', '技能', '技能'],
	mcp: ['MCP services', 'MCP 服务', 'MCP 服務'],
	agents: ['Agents', '子 Agent', '子 Agent'],
	review: ['Review', '审查', '審查'],
	compact: ['Compact', '压缩', '壓縮'],
	config: ['Settings', '配置', '設定'],
	recap: ['Recap', '回顾', '回顧'],
	plan: ['Plan', '计划模式', '計畫模式'],
	goal: ['Goal', '目标', '目標'],
	side: ['Side', '侧边聊天', '側邊聊天'],
	export: ['Export', '导出', '匯出'],
	diff: ['Diff', '差异', '差異'],
	warnings: ['Warnings', '警告', '警告'],
	clear: ['Clear', '清空聊天', '清空聊天'],
};

export const slashCommandIcons: Record<SlashCommandName, string> = {
	presets: 'list',
	approve: 'check',
	skills: 'book-open',
	mcp: 'plug',
	agents: 'users',
	review: 'scan-search',
	compact: 'minimize-2',
	config: 'settings',
	recap: 'scroll-text',
	plan: 'map',
	goal: 'target',
	side: 'panel-right',
	export: 'download',
	diff: 'git-compare',
	warnings: 'triangle-alert',
	clear: 'eraser',
};

// Commands that open a picker or another in-place panel show the right chevron.
export const slashCommandSubmenus: Partial<Record<SlashCommandName, true>> = {
	presets: true, approve: true, skills: true, mcp: true, agents: true, review: true, export: true, diff: true, warnings: true,
};
