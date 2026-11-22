import { getLanguage } from 'obsidian';
import { slashCommandLabels } from './slashCommandMeta';
import type { SlashCommandName } from './slashCommands';

const descriptions: Record<SlashCommandName, readonly [string, string, string]> = {
	presets: ['Manage and run reusable prompts or commands', '管理和运行常用提示词或命令', '管理和執行常用提示詞或命令'],
	approve: ['Allow one retry of a recently denied operation', '允许重试一次最近被拦截的操作', '允許重試一次最近被攔截的操作'],
	skills: ['Browse and choose skills', '浏览和选择技能', '瀏覽和選擇技能'],
	review: ['Review notes or changes and report findings', '审阅笔记或修改并列出问题', '審閱筆記或修改並列出問題'],
	rename: ['Rename the current chat', '重命名当前聊天', '重新命名目前的聊天'],
	new: ['Start a new chat', '开始新聊天', '開始新聊天'],
	archive: ['Archive the current chat', '归档当前聊天', '封存目前的聊天'],
	delete: ['Permanently delete the current chat', '永久删除当前聊天', '永久刪除目前的聊天'],
	resume: ['Reopen a saved chat', '打开已保存的聊天', '開啟已儲存的聊天'],
	fork: ['Continue in a copy of the current chat', '从当前聊天创建分支', '從目前的聊天建立分支'],
	init: ['Set up writing rules for the vault', '设置笔记库的写作规则', '設定筆記庫的寫作規則'],
	compact: ['Compress earlier history used by the model', '压缩后续发送给模型的旧聊天内容', '壓縮後續傳送給模型的舊聊天內容'],
	config: ['Open Scribe Ai settings', '打开 Scribe Ai 设置', '開啟 Scribe Ai 設定'],
	recap: ['Summarize what happened in this chat', '总结这次聊天的进展', '總結這次聊天的進度'],
	plan: ['Switch to Plan mode', '切换到计划模式', '切換到計畫模式'],
	goal: ['Set or manage a long-running goal', '设置或管理持续任务的目标', '設定或管理持續任務的目標'],
	agents: ['Open the agent overview', '查看助手工作概况', '查看助理工作概況'],
	side: ['Open a side chat', '打开侧聊', '開啟側聊'],
	copy: ['Copy the latest reply or a section of it', '复制最新回答或其中一部分', '複製最新回答或其中一部分'],
	export: ['Export the chat as a Markdown note', '将聊天导出为 Markdown 笔记', '將聊天匯出為 Markdown 筆記'],
	diff: ['View changes from this chat', '查看这次聊天产生的修改', '查看這次聊天產生的修改'],
	mention: ['Reference a note or folder', '引用笔记或文件夹', '引用筆記或資料夾'],
	status: ['View chat settings and usage', '查看聊天设置和用量', '查看聊天設定和用量'],
	warnings: ['View connection errors and warnings', '查看连接错误和提醒', '查看連線錯誤和提醒'],
	usage: ['View recorded model usage', '查看已记录的模型用量', '查看已記錄的模型用量'],
	quit: ['Close the current chat tab', '关闭当前聊天标签', '關閉目前的聊天分頁'],
	ps: ['List background jobs for this chat', '查看当前聊天的后台任务', '查看目前聊天的背景任務'],
	stop: ['Stop background jobs for this chat', '停止当前聊天的后台任务', '停止目前聊天的背景任務'],
	clear: ['Clear the current view and start a new chat', '清空当前界面并开始新聊天', '清空目前畫面並開始新聊天'],
	'multi-agents': ['Switch to a subagent', '切换到子助手', '切換到子助理'],
};

export interface SlashCommandText {
	label: string;
	commandLabel: (name: SlashCommandName) => string;
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
