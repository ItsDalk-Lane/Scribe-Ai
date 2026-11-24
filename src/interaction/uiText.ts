import { getLanguage } from 'obsidian';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { isBuiltInThinkingLevel } from '../orchestration/settings/thinking';
import type { ContextCompaction, ModelConnection, ModelConnectionIssue, ShellStatus, ToolReviewStatus } from '../types';
import type { ModelCapabilityIcon } from './modelCapabilityIcons';

export interface UiText {
	openChatCommand: string;
	generalTab: string;
	personalizationTab: string;
	chatLocation: string;
	chatLocationDescription: string;
	customInstructions: string;
	editInstructions: string;
	instructionsPlaceholder: string;
	viewInstructionsSource: string;
	unsavedInstructions: string;
	discardInstructions: string;
	continueEditing: string;
	writingRuleSaved: string;
	writingRuleReadFailed: string;
	writingRuleChanged: string;
	rightSidebar: string;
	leftSidebar: string;
	editorTab: string;
	modelsTab: string;
	advancedTab: string;
	diagnostics: string;
	diagnosticsDescription: string;
	spillCleanupDays: string;
	spillCleanupDaysDescription: string;
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
	modelProtocolUnknown: string;
	modelProtocolAuto: string;
	modelProtocolAutomatic: string;
	modelAddressUnknown: string;
	modelAddressFromAuth: string;
	modelConnectionSources: Record<ModelConnection['source'], string>;
	modelConnectionIssues: Record<ModelConnectionIssue, string>;
	baseUrlNone: string;
	baseUrlRequired: string;
	models: string;
	fetchModels: string;
	fetchModelsDescription: string;
	modelsFromProvider: string;
	modelsFromPi: string;
	modelsFromBundled: string;
	modelsStale: string;
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
	modelCapabilityLabels: Record<ModelCapabilityIcon, string>;
	capabilityReasoning: string;
	capabilityTools: string;
	capabilityStructuredOutput: string;
	capabilityConnectionUnsupported: string;
	capabilityStatus: { supported: string; unsupported: string; unknown: string; conflict: string; manual: string; jsonOnly: string; videoUrl: string };
	capabilityStructured: string;
	thinkingLevel: string;
	thinkingLevelNames: Record<ModelThinkingLevel, string>;
	addThinkingLevel: string;
	removeThinkingLevel: string;
	customThinkingLevel: string;
	invalidThinkingLevel: string;
	chatChooseProvider: string;
	chatVisionModel: string;
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
	modelCatalogUnavailable: string;
	modelCatalogReadFailed: string;
	back: string;
	modelConfiguration: string;
	defaults: string;
	modelConfigSaveNote: string;
	invalidModelConfiguration: string;
	duplicateModelId: string;
	refreshModels: string;
	refreshModelsDescription: string;
	refreshingModels: string;
	modelsRefreshed: string;
	modelsRefreshPartial: string;
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
	chatExecutionMode: string;
	chatModeAsk: string;
	chatModeAskDescription: string;
	chatModeAutoReview: string;
	chatModeAutoReviewDescription: string;
	chatModeFullAccess: string;
	chatModeFullAccessDescription: string;
	chatModeFullAccessConfirm: string;
	chatModeFullAccessDisclosure: string;
	chatModeLocked: string;
	chatPickVaultItem: string;
	chatSearchReferences: string;
	chatNoReferences: string;
	chatNoReferenceText: string;
	chatSelectionPreview: string;
	chatRemoveQuotes: string;
	chatAddSelection: string;
	chatQuotedText: string;
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
	chatArchiveConversation: string;
	chatUnarchiveConversation: string;
	chatArchived: string;
	chatNoArchivedConversations: string;
	chatArchiveBusy: string;
	chatArchiveUnsaved: string;
	chatArchiveError: string;
	chatDeleteConversation: string;
	chatDeleteConfirm: string;
	chatRenameError: string;
	chatDeleteError: string;
	chatNewTab: string;
	chatTabs: string;
	chatCloseTab: string;
	chatMoreTabs: string;
	chatTabRunning: string;
	chatTabAttention: string;
	chatTabError: string;
	chatUntitled: string;
	chatLoadingHistory: string;
	chatNoSavedConversations: string;
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
	chatStopped: string;
	chatFailed: string;
	chatRunLimit: string;
	chatTurn: string;
	chatYou: string;
	chatAssistant: string;
	chatSubagentReport: string;
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
	chatTimelineAutoReview: string;
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
	chatWorkingThinking: string;
	chatWorkingSeconds: string;
	chatWorkingMinutes: string;
	chatWorkingHours: string;
	chatCopyReply: string;
	chatCitationUnavailable: string;
	chatCopiedReply: string;
	chatCopyFailed: string;
	chatToolArguments: string;
	chatToolOutput: string;
	chatSkillLoaded: string;
	chatSkillResourceRead: string;
	chatSkillReading: string;
	chatSkillFailed: string;
	chatSkillContent: string;
	chatSkillResource: string;
	chatSkillTask: string;
	chatSkillNoTask: string;
	chatSkillUnavailable: string;
	chatSkillUnknown: string;
	chatShellRecentOutput: string;
	chatShellRecentErrors: string;
	chatBackgroundJobs: string;
	chatBackgroundRunning: string;
	chatBackgroundStopping: string;
	chatBackgroundCountOne: string;
	chatBackgroundCountOther: string;
	chatBackgroundSectionLive: string;
	chatBackgroundSettledCount: string;
	chatBackgroundClear: string;
	chatBackgroundExpand: string;
	chatBackgroundCollapse: string;
	chatBackgroundStop: string;
	chatBackgroundConfirm: string;
	chatBackgroundConfirmAction: string;
	chatBackgroundStopFailed: string;
	chatBackgroundStopFailedLabel: string;
	chatBackgroundExitCode: string;
	chatBackgroundDurationSeconds: string;
	chatBackgroundDurationMinutes: string;
	chatBackgroundDurationHours: string;
	chatBackgroundDurationLive: string;
	chatBackgroundDurationDone: string;
	chatBackgroundNoOutput: string;
	chatBackgroundOutput: string;
	chatBackgroundLoadFailed: string;
	chatBackgroundSaveFailed: string;
	chatBackgroundReadSaveFailed: string;
	chatBackgroundApproval: string;
	chatToolSkipped: string;
	chatShellNotApproved: string;
	chatShellNotRun: string;
	chatShellReview: Record<ToolReviewStatus, string>;
	chatShellStatus: Record<ShellStatus, string>;
	chatToolNoChanges: string;
	chatToolMoreText: string;
	chatToolLessText: string;
	chatApprovalHeading: string;
	chatApprovalCreate: string;
	chatApprovalEdit: string;
	chatApprovalAccess: string;
	chatApprovalPathDisclosure: string;
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
	sideChatOpen: string;
	sideChatTitle: string;
	sideChatAskSelection: string;
	sideChatClose: string;
	sideChatPlaceholder: string;
	sideChatOpenFailed: string;
	queueCount: string;
	queueSending: string;
	queueEnterHint: string;
	queueImage: string;
	queueFile: string;
	queueEdit: string;
	queueSave: string;
	queueCancel: string;
	queueDelete: string;
	queueSteer: string;
	queueSteerUnavailable: string;
	queueSelectionUnavailable: string;
	queueSideChat: string;
	queueActionPending: string;
	queueMessageChanged: string;
	queueEditAttachment: string;
	queueEditFailed: string;
	queueDeleteFailed: string;
	queueSteerFailed: string;
	queueResume: string;
	queueSendFailed: string;
	queueStartFailed: string;
	sideChatBusy: string;
	sideChatExternalFolder: string;
	chatProcessSummary: string;
	chatActivitySummary: string;
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
	chatUsageRequests: string;
	chatContextUsed: string;
	chatContextStats: string;
	chatContextCompaction: string;
	chatContextCompacted: string;
	chatCompactionReason: string;
	chatCompactionReasons: Record<ContextCompaction['reason'], string>;
	chatCompactionDroppedHistory: string;
	chatCompactionDroppedCurrent: string;
	chatCompactionShortenedTools: string;
	chatCompactionSummary: string;
	chatCompactionSummaries: Record<ContextCompaction['summary'], string>;
	chatCompactionThrough: string;
	chatCompactionMessage: string;
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
	personalizationTab: 'Personalization',
	chatLocation: 'Chat location',
	chatLocationDescription: 'Where a new chat view opens. Changes apply after closing the current chat view.',
	customInstructions: 'Custom instructions',
	editInstructions: 'Edit',
	instructionsPlaceholder: 'Add custom instructions…',
	viewInstructionsSource: 'View source',
	unsavedInstructions: 'Save your changes before leaving?',
	discardInstructions: 'Discard changes',
	continueEditing: 'Continue editing',
	writingRuleSaved: 'Instructions saved. They apply from the next question.',
	writingRuleReadFailed: 'Could not read AGENTS.md. Reopen the editor to retry.',
	writingRuleChanged: 'AGENTS.md changed outside this editor. Copy your edits, then reopen the editor to see the latest version.',
	rightSidebar: 'Right sidebar',
	leftSidebar: 'Left sidebar',
	editorTab: 'Editor tab',
	modelsTab: 'Models',
	advancedTab: 'Advanced',
	diagnostics: 'Diagnostic log',
	diagnosticsDescription: 'Recent model connections. Secrets and request data are excluded.',
	spillCleanupDays: 'Spill cleanup period (days)',
	spillCleanupDaysDescription: 'At the next plugin start, remove private spill files older than this many days. Set 0 to disable cleanup.',
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
	includeProviderModels: 'Make this provider’s models available in chat',
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
	modelProtocolUnknown: 'Protocol unconfirmed',
	modelProtocolAuto: 'Select automatically',
	modelProtocolAutomatic: '{protocol} (automatic)',
	modelAddressUnknown: 'Enter the base URL for this protocol',
	modelAddressFromAuth: 'Determined by the Azure connection',
	modelConnectionSources: {
		catalog: 'Connection from the model catalog.',
		compatible: 'Using a compatible connection. This model has no explicit catalog entry for the connection.',
		configured: 'Using your connection settings.',
		unresolved: 'Connection unconfirmed.',
	},
	modelConnectionIssues: {
		'unknown-provider': 'The model provider is unavailable.',
		'missing-protocol': 'The model’s API protocol is unconfirmed. Select a protocol to connect.',
		'unsupported-protocol': 'This API protocol is unsupported. Select a different protocol.',
		'missing-address': 'Enter the base URL for this protocol.',
		'invalid-address': 'Enter a valid HTTP or HTTPS base URL.',
		'incompatible-address': 'The base URL does not match the API protocol or OpenCode plan. Correct or clear it.',
	},
	baseUrlNone: 'Models of this provider use different addresses, so there is no single default.',
	baseUrlRequired: 'Fill in the base URL first',
	models: 'Models',
	fetchModels: 'Fetch models',
	fetchModelsDescription: 'Read the model list from this vault’s saved data.',
	modelsFromProvider: 'Model list from the provider',
	modelsFromPi: 'Model list from Pi',
	modelsFromBundled: 'Model list from the bundled catalog',
	modelsStale: 'Showing the last saved list',
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
	modelCapabilityLabels: { eye: 'Vision', ear: 'Audio input', video: 'Video input', 'file-text': 'PDF input', lightbulb: 'Reasoning', wrench: 'Tools', braces: 'Structured output' },
	capabilityStatus: { supported: 'Supported', unsupported: 'Unsupported', unknown: 'Unconfirmed', conflict: 'Conflicting sources',
		manual: 'Manual setting', jsonOnly: 'JSON is advertised. JSON Schema is unconfirmed.', videoUrl: 'This connection accepts HTTPS video links.' },
	capabilityReasoning: 'Reasoning',
	capabilityTools: 'Tool calling',
	capabilityStructuredOutput: 'Structured output',
	capabilityConnectionUnsupported: 'Unavailable on this connection.',
	capabilityStructured: 'Structured output',
	thinkingLevel: 'Thinking level',
	thinkingLevelNames: { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Maximum' },
	addThinkingLevel: 'Add a thinking level',
	removeThinkingLevel: 'Remove {level}',
	customThinkingLevel: 'Custom English level',
	invalidThinkingLevel: 'Enter a new level in English using letters, numbers, hyphens or underscores.',
	chatChooseProvider: 'Choose a provider',
	chatVisionModel: 'Vision',
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
	noModelsDiscovered: 'No models in the saved list. Enter a model ID above.',
	loadingModels: 'Loading models…',
	modelCatalogUnavailable: 'No saved model data for this connection. Add a model by ID, save, then select Update model data in model settings.',
	modelCatalogReadFailed: 'Could not read the saved model data.',
	back: 'Back',
	modelConfiguration: 'Model configuration',
	defaults: 'Defaults',
	modelConfigSaveNote: 'Saving updates this model and the agent run limits.',
	invalidModelConfiguration: 'Enter a model ID and valid integer limits.',
	duplicateModelId: 'This model ID is already in the list.',
	refreshModels: 'Update model data',
	refreshModelsDescription: 'Update this vault’s model data from provider catalogs, Pi, and Models.dev.',
	refreshingModels: 'Updating model data…',
	modelsRefreshed: 'Model data updated.',
	modelsRefreshPartial: 'Some model data could not be updated. The previous data is still available.',
	refreshModelsFailed: 'Could not update model data.',
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
	chatContextLabel: 'Attached context',
	chatAddContext: 'Add context',
	chatExecutionMode: 'Execution mode',
	chatModeAsk: 'Ask for approval',
	chatModeAskDescription: 'Work in the vault and ask you for extra permissions.',
	chatModeAutoReview: 'Approve for me',
	chatModeAutoReviewDescription: 'Send requests for extra permissions to your selected model for a separate review.',
	chatModeFullAccess: 'Full access',
	chatModeFullAccessDescription: 'Access files outside the vault and use the internet without individual approvals.',
	chatModeFullAccessConfirm: 'Enable full access',
	chatModeFullAccessDisclosure: 'Scribe Ai can read and change files your computer account can access, including files outside this vault. It can also run commands and use the internet without individual approvals. This chat saves the mode, and new chats and tabs inherit it from the current chat.',
	chatModeLocked: 'You can change modes when the current task and queue finish.',
	chatPickVaultItem: 'Select a vault file or folder',
	chatSearchReferences: 'Search files, folders or chats',
	chatNoReferences: 'No matching references',
	chatNoReferenceText: 'This chat has no text to reference.',
	chatSelectionPreview: 'Selected text preview',
	chatRemoveQuotes: 'Remove quotes',
	chatAddSelection: 'Add to chat',
	chatQuotedText: 'Selected text ({n})',
	chatAddExternalPath: 'Path outside the vault',
	chatPickExternalFile: 'Choose external file',
	chatPickExternalFolder: 'Choose external folder',
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
	chatArchiveConversation: 'Archive chat',
	chatUnarchiveConversation: 'Unarchive chat',
	chatArchived: 'Archived',
	chatNoArchivedConversations: 'No archived chats',
	chatArchiveBusy: 'Finish running tasks and queued messages in this chat before archiving.',
	chatArchiveUnsaved: 'This chat has no saved messages to archive.',
	chatArchiveError: 'Could not update the chat’s archive status.',
	chatDeleteConversation: 'Delete chat',
	chatDeleteConfirm: 'Permanently delete “{title}” and all of its messages? This cannot be undone. Its side chat will also close and any unsent side-chat draft will be lost.',
	chatRenameError: 'Could not save the chat title.',
	chatDeleteError: 'Could not delete the chat.',
	chatNewTab: 'New tab',
	chatTabs: 'Conversation tabs',
	chatCloseTab: 'Close tab',
	chatMoreTabs: 'More tabs',
	chatTabRunning: 'Running',
	chatTabAttention: 'Needs attention',
	chatTabError: 'Task failed',
	chatUntitled: 'Untitled conversation',
	chatLoadingHistory: 'Loading conversation…',
	chatNoSavedConversations: 'No saved chats',
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
	chatStopped: 'Stopped',
	chatFailed: 'Task failed',
	chatRunLimit: 'The task stopped at a limit',
	chatTurn: 'Round',
	chatYou: 'You',
	chatAssistant: 'Assistant',
	chatSubagentReport: 'Returned results',
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
	chatTimelineAutoReview: 'AI review in progress',
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
	chatWorkingThinking: 'Thinking…',
	chatWorkingSeconds: '{s}s',
	chatWorkingMinutes: '{m}m {s}s',
	chatWorkingHours: '{h}h {m}m {s}s',
	chatCopyReply: 'Copy reply',
	chatCitationUnavailable: 'Could not open the cited note.',
	chatCopiedReply: 'Reply copied',
	chatCopyFailed: 'Could not copy the reply',
	chatToolArguments: 'Call arguments',
	chatToolOutput: 'Tool output',
	chatSkillLoaded: 'Loaded skill {name}',
	chatSkillResourceRead: 'Read skill resource ({name})',
	chatSkillReading: 'Reading skill…',
	chatSkillFailed: 'Could not read the skill',
	chatSkillContent: 'Skill content',
	chatSkillResource: 'Skill resource',
	chatSkillTask: 'Task description',
	chatSkillNoTask: 'No task description was provided.',
	chatSkillUnavailable: 'The saved skill content could not be restored.',
	chatSkillUnknown: 'Unknown skill',
	chatShellRecentOutput: 'Recent output',
	chatShellRecentErrors: 'Recent error output',
	chatBackgroundJobs: 'Background tasks',
	chatBackgroundRunning: 'Running',
	chatBackgroundStopping: 'Stopping',
	chatBackgroundCountOne: '{count} background task',
	chatBackgroundCountOther: '{count} background tasks',
	chatBackgroundSectionLive: 'Running',
	chatBackgroundSettledCount: 'Finished {count}',
	chatBackgroundClear: 'Clear',
	chatBackgroundExpand: 'Show live output of {label}',
	chatBackgroundCollapse: 'Hide live output of {label}',
	chatBackgroundStop: 'Stop task {label}',
	chatBackgroundConfirm: 'Click again to confirm',
	chatBackgroundConfirmAction: 'Confirm stop',
	chatBackgroundStopFailed: 'Could not stop the background task.',
	chatBackgroundStopFailedLabel: 'Stop failed',
	chatBackgroundExitCode: 'exit code {code}',
	chatBackgroundDurationSeconds: '{seconds}s',
	chatBackgroundDurationMinutes: '{minutes}m {seconds}s',
	chatBackgroundDurationHours: '{hours}h {minutes}m',
	chatBackgroundDurationLive: 'Running for {duration}',
	chatBackgroundDurationDone: 'Took {duration}',
	chatBackgroundNoOutput: '(no output)',
	chatBackgroundOutput: 'Output',
	chatBackgroundLoadFailed: 'Could not load saved background tasks.',
	chatBackgroundSaveFailed: 'The task result could not be saved.',
	chatBackgroundReadSaveFailed: 'Could not save the read state.',
	chatBackgroundApproval: 'This command will run in the background. Use its task ID to check output or stop it.',
	chatToolSkipped: 'Skipped',
	chatShellNotApproved: 'Not run (not approved)',
	chatShellNotRun: 'Not run',
	chatShellReview: { approved: 'AI review approved', denied: 'AI review did not approve', incomplete: 'AI review incomplete' },
	chatShellStatus: { success: 'Succeeded', failed: 'Failed', 'timed-out': 'Timed out', stopped: 'Stopped by user', 'start-failed': 'Failed to start' },
	chatToolNoChanges: 'No differences in the proposed text',
	chatToolMoreText: 'Show full recorded text',
	chatToolLessText: 'Show preview only',
	chatApprovalHeading: 'Approval needed',
	chatApprovalCreate: 'Create file',
	chatApprovalEdit: 'Edit file',
	chatApprovalAccess: 'Access files outside the vault',
	chatApprovalPathDisclosure: 'Access is granted for this operation only.',
	chatWorkingFolder: 'Working folder',
	chatShellDisclosure: 'After approval, the command can read and write files outside the vault within your computer account’s permissions. It can also access the network. The working folder only determines where the command starts.',
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
	sideChatOpen: 'Open side chat',
	sideChatTitle: 'Side chat',
	sideChatAskSelection: 'Ask in side chat',
	sideChatClose: 'Close side chat',
	sideChatPlaceholder: 'Ask a side question',
	sideChatOpenFailed: 'Could not open side chat in the right sidebar.',
	queueCount: '{n} queued messages',
	queueSending: 'Sending…',
	queueEnterHint: 'Press Enter in the message field to add a message to the queue.',
	queueImage: 'Queued message image',
	queueFile: 'Queued file {name}',
	queueEdit: 'Edit queued message',
	queueSave: 'Save queued message',
	queueCancel: 'Cancel edit',
	queueDelete: 'Delete queued message',
	queueSteer: 'Send into current task',
	queueSteerUnavailable: 'You can only send into a running task',
	queueSelectionUnavailable: 'Selection questions were retired. Remove this item from the queue.',
	queueSideChat: 'Ask in side chat',
	queueActionPending: 'An action on this message is in progress…',
	queueMessageChanged: 'This queued message has changed.',
	queueEditAttachment: 'Messages with non-text content cannot be edited yet',
	queueEditFailed: 'Could not edit. The message may have started sending.',
	queueDeleteFailed: 'Could not delete. The message may have started sending.',
	queueSteerFailed: 'Could not send into the current task. Try again.',
	queueResume: 'Continue queue',
	queueSendFailed: 'Could not save the message to the queue.',
	queueStartFailed: 'Could not start the next queued message. Try continuing the queue again.',
	sideChatBusy: 'Side chat is already answering. Try again when it finishes.',
	sideChatExternalFolder: 'Side chat can only receive individual files from outside the vault.',
	chatProcessSummary: 'Steps {messages} · Tool calls {tools}',
	chatActivitySummary: 'Turns {rounds} · Steps {messages}',
	chatSpeedValue: '{n} tok/s',
	chatActivityStats: 'Conversation activity',
	chatModelDuration: 'Model time',
	chatToolDuration: 'Tool time',
	chatFirstDelta: 'Average time to first token',
	chatSpeed: 'Output speed',
	chatMetricSeconds: '{s}s',
	chatMetricMinutes: '{m}m {s}s',
	chatSessionUsage: 'Conversation usage',
	chatRunUsage: 'Task usage',
	chatProviderModel: 'Provider / model',
	chatCacheHit: 'Cache hit',
	chatUncachedInput: 'Uncached input',
	chatCacheRead: 'Cache read',
	chatCacheWrite: 'Cache write',
	chatOutputTokens: 'Output',
	chatUsageRequests: 'Model requests',
	chatContextUsed: '{n}%',
	chatContextStats: 'Context {n}% used',
	chatContextCompaction: 'Context compression',
	chatContextCompacted: 'Compressed',
	chatCompactionReason: 'Latest compression reason',
	chatCompactionReasons: { budget: 'Input nearing the limit', overflow: 'Model reported too much input' },
	chatCompactionDroppedHistory: 'Earlier messages omitted',
	chatCompactionDroppedCurrent: 'Task messages omitted',
	chatCompactionShortenedTools: 'Tool results shortened',
	chatCompactionSummary: 'Summary status',
	chatCompactionSummaries: { none: 'None generated', saved: 'Generated and saved', reused: 'Reused', failed: 'Generation failed' },
	chatCompactionThrough: 'Task summary through',
	chatCompactionMessage: 'Message {n}',
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
	personalizationTab: '个性化',
	chatLocation: '聊天界面位置',
	chatLocationDescription: '新建聊天界面时的打开位置。关闭当前聊天视图后，改动在下次打开时生效。',
	customInstructions: '自定义指令',
	editInstructions: '编辑',
	instructionsPlaceholder: '添加自定义指令…',
	viewInstructionsSource: '查看源代码',
	unsavedInstructions: '离开前要保存修改吗？',
	discardInstructions: '放弃保存',
	continueEditing: '继续编辑',
	writingRuleSaved: '自定义指令已保存，下次提问生效。',
	writingRuleReadFailed: '无法读取 AGENTS.md。重新打开编辑器后再试。',
	writingRuleChanged: 'AGENTS.md 在编辑器外被修改。请复制你刚才的编辑，再重新打开编辑器查看新版。',
	rightSidebar: '右侧边栏',
	leftSidebar: '左侧边栏',
	editorTab: '编辑器标签页',
	modelsTab: '模型',
	advancedTab: '高级',
	diagnostics: '诊断日志',
	diagnosticsDescription: '最近的模型连接记录，不包含密钥和请求内容。',
	spillCleanupDays: '临时结果清理周期（天）',
	spillCleanupDaysDescription: '插件下次启动时删除早于该天数的私有临时结果文件；设为 0 可禁用清理。',
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
	includeProviderModels: '在聊天中启用此服务商的模型',
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
	modelProtocolUnknown: '协议未确认',
	modelProtocolAuto: '自动选择协议',
	modelProtocolAutomatic: '{protocol}（自动）',
	modelAddressUnknown: '填写此协议对应的 Base URL',
	modelAddressFromAuth: '由 Azure 连接配置决定',
	modelConnectionSources: {
		catalog: '使用模型目录中的连接信息。',
		compatible: '使用兼容连接，目录没有提供此模型的专属连接信息。',
		configured: '使用手动配置的连接。',
		unresolved: '连接未确认。',
	},
	modelConnectionIssues: {
		'unknown-provider': '找不到模型服务商。',
		'missing-protocol': '无法确认此模型的 API 协议，请选择协议。',
		'unsupported-protocol': '插件尚未接通此 API 协议，请重新选择。',
		'missing-address': '请填写此协议对应的 Base URL。',
		'invalid-address': '请输入有效的 HTTP 或 HTTPS Base URL。',
		'incompatible-address': 'Base URL 与所选协议或 OpenCode 套餐不匹配，请更正地址或清空以自动选择。',
	},
	baseUrlNone: '该服务商各模型地址不一致，没有统一的默认地址。',
	baseUrlRequired: '请先填写 Base URL',
	models: '模型',
	fetchModels: '获取模型',
	fetchModelsDescription: '从当前笔记库保存的模型数据中读取列表。',
	modelsFromProvider: '模型列表来自服务商',
	modelsFromPi: '模型列表来自 Pi',
	modelsFromBundled: '模型列表来自插件内置目录',
	modelsStale: '正在显示上次保存的列表',
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
	modelCapabilityLabels: { eye: '视觉', ear: '音频', video: '视频', 'file-text': 'PDF 输入', lightbulb: '推理', wrench: '工具', braces: '结构化输出' },
	capabilityStatus: { supported: '已确认支持', unsupported: '已确认不支持', unknown: '资料未确认', conflict: '资料来源有冲突',
		manual: '手动设置', jsonOnly: '目录声明支持 JSON，固定 JSON Schema 未确认。', videoUrl: '此连接接受 HTTPS 视频链接。' },
	capabilityReasoning: '推理/思考',
	capabilityTools: '工具调用',
	capabilityStructuredOutput: '结构化输出',
	capabilityConnectionUnsupported: '此连接暂不支持该能力。',
	capabilityStructured: '结构化输出',
	thinkingLevel: '推理档位',
	thinkingLevelNames: { off: '关闭', minimal: '极低', low: '轻度', medium: '中', high: '高', xhigh: '极高', max: '最高' },
	addThinkingLevel: '添加推理档位',
	removeThinkingLevel: '移除 {level}',
	customThinkingLevel: '输入自定义英文档位',
	invalidThinkingLevel: '请输入尚未添加的英文档位，可使用字母、数字、连字符或下划线。',
	chatChooseProvider: '选择服务商',
	chatVisionModel: '视觉',
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
	noModelsDiscovered: '已保存的列表里没有模型，可以在上方输入模型 ID。',
	loadingModels: '正在加载模型…',
	modelCatalogUnavailable: '这个连接还没有本地模型数据。可以先手动添加模型并保存，再到模型设置点击「更新模型数据」。',
	modelCatalogReadFailed: '无法读取本地模型数据。',
	back: '返回',
	modelConfiguration: '模型配置',
	defaults: '默认值',
	modelConfigSaveNote: '保存会更新当前模型和 Agent 运行限制。',
	invalidModelConfiguration: '请输入模型 ID 和有效的整数限制。',
	duplicateModelId: '列表中已存在这个模型 ID。',
	refreshModels: '更新模型数据',
	refreshModelsDescription: '从服务商目录、Pi 和 Models.dev 更新当前笔记库的模型数据。',
	refreshingModels: '正在更新模型数据…',
	modelsRefreshed: '模型数据已更新。',
	modelsRefreshPartial: '部分模型数据更新失败，已有资料仍可使用。',
	refreshModelsFailed: '无法更新模型数据。',
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
	chatContextLabel: '已添加的资料',
	chatAddContext: '添加参考资料',
	chatExecutionMode: '执行模式',
	chatModeAsk: '请求批准',
	chatModeAskDescription: '在笔记库内工作，额外权限由你批准。',
	chatModeAutoReview: '帮我批准',
	chatModeAutoReviewDescription: '需要额外权限时，将请求详情发给当前模型单独审核。',
	chatModeFullAccess: '完全访问',
	chatModeFullAccessDescription: '可访问库外文件并联网，无需逐项批准。',
	chatModeFullAccessConfirm: '启用完全访问',
	chatModeFullAccessDisclosure: 'Scribe Ai 可以读写你的电脑账户有权访问的文件，包括库外文件，也可以直接运行命令和联网。当前聊天会保存此模式，新开的聊天和标签页会沿用它。',
	chatModeLocked: '当前任务和队列结束后可切换模式。',
	chatPickVaultItem: '选择库内文件或文件夹',
	chatSearchReferences: '搜索文件、文件夹或历史对话',
	chatNoReferences: '没有匹配的参考资料',
	chatNoReferenceText: '这段对话没有可引用的文字。',
	chatSelectionPreview: '选区预览',
	chatRemoveQuotes: '移除引文',
	chatAddSelection: '添加到对话',
	chatQuotedText: '{n} 个已选文本片段',
	chatAddExternalPath: '库外路径',
	chatPickExternalFile: '选择库外文件',
	chatPickExternalFolder: '选择库外文件夹',
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
	chatArchiveConversation: '归档对话',
	chatUnarchiveConversation: '取消归档',
	chatArchived: '已归档',
	chatNoArchivedConversations: '暂无已归档的对话',
	chatArchiveBusy: '请先处理这段对话中正在运行的任务和排队消息。',
	chatArchiveUnsaved: '这段对话没有可归档的消息。',
	chatArchiveError: '无法更新对话的归档状态。',
	chatDeleteConversation: '删除对话',
	chatDeleteConfirm: '永久删除「{title}」及其全部消息？删除后无法撤销。如果开着这段对话的侧聊，它也会关闭，未发送的侧聊草稿将丢失。',
	chatRenameError: '无法保存对话标题。',
	chatDeleteError: '无法删除对话。',
	chatNewTab: '新建标签页',
	chatTabs: '对话标签页',
	chatCloseTab: '关闭标签页',
	chatMoreTabs: '更多标签页',
	chatTabRunning: '正在运行',
	chatTabAttention: '需要处理',
	chatTabError: '任务失败',
	chatUntitled: '未命名对话',
	chatLoadingHistory: '正在加载对话…',
	chatNoSavedConversations: '暂无已保存的对话',
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
	chatStopped: '已停止',
	chatFailed: '任务失败',
	chatRunLimit: '任务已触发运行限制',
	chatTurn: '轮次',
	chatYou: '你',
	chatAssistant: '助手',
	chatSubagentReport: '任务结果',
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
	chatTimelineAutoReview: 'AI 审核中',
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
	chatWorkingThinking: '正在思考…',
	chatWorkingSeconds: '{s}秒',
	chatWorkingMinutes: '{m}分{s}秒',
	chatWorkingHours: '{h}时{m}分{s}秒',
	chatCopyReply: '复制回复',
	chatCitationUnavailable: '无法打开这篇来源笔记。',
	chatCopiedReply: '已复制回复',
	chatCopyFailed: '无法复制回复',
	chatToolArguments: '调用参数',
	chatToolOutput: '工具输出',
	chatSkillLoaded: '已加载技能 {name}',
	chatSkillResourceRead: '已读取技能资料（{name}）',
	chatSkillReading: '正在读取技能…',
	chatSkillFailed: '读取技能失败',
	chatSkillContent: '技能内容',
	chatSkillResource: '技能资料',
	chatSkillTask: '任务描述',
	chatSkillNoTask: '本次未提供任务描述。',
	chatSkillUnavailable: '无法恢复当时读取的技能内容。',
	chatSkillUnknown: '未知技能',
	chatShellRecentOutput: '最近输出',
	chatShellRecentErrors: '最近错误输出',
	chatBackgroundJobs: '后台任务',
	chatBackgroundRunning: '运行中',
	chatBackgroundStopping: '正在停止',
	chatBackgroundCountOne: '{count} 个后台任务',
	chatBackgroundCountOther: '{count} 个后台任务',
	chatBackgroundSectionLive: '进行中',
	chatBackgroundSettledCount: '已结束 {count}',
	chatBackgroundClear: '清空',
	chatBackgroundExpand: '展开 {label} 的实时输出',
	chatBackgroundCollapse: '收起 {label} 的实时输出',
	chatBackgroundStop: '停止任务 {label}',
	chatBackgroundConfirm: '再次点击确认停止',
	chatBackgroundConfirmAction: '确认停止',
	chatBackgroundStopFailed: '无法停止后台任务。',
	chatBackgroundStopFailedLabel: '停止失败',
	chatBackgroundExitCode: '退出码 {code}',
	chatBackgroundDurationSeconds: '{seconds}秒',
	chatBackgroundDurationMinutes: '{minutes}分{seconds}秒',
	chatBackgroundDurationHours: '{hours}小时{minutes}分',
	chatBackgroundDurationLive: '已运行 {duration}',
	chatBackgroundDurationDone: '耗时 {duration}',
	chatBackgroundNoOutput: '（无输出）',
	chatBackgroundOutput: '输出',
	chatBackgroundLoadFailed: '无法读取已保存的后台任务。',
	chatBackgroundSaveFailed: '这项后台任务的结果未能保存。',
	chatBackgroundReadSaveFailed: '未能记下已读状态。',
	chatBackgroundApproval: '此命令将在后台运行。你可以按任务编号查看输出或停止任务。',
	chatToolSkipped: '已跳过',
	chatShellNotApproved: '未执行（未批准）',
	chatShellNotRun: '未执行',
	chatShellReview: { approved: 'AI 审核通过', denied: 'AI 审核未批准', incomplete: 'AI 审核未完成' },
	chatShellStatus: { success: '成功', failed: '失败', 'timed-out': '超时', stopped: '手动停止', 'start-failed': '启动失败' },
	chatToolNoChanges: '请求替换的内容没有差别',
	chatToolMoreText: '查看已记录的全文',
	chatToolLessText: '收起全文',
	chatApprovalHeading: '等待确认',
	chatApprovalCreate: '创建文件',
	chatApprovalEdit: '修改文件',
	chatApprovalAccess: '访问库外资料',
	chatApprovalPathDisclosure: '允许后，只能在本次操作中访问这个位置。',
	chatWorkingFolder: '工作目录',
	chatShellDisclosure: '确认后，命令可按你的电脑账户权限读取和写入库外文件，也可联网。工作目录只决定命令从哪里开始运行。',
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
	sideChatOpen: '打开侧聊',
	sideChatTitle: '侧聊',
	sideChatAskSelection: '在侧聊中提问',
	sideChatClose: '关闭侧聊',
	sideChatPlaceholder: '输入侧聊问题',
	sideChatOpenFailed: '无法在右侧边栏打开侧聊。',
	queueCount: '{n} 条排队消息',
	queueSending: '发送中…',
	queueEnterHint: '在输入框按 Enter 可将消息加入队列。',
	queueImage: '排队消息图片',
	queueFile: '排队文件 {name}',
	queueEdit: '编辑排队消息',
	queueSave: '保存排队消息',
	queueCancel: '取消编辑',
	queueDelete: '删除排队消息',
	queueSteer: '插话发送',
	queueSteerUnavailable: '仅运行中可插话发送',
	queueSelectionUnavailable: '选区问答已停用，请移出队列。',
	queueSideChat: '在侧聊提问',
	queueActionPending: '这条消息的操作正在处理…',
	queueMessageChanged: '这条排队消息已变更。',
	queueEditAttachment: '包含非文本内容，暂不支持编辑',
	queueEditFailed: '编辑失败：这条消息可能已经开始发送。',
	queueDeleteFailed: '删除失败：这条消息可能已经开始发送。',
	queueSteerFailed: '插话发送失败，请重试。',
	queueResume: '继续队列',
	queueSendFailed: '无法保存排队消息。',
	queueStartFailed: '无法开始下一条排队消息，请重新继续队列。',
	sideChatBusy: '侧聊正在回答，请等它答完后再试。',
	sideChatExternalFolder: '侧聊一次只能读取手动附上的库外文件，无法转交库外文件夹。',
	chatProcessSummary: '{messages} 步 · {tools} 次工具调用',
	chatActivitySummary: '{rounds} 轮 · {messages} 步',
	chatSpeedValue: '{n} tok/秒',
	chatActivityStats: '会话活动',
	chatModelDuration: '大模型耗时',
	chatToolDuration: '工具耗时',
	chatFirstDelta: '平均首字延迟',
	chatSpeed: '输出速度',
	chatMetricSeconds: '{s} 秒',
	chatMetricMinutes: '{m} 分 {s} 秒',
	chatSessionUsage: '会话用量',
	chatRunUsage: '本次任务用量',
	chatProviderModel: '提供方 / 模型',
	chatCacheHit: '缓存命中',
	chatUncachedInput: '未命中输入',
	chatCacheRead: '缓存读取',
	chatCacheWrite: '缓存写入',
	chatOutputTokens: '输出',
	chatUsageRequests: '模型请求次数',
	chatContextUsed: '{n}%',
	chatContextStats: '上下文已用 {n}%',
	chatContextCompaction: '上下文压缩',
	chatContextCompacted: '已压缩',
	chatCompactionReason: '最近一次压缩的原因',
	chatCompactionReasons: { budget: '发送内容接近上限', overflow: '模型报告发送内容超出上限' },
	chatCompactionDroppedHistory: '省略的历史消息',
	chatCompactionDroppedCurrent: '省略的任务内消息',
	chatCompactionShortenedTools: '缩短的工具结果',
	chatCompactionSummary: '摘要状态',
	chatCompactionSummaries: { none: '未生成', saved: '已生成并保存', reused: '已复用', failed: '生成失败' },
	chatCompactionThrough: '任务摘要覆盖到',
	chatCompactionMessage: '第 {n} 条记录',
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
	personalizationTab: '個人化',
	chatLocation: '聊天介面位置',
	chatLocationDescription: '新建聊天介面時的開啟位置。關閉目前聊天檢視後，變更在下次開啟時生效。',
	customInstructions: '自訂指令',
	editInstructions: '編輯',
	instructionsPlaceholder: '新增自訂指令…',
	viewInstructionsSource: '查看原始碼',
	unsavedInstructions: '離開前要儲存變更嗎？',
	discardInstructions: '捨棄變更',
	continueEditing: '繼續編輯',
	writingRuleSaved: '自訂指令已儲存，下次提問生效。',
	writingRuleReadFailed: '無法讀取 AGENTS.md。重新開啟編輯器後再試。',
	writingRuleChanged: 'AGENTS.md 在編輯器外被修改。請複製剛才的編輯，再重新開啟編輯器查看新版。',
	rightSidebar: '右側邊欄',
	leftSidebar: '左側邊欄',
	editorTab: '編輯器分頁',
	modelsTab: '模型',
	advancedTab: '進階',
	diagnostics: '診斷日誌',
	diagnosticsDescription: '最近的模型連線記錄，不包含金鑰和請求內容。',
	spillCleanupDays: '暫存結果清理週期（天）',
	spillCleanupDaysDescription: '此外掛下次啟動時刪除早於該天數的私有暫存結果檔案；設為 0 可停用清理。',
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
	includeProviderModels: '在聊天中啟用此服務商的模型',
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
	modelProtocolUnknown: '協定未確認',
	modelProtocolAuto: '自動選擇協定',
	modelProtocolAutomatic: '{protocol}（自動）',
	modelAddressUnknown: '填寫此協定對應的 Base URL',
	modelAddressFromAuth: '由 Azure 連線設定決定',
	modelConnectionSources: {
		catalog: '使用模型目錄中的連線資訊。',
		compatible: '使用相容連線，目錄沒有提供此模型的專屬連線資訊。',
		configured: '使用手動設定的連線。',
		unresolved: '連線未確認。',
	},
	modelConnectionIssues: {
		'unknown-provider': '找不到模型服務商。',
		'missing-protocol': '無法確認此模型的 API 協定，請選擇協定。',
		'unsupported-protocol': '外掛尚未接通此 API 協定，請重新選擇。',
		'missing-address': '請填寫此協定對應的 Base URL。',
		'invalid-address': '請輸入有效的 HTTP 或 HTTPS Base URL。',
		'incompatible-address': 'Base URL 與所選協定或 OpenCode 方案不符，請更正網址或清空以自動選擇。',
	},
	baseUrlNone: '該服務商各模型地址不一致，沒有統一的預設地址。',
	baseUrlRequired: '請先填寫 Base URL',
	models: '模型',
	fetchModels: '取得模型',
	fetchModelsDescription: '從目前筆記庫已儲存的模型資料讀取清單。',
	modelsFromProvider: '模型清單來自服務商',
	modelsFromPi: '模型清單來自 Pi',
	modelsFromBundled: '模型清單來自外掛內建目錄',
	modelsStale: '正在顯示上次儲存的清單',
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
	modelCapabilityLabels: { eye: '視覺', ear: '音訊', video: '影片', 'file-text': 'PDF 輸入', lightbulb: '推理', wrench: '工具', braces: '結構化輸出' },
	capabilityStatus: { supported: '已確認支援', unsupported: '已確認不支援', unknown: '資料未確認', conflict: '資料來源有衝突',
		manual: '手動設定', jsonOnly: '目錄聲明支援 JSON，固定 JSON Schema 尚未確認。', videoUrl: '此連線接受 HTTPS 影片連結。' },
	capabilityReasoning: '推理/思考',
	capabilityTools: '工具調用',
	capabilityStructuredOutput: '結構化輸出',
	capabilityConnectionUnsupported: '此連線暫不支援這項能力。',
	capabilityStructured: '結構化輸出',
	thinkingLevel: '推理檔位',
	thinkingLevelNames: { off: '關閉', minimal: '極低', low: '輕度', medium: '中', high: '高', xhigh: '極高', max: '最高' },
	addThinkingLevel: '新增推理檔位',
	removeThinkingLevel: '移除 {level}',
	customThinkingLevel: '輸入自訂英文檔位',
	invalidThinkingLevel: '請輸入尚未新增的英文檔位，可使用字母、數字、連字號或底線。',
	chatChooseProvider: '選擇服務商',
	chatVisionModel: '視覺',
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
	noModelsDiscovered: '已儲存的清單裡沒有模型，可在上方輸入模型 ID。',
	loadingModels: '正在載入模型…',
	modelCatalogUnavailable: '這個連線還沒有本機模型資料。可先手動新增模型並儲存，再到模型設定選取「更新模型資料」。',
	modelCatalogReadFailed: '無法讀取本機模型資料。',
	back: '返回',
	modelConfiguration: '模型設定',
	defaults: '預設值',
	modelConfigSaveNote: '儲存會更新目前模型和 Agent 執行限制。',
	invalidModelConfiguration: '請輸入模型 ID 和有效的整數限制。',
	duplicateModelId: '清單中已存在這個模型 ID。',
	refreshModels: '更新模型資料',
	refreshModelsDescription: '從服務商目錄、Pi 和 Models.dev 更新目前筆記庫的模型資料。',
	refreshingModels: '正在更新模型資料…',
	modelsRefreshed: '模型資料已更新。',
	modelsRefreshPartial: '部分模型資料更新失敗，既有資料仍可使用。',
	refreshModelsFailed: '無法更新模型資料。',
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
	chatContextLabel: '已加入的資料',
	chatAddContext: '加入參考資料',
	chatExecutionMode: '執行模式',
	chatModeAsk: '請求批准',
	chatModeAskDescription: '在筆記庫內工作，額外權限由你批准。',
	chatModeAutoReview: '幫我批准',
	chatModeAutoReviewDescription: '需要額外權限時，將請求詳情傳給目前的模型單獨審核。',
	chatModeFullAccess: '完全存取',
	chatModeFullAccessDescription: '可存取庫外檔案並連網，無需逐項批准。',
	chatModeFullAccessConfirm: '啟用完全存取',
	chatModeFullAccessDisclosure: 'Scribe Ai 可以讀寫你的電腦帳戶有權存取的檔案，包括庫外檔案，也可以直接執行指令及連網。目前對話會儲存此模式，新開的對話和分頁會沿用它。',
	chatModeLocked: '目前任務及佇列結束後可切換模式。',
	chatPickVaultItem: '選擇庫內檔案或資料夾',
	chatSearchReferences: '搜尋檔案、資料夾或歷史對話',
	chatNoReferences: '沒有符合的參考資料',
	chatNoReferenceText: '這段對話沒有可引用的文字。',
	chatSelectionPreview: '選取文字預覽',
	chatRemoveQuotes: '移除引文',
	chatAddSelection: '新增至對話',
	chatQuotedText: '{n} 個已選文字片段',
	chatAddExternalPath: '庫外路徑',
	chatPickExternalFile: '選擇庫外檔案',
	chatPickExternalFolder: '選擇庫外資料夾',
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
	chatArchiveConversation: '封存對話',
	chatUnarchiveConversation: '取消封存',
	chatArchived: '已封存',
	chatNoArchivedConversations: '暫無已封存的對話',
	chatArchiveBusy: '請先處理這段對話中正在執行的工作和排隊訊息。',
	chatArchiveUnsaved: '這段對話沒有可封存的訊息。',
	chatArchiveError: '無法更新對話的封存狀態。',
	chatDeleteConversation: '刪除對話',
	chatDeleteConfirm: '永久刪除「{title}」及其全部訊息？刪除後無法復原。如果開著這段對話的側聊，它也會關閉，未送出的側聊草稿將遺失。',
	chatRenameError: '無法儲存對話標題。',
	chatDeleteError: '無法刪除對話。',
	chatNewTab: '新建分頁',
	chatTabs: '對話分頁',
	chatCloseTab: '關閉分頁',
	chatMoreTabs: '更多分頁',
	chatTabRunning: '執行中',
	chatTabAttention: '需要處理',
	chatTabError: '工作失敗',
	chatUntitled: '未命名對話',
	chatLoadingHistory: '正在載入對話…',
	chatNoSavedConversations: '暫無已儲存的對話',
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
	chatStopped: '已停止',
	chatFailed: '任務失敗',
	chatRunLimit: '任務已觸發執行限制',
	chatTurn: '輪次',
	chatYou: '你',
	chatAssistant: '助理',
	chatSubagentReport: '任務結果',
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
	chatTimelineAutoReview: 'AI 審核中',
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
	chatWorkingThinking: '正在思考…',
	chatWorkingSeconds: '{s}秒',
	chatWorkingMinutes: '{m}分{s}秒',
	chatWorkingHours: '{h}時{m}分{s}秒',
	chatCopyReply: '複製回覆',
	chatCitationUnavailable: '無法開啟這篇來源筆記。',
	chatCopiedReply: '已複製回覆',
	chatCopyFailed: '無法複製回覆',
	chatToolArguments: '呼叫參數',
	chatToolOutput: '工具輸出',
	chatSkillLoaded: '已載入技能 {name}',
	chatSkillResourceRead: '已讀取技能資料（{name}）',
	chatSkillReading: '正在讀取技能…',
	chatSkillFailed: '讀取技能失敗',
	chatSkillContent: '技能內容',
	chatSkillResource: '技能資料',
	chatSkillTask: '任務描述',
	chatSkillNoTask: '本次未提供任務描述。',
	chatSkillUnavailable: '無法還原當時讀取的技能內容。',
	chatSkillUnknown: '未知技能',
	chatShellRecentOutput: '最近輸出',
	chatShellRecentErrors: '最近錯誤輸出',
	chatBackgroundJobs: '背景任務',
	chatBackgroundRunning: '執行中',
	chatBackgroundStopping: '正在停止',
	chatBackgroundCountOne: '{count} 個背景任務',
	chatBackgroundCountOther: '{count} 個背景任務',
	chatBackgroundSectionLive: '進行中',
	chatBackgroundSettledCount: '已結束 {count}',
	chatBackgroundClear: '清空',
	chatBackgroundExpand: '展開 {label} 的即時輸出',
	chatBackgroundCollapse: '收起 {label} 的即時輸出',
	chatBackgroundStop: '停止任務 {label}',
	chatBackgroundConfirm: '再次點擊確認停止',
	chatBackgroundConfirmAction: '確認停止',
	chatBackgroundStopFailed: '無法停止背景任務。',
	chatBackgroundStopFailedLabel: '停止失敗',
	chatBackgroundExitCode: '退出碼 {code}',
	chatBackgroundDurationSeconds: '{seconds}秒',
	chatBackgroundDurationMinutes: '{minutes}分{seconds}秒',
	chatBackgroundDurationHours: '{hours}小時{minutes}分',
	chatBackgroundDurationLive: '已執行 {duration}',
	chatBackgroundDurationDone: '耗時 {duration}',
	chatBackgroundNoOutput: '（無輸出）',
	chatBackgroundOutput: '輸出',
	chatBackgroundLoadFailed: '無法讀取已儲存的背景任務。',
	chatBackgroundSaveFailed: '這項背景任務的結果未能儲存。',
	chatBackgroundReadSaveFailed: '未能記下已讀狀態。',
	chatBackgroundApproval: '此命令將在背景執行。你可以按任務編號查看輸出或停止任務。',
	chatToolSkipped: '已跳過',
	chatShellNotApproved: '未執行（未批准）',
	chatShellNotRun: '未執行',
	chatShellReview: { approved: 'AI 審核通過', denied: 'AI 審核未批准', incomplete: 'AI 審核未完成' },
	chatShellStatus: { success: '成功', failed: '失敗', 'timed-out': '逾時', stopped: '手動停止', 'start-failed': '啟動失敗' },
	chatToolNoChanges: '請求取代的內容沒有差別',
	chatToolMoreText: '查看已記錄的全文',
	chatToolLessText: '收起全文',
	chatApprovalHeading: '等待確認',
	chatApprovalCreate: '建立檔案',
	chatApprovalEdit: '修改檔案',
	chatApprovalAccess: '存取庫外資料',
	chatApprovalPathDisclosure: '允許後，只能在這次操作中存取這個位置。',
	chatWorkingFolder: '工作目錄',
	chatShellDisclosure: '確認後，命令可依你的電腦帳戶權限讀取和寫入庫外檔案，也可連網。工作目錄只決定命令從哪裡開始執行。',
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
	sideChatOpen: '開啟側聊',
	sideChatTitle: '側聊',
	sideChatAskSelection: '在側聊中提問',
	sideChatClose: '關閉側聊',
	sideChatPlaceholder: '輸入側聊問題',
	sideChatOpenFailed: '無法在右側邊欄開啟側聊。',
	queueCount: '{n} 則排隊訊息',
	queueSending: '傳送中…',
	queueEnterHint: '在輸入框按 Enter 可將訊息加入佇列。',
	queueImage: '排隊訊息圖片',
	queueFile: '排隊檔案 {name}',
	queueEdit: '編輯排隊訊息',
	queueSave: '儲存排隊訊息',
	queueCancel: '取消編輯',
	queueDelete: '刪除排隊訊息',
	queueSteer: '插話傳送',
	queueSteerUnavailable: '僅執行中可插話傳送',
	queueSelectionUnavailable: '選取文字問答已停用，請移出佇列。',
	queueSideChat: '在側聊提問',
	queueActionPending: '這則訊息的操作正在處理…',
	queueMessageChanged: '這則排隊訊息已變更。',
	queueEditAttachment: '包含非文字內容，暫不支援編輯',
	queueEditFailed: '編輯失敗：這則訊息可能已經開始傳送。',
	queueDeleteFailed: '刪除失敗：這則訊息可能已經開始傳送。',
	queueSteerFailed: '插話傳送失敗，請重試。',
	queueResume: '繼續佇列',
	queueSendFailed: '無法儲存排隊訊息。',
	queueStartFailed: '無法開始下一則排隊訊息，請重新繼續佇列。',
	sideChatBusy: '側聊正在回答，請等它答完後再試。',
	sideChatExternalFolder: '側聊一次只能讀取手動附上的庫外檔案，無法轉交庫外資料夾。',
	chatProcessSummary: '{messages} 步 · {tools} 次工具呼叫',
	chatActivitySummary: '{rounds} 輪 · {messages} 步',
	chatSpeedValue: '{n} tok/秒',
	chatActivityStats: '對話活動',
	chatModelDuration: '模型耗時',
	chatToolDuration: '工具耗時',
	chatFirstDelta: '平均首字延遲',
	chatSpeed: '輸出速度',
	chatMetricSeconds: '{s} 秒',
	chatMetricMinutes: '{m} 分 {s} 秒',
	chatSessionUsage: '對話用量',
	chatRunUsage: '本次任務用量',
	chatProviderModel: '服務商／模型',
	chatCacheHit: '快取命中',
	chatUncachedInput: '未命中輸入',
	chatCacheRead: '快取讀取',
	chatCacheWrite: '快取寫入',
	chatOutputTokens: '輸出',
	chatUsageRequests: '模型請求次數',
	chatContextUsed: '{n}%',
	chatContextStats: '上下文已用 {n}%',
	chatContextCompaction: '上下文壓縮',
	chatContextCompacted: '已壓縮',
	chatCompactionReason: '最近一次壓縮的原因',
	chatCompactionReasons: { budget: '傳送內容接近上限', overflow: '模型回報傳送內容超出上限' },
	chatCompactionDroppedHistory: '省略的歷史訊息',
	chatCompactionDroppedCurrent: '省略的任務內訊息',
	chatCompactionShortenedTools: '縮短的工具結果',
	chatCompactionSummary: '摘要狀態',
	chatCompactionSummaries: { none: '未產生', saved: '已產生並儲存', reused: '已重複使用', failed: '產生失敗' },
	chatCompactionThrough: '任務摘要涵蓋到',
	chatCompactionMessage: '第 {n} 則紀錄',
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

export function thinkingLabel(text: UiText, level: string): string {
	return isBuiltInThinkingLevel(level) ? text.thinkingLevelNames[level] : level;
}
