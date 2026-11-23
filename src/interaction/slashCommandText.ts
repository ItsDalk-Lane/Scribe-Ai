import { getLanguage } from 'obsidian';
import { slashCommandLabels } from './slashCommandMeta';
import type { slashGoalActions, SlashCommandName } from './slashCommands';

const goalLabels: Record<typeof slashGoalActions[number], readonly [string, string, string]> = {
	clear: ['Clear goal', '清除目标', '清除目標'],
	edit: ['Edit goal', '编辑目标', '編輯目標'],
	pause: ['Pause goal', '暂停目标', '暫停目標'],
	resume: ['Resume goal', '继续目标', '繼續目標'],
};

const descriptions: Record<SlashCommandName, readonly [string, string, string]> = {
	presets: ['Create, edit, or run reusable prompts and commands', '新建、编辑或运行常用提示词和命令', '建立、編輯或執行常用提示詞和命令'],
	approve: ['Allow one retry of a recently denied operation', '允许重试一次最近被拦截的操作', '允許重試一次最近被攔截的操作'],
	skills: ['Browse and choose skills', '浏览和选择技能', '瀏覽和選擇技能'],
	mcp: ['Browse MCP services', '浏览 MCP 服务', '瀏覽 MCP 服務'],
	agents: ['Choose a subagent role for this task', '为这次任务选择子 Agent 角色', '為這次任務選擇子 Agent 角色'],
	review: ['Review notes or changes and report findings', '审阅笔记或修改并列出问题', '審閱筆記或修改並列出問題'],
	compact: ['Compress earlier history used by the model', '压缩后续发送给模型的旧聊天内容', '壓縮後續傳送給模型的舊聊天內容'],
	config: ['Open Scribe Ai settings', '打开 Scribe Ai 设置', '開啟 Scribe Ai 設定'],
	recap: ['Summarize what happened in this chat', '总结这次聊天的进展', '總結這次聊天的進度'],
	plan: ['Switch to Plan mode', '切换到计划模式', '切換到計畫模式'],
	goal: ['Draft a goal', '输入目标', '輸入目標'],
	side: ['Open a side chat', '打开侧聊', '開啟側聊'],
	export: ['Export the chat as a Markdown note', '将聊天导出为 Markdown 笔记', '將聊天匯出為 Markdown 筆記'],
	diff: ['View changes from this chat', '查看这次聊天产生的修改', '查看這次聊天產生的修改'],
	warnings: ['View connection errors and warnings', '查看连接错误和提醒', '查看連線錯誤和提醒'],
	clear: ['Clear the current view and start a new chat', '清空当前界面并开始新聊天', '清空目前畫面並開始新聊天'],
};

export interface SlashCommandText {
	label: string;
	commandLabel: (name: SlashCommandName) => string;
	goalActionLabel: (action: typeof slashGoalActions[number]) => string;
	newPreset: string;
	back: string;
	close: string;
	run: string;
	describe: (name: SlashCommandName) => string;
	unknown: (token: string) => string;
	noArgs: (name: SlashCommandName) => string;
	mainOnly: (name: SlashCommandName) => string;
}

export function slashCommandText(): SlashCommandText {
	const language = getLanguage().toLowerCase();
	const index = language.startsWith('zh') ? (/^zh-(?:tw|hk|hant)/u.test(language) ? 2 : 1) : 0;
	const label = ['Slash commands', '斜杠命令', '斜線命令'][index]!;
	return {
		label,
		commandLabel: (name: SlashCommandName) => slashCommandLabels[name][index],
		goalActionLabel: (action) => goalLabels[action][index],
		newPreset: ['New preset', '新建预设', '新增預設'][index]!,
		back: ['Back to commands', '返回命令菜单', '返回命令選單'][index]!,
		close: ['Close', '关闭', '關閉'][index]!,
		run: ['Run command', '运行命令', '執行命令'][index]!,
		describe: (name: SlashCommandName) => descriptions[name][index],
		unknown: (token: string) => [
			`Unknown command /${token}. Type / to see available commands.`,
			`找不到命令 /${token}。输入 / 可查看可用命令。`,
			`找不到命令 /${token}。輸入 / 可查看可用命令。`,
		][index]!,
		noArgs: (name: SlashCommandName) => [
			`Remove the text after /${name} and try again.`,
			`请移除 /${name} 后面的文字再试一次。`,
			`請移除 /${name} 後面的文字再試一次。`,
		][index]!,
		mainOnly: (name: SlashCommandName) => [
			`/${name} is available in the main chat.`,
			`请在主聊天使用 /${name}。`,
			`請在主聊天使用 /${name}。`,
		][index]!,
	};
}
