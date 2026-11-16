import { getLanguage } from 'obsidian';

export interface UiText {
	openChatCommand: string;
	enableAgent: string;
	provider: string;
	providerDescription: string;
	credential: string;
	credentialDescription: string;
	proxyUrl: string;
	proxyDescription: string;
	model: string;
	modelDescription: string;
	taskPlaceholder: string;
	submit: string;
	contextUnselected: string;
	noExecution: string;
	noApproval: string;
}

const EN: UiText = {
	openChatCommand: 'Open agent chat',
	enableAgent: 'Enable agent',
	provider: 'Provider',
	providerDescription: 'Model service ID used for requests.',
	credential: 'Provider credential',
	credentialDescription: 'Select a credential managed by Obsidian.',
	proxyUrl: 'Proxy URL',
	proxyDescription: 'Optional proxy URL for model requests.',
	model: 'Model',
	modelDescription: 'Model name used for requests.',
	taskPlaceholder: 'Describe the task to complete',
	submit: 'Submit',
	contextUnselected: 'Context: not selected',
	noExecution: 'No execution records yet',
	noApproval: 'No operations to approve',
};

const ZH_CN: UiText = {
	openChatCommand: '打开 Agent 对话',
	enableAgent: '启用 Agent',
	provider: '模型服务',
	providerDescription: '用于发送请求的模型服务 ID。',
	credential: '模型服务凭据',
	credentialDescription: '选择由 Obsidian 管理的凭据。',
	proxyUrl: '代理服务器 URL',
	proxyDescription: '模型请求的可选代理服务器 URL。',
	model: '模型',
	modelDescription: '用于发送请求的模型名称。',
	taskPlaceholder: '描述要完成的任务',
	submit: '提交',
	contextUnselected: '资料范围：尚未选择',
	noExecution: '暂无执行记录',
	noApproval: '没有待确认的操作',
};

const ZH_TW: UiText = {
	openChatCommand: '開啟 Agent 對話',
	enableAgent: '啟用 Agent',
	provider: '模型服務',
	providerDescription: '用於傳送請求的模型服務 ID。',
	credential: '模型服務憑證',
	credentialDescription: '選擇由 Obsidian 管理的憑證。',
	proxyUrl: '代理伺服器 URL',
	proxyDescription: '模型請求的可選代理伺服器 URL。',
	model: '模型',
	modelDescription: '用於傳送請求的模型名稱。',
	taskPlaceholder: '描述要完成的任務',
	submit: '提交',
	contextUnselected: '資料範圍：尚未選擇',
	noExecution: '尚無執行記錄',
	noApproval: '沒有待確認的操作',
};

export function uiText(): UiText {
	const language = getLanguage().toLowerCase();
	if (language.startsWith('zh-tw') || language.startsWith('zh-hk') || language.startsWith('zh-hant')) {
		return ZH_TW;
	}
	return language.startsWith('zh') ? ZH_CN : EN;
}
