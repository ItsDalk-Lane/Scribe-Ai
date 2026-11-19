import { getLanguage } from 'obsidian';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

export interface UiText {
	openChatCommand: string;
	generalTab: string;
	chatLocation: string;
	chatLocationDescription: string;
	rightSidebar: string;
	leftSidebar: string;
	editorTab: string;
	modelsTab: string;
	advancedTab: string;
	diagnostics: string;
	diagnosticsDescription: string;
	refresh: string;
	noDiagnostics: string;
	phaseConnecting: string;
	phaseStreaming: string;
	phaseDone: string;
	phaseError: string;
	proxy: string;
	modelsTitle: string;
	modelsDescription: string;
	addProvider: string;
	customEndpoint: string;
	customEndpointDescription: string;
	localModel: string;
	localModelDescription: string;
	localService: string;
	customAddress: string;
	noProvidersYet: string;
	noProvidersMatch: string;
	removeProvider: string;
	removeProviderConfirm: string;
	remove: string;
	cancel: string;
	noModelsAdded: string;
	credentialReady: string;
	credentialMissing: string;
	includeProviderModels: string;
	editCredential: string;
	configureModel: string;
	removeModel: string;
	removeModelConfirm: string;
	pickProvider: string;
	allProviders: string;
	categoryDomestic: string;
	categoryGlobal: string;
	categoryAggregator: string;
	categoryOther: string;
	providerVariant: string;
	providerEndpoints: string;
	configureProviderDescription: string;
	providerName: string;
	providerNameEmptyHint: string;
	baseUrl: string;
	protocol: string;
	protocolAuto: string;
	baseUrlNone: string;
	baseUrlRequired: string;
	models: string;
	fetchModels: string;
	fetchModelsDescription: string;
	selectedModels: string;
	addModel: string;
	refreshing: string;
	testConnection: string;
	testingConnection: string;
	connectionSucceeded: string;
	connectionFailed: string;
	testConnectionDescription: string;
	save: string;
	saveFailed: string;
	modelList: string;
	modelListDescription: string;
	modelId: string;
	contextWindow: string;
	maxOutputTokens: string;
	inputModality: string;
	outputModality: string;
	capabilities: string;
	capabilityReasoning: string;
	capabilityTools: string;
	capabilityStructured: string;
	thinkingLevel: string;
	thinkingLevelNames: Record<ModelThinkingLevel, string>;
	chatChooseModel: string;
	chatNoModelSelected: string;
	chatResumeThinkingUnavailable: string;
	customValue: string;
	modalityText: string;
	modalityImage: string;
	enterModelId: string;
	add: string;
	searchAvailableModels: string;
	noModelsMatch: string;
	noModelsDiscovered: string;
	loadingModels: string;
	back: string;
	modelConfiguration: string;
	defaults: string;
	modelConfigSaveNote: string;
	invalidModelConfiguration: string;
	duplicateModelId: string;
	refreshModels: string;
	refreshingModels: string;
	modelsRefreshed: string;
	refreshModelsFailed: string;
	searchProviders: string;
	noMatchingProviders: string;
	configureProvider: string;
	modelCount: string;
	modelsCount: string;
	credential: string;
	credentialLink: string;
	credentialLinked: string;
	credentialUnlink: string;
	subscriptionLogin: string;
	oauthLogin: string;
	oauthLoggingIn: string;
	oauthLoginSucceeded: string;
	oauthLoginFailed: string;
	oauthLoginCancelled: string;
	oauthOpenPage: string;
	oauthDeviceCode: string;
	proxyUrl: string;
	proxyDescription: string;
	model: string;
	modelDescription: string;
	taskPlaceholder: string;
	submit: string;
	noExecution: string;
	chatContextLabel: string;
	chatAddContext: string;
	chatPickVaultItem: string;
	chatSelectionPreview: string;
	chatRemoveSelection: string;
	chatAddExternalPath: string;
	chatPickExternalFile: string;
	chatPickExternalFolder: string;
	chatExternalPickerFailed: string;
	chatAbsolutePath: string;
	chatInvalidPath: string;
	chatFile: string;
	chatFolder: string;
	chatConversation: string;
	chatHistory: string;
	chatRecentConversations: string;
	chatConversationTitle: string;
	chatRenameConversation: string;
	chatDeleteConversation: string;
	chatDeleteConfirm: string;
	chatRenameError: string;
	chatDeleteError: string;
	chatNewConversation: string;
	chatUntitled: string;
	chatLoadingHistory: string;
	chatHistoryError: string;
	chatInterrupted: string;
	chatLastStep: string;
	chatStepStarting: string;
	chatStepModel: string;
	chatStepTool: string;
	chatStepApproval: string;
	chatStepResult: string;
	chatModelMissing: string;
	chatSubmitDisclosure: string;
	chatSelectionDisclosure: string;
	chatModelChanged: string;
	chatStop: string;
	chatResume: string;
	chatResumeReview: string;
	chatResumeAddress: string;
	chatResumeDisclosure: string;
	chatResumeScope: string;
	chatResumeContents: string;
	chatResumeRules: string;
	chatRunning: string;
	chatReconnecting: string;
	chatWaitingForConnection: string;
	chatRetryConnection: string;
	chatPartiallyDone: string;
	chatStopped: string;
	chatFailed: string;
	chatRunLimit: string;
	chatTurn: string;
	chatYou: string;
	chatAssistant: string;
	chatTranscript: string;
	chatEmptyHeading: string;
	chatExpandMessage: string;
	chatCollapseMessage: string;
	chatLatest: string;
	chatTurnNavigator: string;
	chatJumpToTurn: string;
	chatThinking: string;
	chatThinkingPending: string;
	chatThinkingDuration: string;
	chatResolved: string;
	chatTimelineApproval: string;
	chatTimelineWaitingConnection: string;
	chatTimelineContextRetry: string;
	chatTimelineUsage: string;
	chatToolGroupRead: string;
	chatToolGroupSearch: string;
	chatToolGroupEdit: string;
	chatToolGroupWrite: string;
	chatToolGroupRun: string;
	chatToolGroupGeneric: string;
	chatOpenToolTarget: string;
	chatResponding: string;
	chatCopyReply: string;
	chatCitationUnavailable: string;
	chatCopiedReply: string;
	chatCopyFailed: string;
	chatToolArguments: string;
	chatToolOutput: string;
	chatToolSkipped: string;
	chatToolNoChanges: string;
	chatToolMoreText: string;
	chatToolLessText: string;
	chatApprovalHeading: string;
	chatApprovalCreate: string;
	chatApprovalEdit: string;
	chatWorkingFolder: string;
	chatShellDisclosure: string;
	chatBefore: string;
	chatAfter: string;
	chatDiffChanges: string;
	chatDiffOldLine: string;
	chatDiffNewLine: string;
	chatDiffRemoved: string;
	chatDiffAdded: string;
	chatDiffNoNewline: string;
	chatDiffEmpty: string;
	chatDiffFullText: string;
	chatDiffFullPreview: string;
	chatCommand: string;
	chatVaultReference: string;
	chatCopyMessage: string;
	chatMessageCopied: string;
	chatEditFromHere: string;
	chatCancelEdit: string;
	chatForkReply: string;
	chatForkFailed: string;
	chatProcessSummary: string;
	chatActivitySummary: string;
	chatAverageSpeed: string;
	chatSpeedValue: string;
	chatActivityStats: string;
	chatModelDuration: string;
	chatToolDuration: string;
	chatFirstDelta: string;
	chatSpeed: string;
	chatMetricSeconds: string;
	chatMetricMinutes: string;
	chatSessionUsage: string;
	chatRunUsage: string;
	chatProviderModel: string;
	chatCacheHit: string;
	chatUncachedInput: string;
	chatCacheRead: string;
	chatCacheWrite: string;
	chatOutputTokens: string;
	chatTotalTokens: string;
	chatReportedCost: string;
	chatMissingUsage: string;
	chatIncompleteUsage: string;
	chatContextUsed: string;
	chatContextPending: string;
	chatContextStats: string;
	chatContextSource: string;
	chatPromptTokens: string;
	chatWindowCapacity: string;
	chatRemainingCapacity: string;
	chatMetricsRunning: string;
	chatApprove: string;
	chatDeny: string;
}

const EN: UiText = {
	openChatCommand: 'Open agent chat',
	generalTab: 'General',
	chatLocation: 'Chat location',
	chatLocationDescription: 'Where a new chat view opens. Changes apply after closing the current chat view.',
	rightSidebar: 'Right sidebar',
	leftSidebar: 'Left sidebar',
	editorTab: 'Editor tab',
	modelsTab: 'Models',
	advancedTab: 'Advanced',
	diagnostics: 'Diagnostic log',
	diagnosticsDescription: 'Recent model connections. Secrets and request data are excluded.',
	refresh: 'Refresh',
	noDiagnostics: 'No connection records yet.',
	phaseConnecting: 'Connecting',
	phaseStreaming: 'Streaming',
	phaseDone: 'Done',
	phaseError: 'Error',
	proxy: 'Proxy',
	modelsTitle: 'Models and providers',
	modelsDescription: 'Set up the provider and model used by the agent.',
	addProvider: 'Add a provider',
	customEndpoint: 'Custom endpoint',
	customEndpointDescription: 'Any OpenAI/Anthropic-compatible server',
	localModel: 'Local model',
	localService: 'Local service',
	customAddress: 'Custom address',
	localModelDescription: 'Ollama / LM Studio / llama.cpp on this machine',
	noProvidersYet: 'No providers yet — click + Add a provider to start.',
	noProvidersMatch: 'No providers match your search.',
	removeProvider: 'Remove provider',
	removeProviderConfirm: 'Remove {provider}? This also removes its model selection.',
	remove: 'Remove',
	cancel: 'Cancel',
	noModelsAdded: 'No models added',
	credentialReady: 'Credential configured',
	credentialMissing: 'Credential not configured',
	includeProviderModels: 'Include this provider’s model',
	editCredential: 'Edit credential',
	configureModel: 'Configure model',
	removeModel: 'Remove model',
	removeModelConfirm: 'Remove {model} from this provider?',
	pickProvider: 'Pick a provider to configure.',
	allProviders: 'All providers',
	categoryDomestic: 'China official',
	categoryGlobal: 'Global official',
	categoryAggregator: 'Aggregators',
	categoryOther: 'Other',
	providerVariant: 'Endpoint',
	providerEndpoints: '{count} endpoints',
	configureProviderDescription: 'Select a credential and choose which model to use.',
	providerName: 'Provider name',
	providerNameEmptyHint: 'This will use the default name "{label}".',
	baseUrl: 'Base URL',
	protocol: 'API protocol',
	protocolAuto: 'Follow each model\'s protocol',
	baseUrlNone: 'Models of this provider use different addresses, so there is no single default.',
	baseUrlRequired: 'Fill in the base URL first',
	models: 'Models',
	fetchModels: 'Fetch models',
	fetchModelsDescription: 'Fetching only reads the model directory; it does not test a chat connection.',
	selectedModels: 'Selected models',
	addModel: 'Add model',
	refreshing: 'Loading…',
	testConnection: 'Test chat connection',
	testingConnection: 'Testing chat connection…',
	connectionSucceeded: 'Connection succeeded',
	connectionFailed: 'Connection failed',
	testConnectionDescription: 'This sends one short message using the selected model.',
	save: 'Save',
	saveFailed: 'Failed to save changes',
	modelList: 'Model list',
	modelListDescription: 'Uncheck a model to remove it from your selection.',
	modelId: 'Model ID',
	contextWindow: 'Context window',
	maxOutputTokens: 'Output limit',
	inputModality: 'Input modality',
	outputModality: 'Output modality',
	capabilities: 'Capabilities',
	capabilityReasoning: 'Reasoning',
	capabilityTools: 'Tool calling',
	capabilityStructured: 'Structured output',
	thinkingLevel: 'Thinking level',
	thinkingLevelNames: { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Maximum' },
	chatChooseModel: 'Choose a model',
	chatNoModelSelected: 'No model selected',
	chatResumeThinkingUnavailable: 'The saved thinking level ({level}) is unavailable.',
	customValue: 'Custom',
	modalityText: 'Text',
	modalityImage: 'Image',
	enterModelId: 'Enter a model ID',
	add: 'Add',
	searchAvailableModels: 'Search available models…',
	noModelsMatch: 'No models match the current filters.',
	noModelsDiscovered: 'No models discovered — enter a model ID above or fetch models.',
	loadingModels: 'Loading models…',
	back: 'Back',
	modelConfiguration: 'Model configuration',
	defaults: 'Defaults',
	modelConfigSaveNote: 'Saving updates this model and the agent run limits.',
	invalidModelConfiguration: 'Enter a model ID and valid integer limits.',
	duplicateModelId: 'This model ID is already in the list.',
	refreshModels: 'Refresh model catalog',
	refreshingModels: 'Refreshing…',
	modelsRefreshed: 'Model catalog refreshed.',
	refreshModelsFailed: 'Failed to refresh model catalog',
	searchProviders: 'Search providers or models',
	noMatchingProviders: 'No providers or models match your search.',
	configureProvider: 'Configure provider',
	modelCount: '{count} model',
	modelsCount: '{count} models',
	credential: 'API key',
	credentialLink: 'Link',
	credentialLinked: 'Linked',
	credentialUnlink: 'Unlink',
	subscriptionLogin: 'Sign in with subscription',
	oauthLogin: 'Sign in with OAuth',
	oauthLoggingIn: 'Signing in…',
	oauthLoginSucceeded: 'Signed in. Save the provider to use this account.',
	oauthLoginFailed: 'Sign-in failed',
	oauthLoginCancelled: 'Sign-in cancelled',
	oauthOpenPage: 'Complete sign-in in your browser.',
	oauthDeviceCode: 'Device code (copied)',
	proxyUrl: 'Proxy URL',
	proxyDescription: 'Optional proxy URL for model requests.',
	model: 'Model',
	modelDescription: 'Choose a model from this provider’s catalog.',
	taskPlaceholder: 'Describe the task to complete',
	submit: 'Submit',
	noExecution: 'No execution records yet',
	chatContextLabel: 'Task files and folders',
	chatAddContext: 'Add context',
	chatPickVaultItem: 'Select a vault file or folder',
	chatSelectionPreview: 'Selected text preview',
	chatRemoveSelection: 'Remove selection',
	chatAddExternalPath: 'Path outside the vault',
	chatPickExternalFile: 'Choose file…',
	chatPickExternalFolder: 'Choose folder…',
	chatExternalPickerFailed: 'The system picker could not open. Enter the full path instead.',
	chatAbsolutePath: 'Full path to file or folder',
	chatInvalidPath: 'Enter the full path to an existing item of the selected type.',
	chatFile: 'File',
	chatFolder: 'Folder',
	chatConversation: 'Conversation',
	chatHistory: 'Chat history',
	chatRecentConversations: 'Recent chats',
	chatConversationTitle: 'Chat title',
	chatRenameConversation: 'Rename chat',
	chatDeleteConversation: 'Delete chat',
	chatDeleteConfirm: 'Permanently delete “{title}” and all of its messages? This cannot be undone.',
	chatRenameError: 'Could not save the chat title.',
	chatDeleteError: 'Could not delete the chat.',
	chatNewConversation: 'New conversation',
	chatUntitled: 'Untitled conversation',
	chatLoadingHistory: 'Loading conversation…',
	chatHistoryError: 'Could not load the saved conversation.',
	chatInterrupted: 'Interrupted',
	chatLastStep: 'Last saved step',
	chatStepStarting: 'Preparing the task',
	chatStepModel: 'Waiting for the model',
	chatStepTool: 'Running a tool',
	chatStepApproval: 'Waiting for approval',
	chatStepResult: 'Tool result received',
	chatModelMissing: 'Select a model in settings to start a task.',
	chatSubmitDisclosure: 'Submitting sends your instructions to {provider}. It may also send chat history and material read by tools.',
	chatSelectionDisclosure: 'Submitting sends your instructions and the attached selection to {provider}.',
	chatModelChanged: 'The model changed. Check the destination and submit again.',
	chatStop: 'Stop task',
	chatResume: 'Resume task',
	chatResumeReview: 'Review before resuming',
	chatResumeAddress: 'Destination',
	chatResumeDisclosure: 'Resuming uses the saved task. The first request is shown below. Later requests to this address may include more saved chat history and new tool results.',
	chatResumeScope: 'Files and folders attached to the saved task',
	chatResumeContents: 'Contents of the first request',
	chatResumeRules: 'Task rules',
	chatRunning: 'Running',
	chatReconnecting: 'Reconnecting to the model',
	chatWaitingForConnection: 'Model service unavailable. Progress is saved.',
	chatRetryConnection: 'Retry connection',
	chatPartiallyDone: 'Some operations incomplete',
	chatStopped: 'Stopped',
	chatFailed: 'Task failed',
	chatRunLimit: 'The task stopped at a limit',
	chatTurn: 'Round',
	chatYou: 'You',
	chatAssistant: 'Assistant',
	chatTranscript: 'Conversation messages',
	chatEmptyHeading: 'What can I help with?',
	chatExpandMessage: 'Show more',
	chatCollapseMessage: 'Show less',
	chatLatest: 'Jump to latest',
	chatTurnNavigator: 'Jump within conversation',
	chatJumpToTurn: 'Jump to turn {n}',
	chatThinking: 'Thinking',
	chatThinkingPending: 'Thinking…',
	chatThinkingDuration: 'Thought for {n} s',
	chatResolved: 'Resolved',
	chatTimelineApproval: 'Waiting for approval',
	chatTimelineWaitingConnection: 'Waiting to reconnect',
	chatTimelineContextRetry: 'Retrying with a shorter history',
	chatTimelineUsage: '{n} tokens',
	chatToolGroupRead: 'Read {count} files',
	chatToolGroupSearch: 'Ran {count} searches',
	chatToolGroupEdit: 'Made {count} edits',
	chatToolGroupWrite: 'Wrote {count} files',
	chatToolGroupRun: 'Ran {count} commands',
	chatToolGroupGeneric: 'Called {name} {count} times',
	chatOpenToolTarget: 'Open {target}',
	chatResponding: 'Writing a reply…',
	chatCopyReply: 'Copy reply',
	chatCitationUnavailable: 'Could not open the cited note.',
	chatCopiedReply: 'Reply copied',
	chatCopyFailed: 'Could not copy the reply',
	chatToolArguments: 'Call arguments',
	chatToolOutput: 'Tool output',
	chatToolSkipped: 'Skipped',
	chatToolNoChanges: 'No differences in the proposed text',
	chatToolMoreText: 'Show full recorded text',
	chatToolLessText: 'Show preview only',
	chatApprovalHeading: 'Approval needed',
	chatApprovalCreate: 'Create file',
	chatApprovalEdit: 'Edit file',
	chatWorkingFolder: 'Working folder',
	chatShellDisclosure: 'An approved command runs with your computer account’s permissions and can access files outside this folder.',
	chatBefore: 'Before',
	chatAfter: 'After',
	chatDiffChanges: 'Changes',
	chatDiffOldLine: 'Old',
	chatDiffNewLine: 'New',
	chatDiffRemoved: 'Removed',
	chatDiffAdded: 'Added',
	chatDiffNoNewline: 'No final newline',
	chatDiffEmpty: 'Empty file',
	chatDiffFullText: 'View full text',
	chatDiffFullPreview: 'Review the full before and after text for this change.',
	chatCommand: 'Command',
	chatVaultReference: 'Note or folder',
	chatCopyMessage: 'Copy',
	chatMessageCopied: 'Copied',
	chatEditFromHere: 'Edit from here',
	chatCancelEdit: 'Cancel',
	chatForkReply: 'Branch',
	chatForkFailed: 'Could not branch the conversation.',
	chatProcessSummary: 'Messages {messages} · Tool calls {tools}',
	chatActivitySummary: 'Turns {rounds} · Messages {messages}',
	chatAverageSpeed: 'Average {n} tokens/s',
	chatSpeedValue: '{n} tokens/s',
	chatActivityStats: 'Conversation activity',
	chatModelDuration: 'Model time',
	chatToolDuration: 'Tool time',
	chatFirstDelta: 'Average time to first token',
	chatSpeed: 'Average speed',
	chatMetricSeconds: '{s}s',
	chatMetricMinutes: '{m}m {s}s',
	chatSessionUsage: 'Token usage',
	chatRunUsage: 'Turn usage',
	chatProviderModel: 'Provider / model',
	chatCacheHit: 'Cache hit',
	chatUncachedInput: 'Uncached input',
	chatCacheRead: 'Cache read',
	chatCacheWrite: 'Cache write',
	chatOutputTokens: 'Output',
	chatTotalTokens: 'Total',
	chatReportedCost: 'Reported cost',
	chatMissingUsage: 'Some usage was not reported. Figures shown are based on reported data.',
	chatIncompleteUsage: 'Partial usage',
	chatContextUsed: '{n}% used',
	chatContextPending: 'Updates on next request',
	chatContextStats: 'Context {n}% used',
	chatContextSource: 'From the most recent request.',
	chatPromptTokens: 'Prompt tokens',
	chatWindowCapacity: 'Model context window',
	chatRemainingCapacity: 'Remaining capacity',
	chatMetricsRunning: 'Task is running.',
	chatApprove: 'Allow once',
	chatDeny: 'Decline',
};

const ZH_CN: UiText = {
	openChatCommand: '打开 Agent 对话',
	generalTab: '通用',
	chatLocation: '聊天界面位置',
	chatLocationDescription: '新建聊天界面时的打开位置。关闭当前聊天视图后，改动在下次打开时生效。',
	rightSidebar: '右侧边栏',
	leftSidebar: '左侧边栏',
	editorTab: '编辑器标签页',
	modelsTab: '模型',
	advancedTab: '高级',
	diagnostics: '诊断日志',
	diagnosticsDescription: '最近的模型连接记录，不包含密钥和请求内容。',
	refresh: '刷新',
	noDiagnostics: '暂无连接记录。',
	phaseConnecting: '连接中',
	phaseStreaming: '传输中',
	phaseDone: '完成',
	phaseError: '错误',
	proxy: '代理',
	modelsTitle: '模型与服务商',
	modelsDescription: '配置 Agent 使用的服务商和模型。',
	addProvider: '添加服务商',
	customEndpoint: '自定义端点',
	customEndpointDescription: '任意 OpenAI / Anthropic 兼容服务',
	localModel: '本地模型',
	localService: '本地服务',
	customAddress: '自定义地址',
	localModelDescription: '本机运行的 Ollama / LM Studio / llama.cpp',
	noProvidersYet: '尚未添加服务商，点击“添加服务商”开始。',
	noProvidersMatch: '没有匹配的服务商。',
	removeProvider: '移除服务商',
	removeProviderConfirm: '移除 {provider}？同时会清除其模型选择。',
	remove: '移除',
	cancel: '取消',
	noModelsAdded: '尚未添加模型',
	credentialReady: '凭据已配置',
	credentialMissing: '凭据未配置',
	includeProviderModels: '启用此服务商的模型',
	editCredential: '编辑凭据',
	configureModel: '配置模型',
	removeModel: '移除模型',
	removeModelConfirm: '从此服务商移除 {model}？',
	pickProvider: '选择要配置的服务商。',
	allProviders: '全部服务商',
	categoryDomestic: '国内官方',
	categoryGlobal: '国外官方',
	categoryAggregator: '聚合平台',
	categoryOther: '其它',
	providerVariant: '版本 / 端点',
	providerEndpoints: '{count} 个端点',
	configureProviderDescription: '选择凭据并设置要使用的模型。',
	providerName: '供应商名称',
	providerNameEmptyHint: '已清空，将使用默认名称“{label}”。',
	baseUrl: 'Base URL',
	protocol: 'API 协议',
	protocolAuto: '跟随各模型自带协议',
	baseUrlNone: '该服务商各模型地址不一致，没有统一的默认地址。',
	baseUrlRequired: '请先填写 Base URL',
	models: '模型',
	fetchModels: '获取模型',
	fetchModelsDescription: '获取操作只读取模型目录，不会测试聊天连接。',
	selectedModels: '已选模型',
	addModel: '添加模型',
	refreshing: '加载中…',
	testConnection: '测试聊天连接',
	testingConnection: '正在测试聊天连接…',
	connectionSucceeded: '连接成功',
	connectionFailed: '连接失败',
	testConnectionDescription: '将使用所选模型发送一条短消息。',
	save: '保存',
	saveFailed: '保存更改失败',
	modelList: '模型列表',
	modelListDescription: '取消勾选可从当前选择中移除模型。',
	modelId: '模型 ID',
	contextWindow: '上下文长度',
	maxOutputTokens: '输出上限',
	inputModality: '输入模态',
	outputModality: '输出模态',
	capabilities: '能力',
	capabilityReasoning: '推理/思考',
	capabilityTools: '工具调用',
	capabilityStructured: '结构化输出',
	thinkingLevel: '推理档位',
	thinkingLevelNames: { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' },
	chatChooseModel: '选择模型',
	chatNoModelSelected: '未选择模型',
	chatResumeThinkingUnavailable: '原任务使用的「{level}」推理档位已不可用。',
	customValue: '自定义',
	modalityText: '文本',
	modalityImage: '图片',
	enterModelId: '输入模型 ID',
	add: '添加',
	searchAvailableModels: '搜索可用模型…',
	noModelsMatch: '没有符合当前筛选条件的模型。',
	noModelsDiscovered: '尚未发现模型，请在上方输入模型 ID 或获取模型。',
	loadingModels: '正在加载模型…',
	back: '返回',
	modelConfiguration: '模型配置',
	defaults: '默认值',
	modelConfigSaveNote: '保存会更新当前模型和 Agent 运行限制。',
	invalidModelConfiguration: '请输入模型 ID 和有效的整数限制。',
	duplicateModelId: '列表中已存在这个模型 ID。',
	refreshModels: '刷新模型目录',
	refreshingModels: '正在刷新…',
	modelsRefreshed: '模型目录已刷新。',
	refreshModelsFailed: '刷新模型目录失败',
	searchProviders: '搜索服务商或模型',
	noMatchingProviders: '没有匹配的服务商或模型。',
	configureProvider: '配置服务商',
	modelCount: '{count} 个模型',
	modelsCount: '{count} 个模型',
	credential: 'API 秘钥',
	credentialLink: '链接',
	credentialLinked: '已链接',
	credentialUnlink: '删除链接',
	subscriptionLogin: '用订阅账号登录',
	oauthLogin: '用 OAuth 登录',
	oauthLoggingIn: '正在登录…',
	oauthLoginSucceeded: '已登录。保存服务商后即可使用此账号。',
	oauthLoginFailed: '登录失败',
	oauthLoginCancelled: '已取消登录',
	oauthOpenPage: '请在浏览器中完成登录。',
	oauthDeviceCode: '设备码（已复制）',
	proxyUrl: '代理服务器 URL',
	proxyDescription: '模型请求的可选代理服务器 URL。',
	model: '模型',
	modelDescription: '从该服务商的模型目录中选择。',
	taskPlaceholder: '描述要完成的任务',
	submit: '提交',
	noExecution: '暂无执行记录',
	chatContextLabel: '任务文件和文件夹',
	chatAddContext: '添加参考资料',
	chatPickVaultItem: '选择库内文件或文件夹',
	chatSelectionPreview: '选区预览',
	chatRemoveSelection: '移除选区',
	chatAddExternalPath: '库外路径',
	chatPickExternalFile: '选择文件…',
	chatPickExternalFolder: '选择文件夹…',
	chatExternalPickerFailed: '无法打开系统选择窗口，可以手动输入完整路径。',
	chatAbsolutePath: '文件或文件夹的完整路径',
	chatInvalidPath: '请输入实际存在且类型正确的完整路径。',
	chatFile: '文件',
	chatFolder: '文件夹',
	chatConversation: '对话',
	chatHistory: '历史对话',
	chatRecentConversations: '最近对话',
	chatConversationTitle: '对话标题',
	chatRenameConversation: '编辑标题',
	chatDeleteConversation: '删除对话',
	chatDeleteConfirm: '永久删除「{title}」及其全部消息？删除后无法撤销。',
	chatRenameError: '无法保存对话标题。',
	chatDeleteError: '无法删除对话。',
	chatNewConversation: '新建对话',
	chatUntitled: '未命名对话',
	chatLoadingHistory: '正在加载对话…',
	chatHistoryError: '无法加载已保存的对话。',
	chatInterrupted: '已中断',
	chatLastStep: '上次停在',
	chatStepStarting: '准备任务',
	chatStepModel: '等待模型回复',
	chatStepTool: '正在处理工具请求',
	chatStepApproval: '等待你确认',
	chatStepResult: '已收到工具结果',
	chatModelMissing: '请先在设置里选择模型。',
	chatSubmitDisclosure: '提交会向 {provider} 发送当前指令，也可能附带对话历史和工具读取的资料。',
	chatSelectionDisclosure: '提交会向 {provider} 发送当前指令和附上的选区。',
	chatModelChanged: '模型已更换。请确认发送对象，再提交任务。',
	chatStop: '停止任务',
	chatResume: '继续任务',
	chatResumeReview: '查看续做资料',
	chatResumeAddress: '发送地址',
	chatResumeDisclosure: '续做使用已保存的任务。下方是第一条请求的内容。任务继续后，还可能将本聊天的其他历史和新取得的资料发送到同一地址。',
	chatResumeScope: '原任务附上的文件和文件夹',
	chatResumeContents: '第一条请求将发送的内容',
	chatResumeRules: '任务规则',
	chatRunning: '正在运行',
	chatReconnecting: '正在重连模型服务',
	chatWaitingForConnection: '模型服务暂未恢复，任务进度已保留',
	chatRetryConnection: '重试连接',
	chatPartiallyDone: '部分操作未完成',
	chatStopped: '已停止',
	chatFailed: '任务失败',
	chatRunLimit: '任务已触发运行限制',
	chatTurn: '轮次',
	chatYou: '你',
	chatAssistant: '助手',
	chatTranscript: '对话消息',
	chatEmptyHeading: '有什么可以帮你？',
	chatExpandMessage: '展开消息',
	chatCollapseMessage: '收起消息',
	chatLatest: '回到最新消息',
	chatTurnNavigator: '对话跳转',
	chatJumpToTurn: '跳转到第 {n} 轮',
	chatThinking: '思考',
	chatThinkingPending: '思考中…',
	chatThinkingDuration: '思考了 {n} 秒',
	chatResolved: '已解决',
	chatTimelineApproval: '等待批准',
	chatTimelineWaitingConnection: '等待重连',
	chatTimelineContextRetry: '正在缩短对话记录并重试',
	chatTimelineUsage: '{n} 个 token',
	chatToolGroupRead: '读取了 {count} 个文件',
	chatToolGroupSearch: '搜索了 {count} 次',
	chatToolGroupEdit: '修改了 {count} 次',
	chatToolGroupWrite: '写入了 {count} 个文件',
	chatToolGroupRun: '执行了 {count} 条命令',
	chatToolGroupGeneric: '调用了 {name} {count} 次',
	chatOpenToolTarget: '打开 {target}',
	chatResponding: '正在回复…',
	chatCopyReply: '复制回复',
	chatCitationUnavailable: '无法打开这篇来源笔记。',
	chatCopiedReply: '已复制回复',
	chatCopyFailed: '无法复制回复',
	chatToolArguments: '调用参数',
	chatToolOutput: '工具输出',
	chatToolSkipped: '已跳过',
	chatToolNoChanges: '请求替换的内容没有差别',
	chatToolMoreText: '查看已记录的全文',
	chatToolLessText: '收起全文',
	chatApprovalHeading: '等待确认',
	chatApprovalCreate: '创建文件',
	chatApprovalEdit: '修改文件',
	chatWorkingFolder: '工作目录',
	chatShellDisclosure: '确认后，命令会以你的电脑账户权限运行，可以访问此文件夹之外的资料。',
	chatBefore: '修改前',
	chatAfter: '修改后',
	chatDiffChanges: '改动内容',
	chatDiffOldLine: '原行',
	chatDiffNewLine: '新行',
	chatDiffRemoved: '删除',
	chatDiffAdded: '新增',
	chatDiffNoNewline: '文末无换行',
	chatDiffEmpty: '空文件',
	chatDiffFullText: '查看全文',
	chatDiffFullPreview: '改动较大，请核对下方的完整原文和新内容。',
	chatCommand: '执行命令',
	chatVaultReference: '笔记/文件夹',
	chatCopyMessage: '复制',
	chatMessageCopied: '已复制',
	chatEditFromHere: '从这条编辑',
	chatCancelEdit: '取消',
	chatForkReply: '分支',
	chatForkFailed: '无法创建会话分支。',
	chatProcessSummary: '{messages} 条消息 · {tools} 次工具调用',
	chatActivitySummary: '{rounds} 轮 · {messages} 条消息',
	chatAverageSpeed: '平均速度 {n} 字/秒',
	chatSpeedValue: '{n} 字/秒',
	chatActivityStats: '会话活动',
	chatModelDuration: '大模型耗时',
	chatToolDuration: '工具耗时',
	chatFirstDelta: '平均首字延迟',
	chatSpeed: '平均速度',
	chatMetricSeconds: '{s} 秒',
	chatMetricMinutes: '{m} 分 {s} 秒',
	chatSessionUsage: '会话用量',
	chatRunUsage: '本轮用量',
	chatProviderModel: '提供方 / 模型',
	chatCacheHit: '缓存命中',
	chatUncachedInput: '未命中输入',
	chatCacheRead: '缓存读取',
	chatCacheWrite: '缓存写入',
	chatOutputTokens: '输出',
	chatTotalTokens: '合计',
	chatReportedCost: '实报成本',
	chatMissingUsage: '服务商返回的用量不完整，此处显示已收到的读数。',
	chatIncompleteUsage: '部分用量',
	chatContextUsed: '已用 {n}%',
	chatContextPending: '待下次请求更新',
	chatContextStats: '上下文已用 {n}%',
	chatContextSource: '读数来自最近一次请求。',
	chatPromptTokens: '提示词 token 总数',
	chatWindowCapacity: '模型窗口容量',
	chatRemainingCapacity: '剩余容量',
	chatMetricsRunning: '任务正在运行。',
	chatApprove: '仅允许本次',
	chatDeny: '拒绝',
};

const ZH_TW: UiText = {
	openChatCommand: '開啟 Agent 對話',
	generalTab: '一般',
	chatLocation: '聊天介面位置',
	chatLocationDescription: '新建聊天介面時的開啟位置。關閉目前聊天檢視後，變更在下次開啟時生效。',
	rightSidebar: '右側邊欄',
	leftSidebar: '左側邊欄',
	editorTab: '編輯器分頁',
	modelsTab: '模型',
	advancedTab: '進階',
	diagnostics: '診斷日誌',
	diagnosticsDescription: '最近的模型連線記錄，不包含金鑰和請求內容。',
	refresh: '重新整理',
	noDiagnostics: '尚無連線記錄。',
	phaseConnecting: '連線中',
	phaseStreaming: '傳輸中',
	phaseDone: '完成',
	phaseError: '錯誤',
	proxy: '代理',
	modelsTitle: '模型與服務商',
	modelsDescription: '設定 Agent 使用的服務商和模型。',
	addProvider: '新增服務商',
	customEndpoint: '自訂端點',
	customEndpointDescription: '任意 OpenAI / Anthropic 相容服務',
	localModel: '本機模型',
	localService: '本機服務',
	customAddress: '自訂地址',
	localModelDescription: '本機執行的 Ollama / LM Studio / llama.cpp',
	noProvidersYet: '尚未新增服務商，點擊「新增服務商」開始。',
	noProvidersMatch: '沒有符合的服務商。',
	removeProvider: '移除服務商',
	removeProviderConfirm: '移除 {provider}？同時會清除其模型選擇。',
	remove: '移除',
	cancel: '取消',
	noModelsAdded: '尚未新增模型',
	credentialReady: '憑證已設定',
	credentialMissing: '憑證未設定',
	includeProviderModels: '啟用此服務商的模型',
	editCredential: '編輯憑證',
	configureModel: '設定模型',
	removeModel: '移除模型',
	removeModelConfirm: '從此服務商移除 {model}？',
	pickProvider: '選擇要設定的服務商。',
	allProviders: '全部服務商',
	categoryDomestic: '國內官方',
	categoryGlobal: '國外官方',
	categoryAggregator: '聚合平台',
	categoryOther: '其它',
	providerVariant: '版本 / 端點',
	providerEndpoints: '{count} 個端點',
	configureProviderDescription: '選擇憑證並設定要使用的模型。',
	providerName: '供應商名稱',
	providerNameEmptyHint: '已清空，將使用預設名稱「{label}」。',
	baseUrl: 'Base URL',
	protocol: 'API 協定',
	protocolAuto: '跟隨各模型自帶協定',
	baseUrlNone: '該服務商各模型地址不一致，沒有統一的預設地址。',
	baseUrlRequired: '請先填寫 Base URL',
	models: '模型',
	fetchModels: '取得模型',
	fetchModelsDescription: '取得操作只讀取模型目錄，不會測試聊天連線。',
	selectedModels: '已選模型',
	addModel: '新增模型',
	refreshing: '載入中…',
	testConnection: '測試聊天連線',
	testingConnection: '正在測試聊天連線…',
	connectionSucceeded: '連線成功',
	connectionFailed: '連線失敗',
	testConnectionDescription: '將使用所選模型傳送一則短訊息。',
	save: '儲存',
	saveFailed: '儲存變更失敗',
	modelList: '模型列表',
	modelListDescription: '取消勾選可從目前選擇中移除模型。',
	modelId: '模型 ID',
	contextWindow: '上下文長度',
	maxOutputTokens: '輸出上限',
	inputModality: '輸入模態',
	outputModality: '輸出模態',
	capabilities: '能力',
	capabilityReasoning: '推理/思考',
	capabilityTools: '工具調用',
	capabilityStructured: '結構化輸出',
	thinkingLevel: '推理檔位',
	thinkingLevelNames: { off: '關閉', minimal: '極低', low: '低', medium: '中', high: '高', xhigh: '極高', max: '最高' },
	chatChooseModel: '選擇模型',
	chatNoModelSelected: '未選擇模型',
	chatResumeThinkingUnavailable: '原任務使用的「{level}」推理檔位已無法使用。',
	customValue: '自訂',
	modalityText: '文字',
	modalityImage: '圖片',
	enterModelId: '輸入模型 ID',
	add: '新增',
	searchAvailableModels: '搜尋可用模型…',
	noModelsMatch: '沒有符合目前篩選條件的模型。',
	noModelsDiscovered: '尚未發現模型，請在上方輸入模型 ID 或取得模型。',
	loadingModels: '正在載入模型…',
	back: '返回',
	modelConfiguration: '模型設定',
	defaults: '預設值',
	modelConfigSaveNote: '儲存會更新目前模型和 Agent 執行限制。',
	invalidModelConfiguration: '請輸入模型 ID 和有效的整數限制。',
	duplicateModelId: '清單中已存在這個模型 ID。',
	refreshModels: '重新整理模型目錄',
	refreshingModels: '正在重新整理…',
	modelsRefreshed: '模型目錄已重新整理。',
	refreshModelsFailed: '重新整理模型目錄失敗',
	searchProviders: '搜尋服務商或模型',
	noMatchingProviders: '沒有符合的服務商或模型。',
	configureProvider: '設定服務商',
	modelCount: '{count} 個模型',
	modelsCount: '{count} 個模型',
	credential: 'API 密鑰',
	credentialLink: '連結…',
	credentialLinked: '已連結',
	credentialUnlink: '刪除連結',
	subscriptionLogin: '用訂閱帳號登入',
	oauthLogin: '用 OAuth 登入',
	oauthLoggingIn: '正在登入…',
	oauthLoginSucceeded: '已登入。儲存服務商後即可使用此帳號。',
	oauthLoginFailed: '登入失敗',
	oauthLoginCancelled: '已取消登入',
	oauthOpenPage: '請在瀏覽器中完成登入。',
	oauthDeviceCode: '裝置碼（已複製）',
	proxyUrl: '代理伺服器 URL',
	proxyDescription: '模型請求的可選代理伺服器 URL。',
	model: '模型',
	modelDescription: '從此服務商的模型目錄中選擇。',
	taskPlaceholder: '描述要完成的任務',
	submit: '提交',
	noExecution: '尚無執行記錄',
	chatContextLabel: '任務檔案和資料夾',
	chatAddContext: '加入參考資料',
	chatPickVaultItem: '選擇庫內檔案或資料夾',
	chatSelectionPreview: '選取文字預覽',
	chatRemoveSelection: '移除選取的文字',
	chatAddExternalPath: '庫外路徑',
	chatPickExternalFile: '選擇檔案…',
	chatPickExternalFolder: '選擇資料夾…',
	chatExternalPickerFailed: '無法開啟系統選擇視窗，可以手動輸入完整路徑。',
	chatAbsolutePath: '檔案或資料夾的完整路徑',
	chatInvalidPath: '請輸入實際存在且類型正確的完整路徑。',
	chatFile: '檔案',
	chatFolder: '資料夾',
	chatConversation: '對話',
	chatHistory: '歷史對話',
	chatRecentConversations: '最近對話',
	chatConversationTitle: '對話標題',
	chatRenameConversation: '編輯標題',
	chatDeleteConversation: '刪除對話',
	chatDeleteConfirm: '永久刪除「{title}」及其全部訊息？刪除後無法復原。',
	chatRenameError: '無法儲存對話標題。',
	chatDeleteError: '無法刪除對話。',
	chatNewConversation: '新建對話',
	chatUntitled: '未命名對話',
	chatLoadingHistory: '正在載入對話…',
	chatHistoryError: '無法載入已儲存的對話。',
	chatInterrupted: '已中斷',
	chatLastStep: '上次停在',
	chatStepStarting: '準備任務',
	chatStepModel: '等待模型回覆',
	chatStepTool: '正在處理工具請求',
	chatStepApproval: '等待你確認',
	chatStepResult: '已收到工具結果',
	chatModelMissing: '請先在設定裡選擇模型。',
	chatSubmitDisclosure: '提交會向 {provider} 傳送目前的指令，也可能附上對話紀錄和工具讀取的資料。',
	chatSelectionDisclosure: '提交會向 {provider} 傳送目前的指令和附上的選取內容。',
	chatModelChanged: '模型已更換。請確認傳送對象，再提交任務。',
	chatStop: '停止任務',
	chatResume: '繼續任務',
	chatResumeReview: '查看續做資料',
	chatResumeAddress: '傳送地址',
	chatResumeDisclosure: '續做使用已儲存的任務。下方是第一個請求的內容。任務繼續後，還可能將本對話的其他紀錄和新取得的資料傳送到同一地址。',
	chatResumeScope: '原任務附上的檔案和資料夾',
	chatResumeContents: '第一個請求將傳送的內容',
	chatResumeRules: '任務規則',
	chatRunning: '執行中',
	chatReconnecting: '正在重新連線至模型服務',
	chatWaitingForConnection: '模型服務尚未恢復，已保留任務進度',
	chatRetryConnection: '重試連線',
	chatPartiallyDone: '部分操作未完成',
	chatStopped: '已停止',
	chatFailed: '任務失敗',
	chatRunLimit: '任務已觸發執行限制',
	chatTurn: '輪次',
	chatYou: '你',
	chatAssistant: '助理',
	chatTranscript: '對話訊息',
	chatEmptyHeading: '有什麼可以幫你？',
	chatExpandMessage: '展開訊息',
	chatCollapseMessage: '收起訊息',
	chatLatest: '回到最新訊息',
	chatTurnNavigator: '對話跳轉',
	chatJumpToTurn: '跳轉到第 {n} 輪',
	chatThinking: '思考',
	chatThinkingPending: '思考中…',
	chatThinkingDuration: '思考了 {n} 秒',
	chatResolved: '已解決',
	chatTimelineApproval: '等待核准',
	chatTimelineWaitingConnection: '等待重新連線',
	chatTimelineContextRetry: '正在縮短對話記錄並重試',
	chatTimelineUsage: '{n} 個 token',
	chatToolGroupRead: '讀取了 {count} 個檔案',
	chatToolGroupSearch: '搜尋了 {count} 次',
	chatToolGroupEdit: '修改了 {count} 次',
	chatToolGroupWrite: '寫入了 {count} 個檔案',
	chatToolGroupRun: '執行了 {count} 條指令',
	chatToolGroupGeneric: '呼叫了 {name} {count} 次',
	chatOpenToolTarget: '開啟 {target}',
	chatResponding: '正在回覆…',
	chatCopyReply: '複製回覆',
	chatCitationUnavailable: '無法開啟這篇來源筆記。',
	chatCopiedReply: '已複製回覆',
	chatCopyFailed: '無法複製回覆',
	chatToolArguments: '呼叫參數',
	chatToolOutput: '工具輸出',
	chatToolSkipped: '已跳過',
	chatToolNoChanges: '請求取代的內容沒有差別',
	chatToolMoreText: '查看已記錄的全文',
	chatToolLessText: '收起全文',
	chatApprovalHeading: '等待確認',
	chatApprovalCreate: '建立檔案',
	chatApprovalEdit: '修改檔案',
	chatWorkingFolder: '工作目錄',
	chatShellDisclosure: '確認後，命令會以你的電腦帳戶權限執行，可以存取此資料夾以外的資料。',
	chatBefore: '修改前',
	chatAfter: '修改後',
	chatDiffChanges: '變更內容',
	chatDiffOldLine: '原行',
	chatDiffNewLine: '新行',
	chatDiffRemoved: '刪除',
	chatDiffAdded: '新增',
	chatDiffNoNewline: '文末無換行',
	chatDiffEmpty: '空檔案',
	chatDiffFullText: '查看全文',
	chatDiffFullPreview: '變更較大，請核對下方完整的原文和新內容。',
	chatCommand: '執行命令',
	chatVaultReference: '筆記／資料夾',
	chatCopyMessage: '複製',
	chatMessageCopied: '已複製',
	chatEditFromHere: '從這則編輯',
	chatCancelEdit: '取消',
	chatForkReply: '分支',
	chatForkFailed: '無法建立對話分支。',
	chatProcessSummary: '{messages} 則訊息 · {tools} 次工具呼叫',
	chatActivitySummary: '{rounds} 輪 · {messages} 則訊息',
	chatAverageSpeed: '平均速度 {n} 字／秒',
	chatSpeedValue: '{n} 字／秒',
	chatActivityStats: '對話活動',
	chatModelDuration: '模型耗時',
	chatToolDuration: '工具耗時',
	chatFirstDelta: '平均首字延遲',
	chatSpeed: '平均速度',
	chatMetricSeconds: '{s} 秒',
	chatMetricMinutes: '{m} 分 {s} 秒',
	chatSessionUsage: '對話用量',
	chatRunUsage: '本輪用量',
	chatProviderModel: '服務商／模型',
	chatCacheHit: '快取命中',
	chatUncachedInput: '未命中輸入',
	chatCacheRead: '快取讀取',
	chatCacheWrite: '快取寫入',
	chatOutputTokens: '輸出',
	chatTotalTokens: '合計',
	chatReportedCost: '實報成本',
	chatMissingUsage: '服務商回傳的用量不完整，此處顯示已收到的讀數。',
	chatIncompleteUsage: '部分用量',
	chatContextUsed: '已用 {n}%',
	chatContextPending: '待下次請求更新',
	chatContextStats: '上下文已用 {n}%',
	chatContextSource: '讀數來自最近一次請求。',
	chatPromptTokens: '提示詞 token 總數',
	chatWindowCapacity: '模型視窗容量',
	chatRemainingCapacity: '剩餘容量',
	chatMetricsRunning: '任務正在執行。',
	chatApprove: '僅允許本次',
	chatDeny: '拒絕',
};

export function uiText(): UiText {
	const language = getLanguage().toLowerCase();
	if (language.startsWith('zh-tw') || language.startsWith('zh-hk') || language.startsWith('zh-hant')) {
		return ZH_TW;
	}
	return language.startsWith('zh') ? ZH_CN : EN;
}
