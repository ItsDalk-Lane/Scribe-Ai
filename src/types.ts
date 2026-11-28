import type {
	AssistantMessage,
	AssistantMessageEvent,
	AuthInteraction,
	Credential,
	CredentialStore as PiCredentialStore,
	ImageContent,
	LoginOptions,
	ThinkingLevel,
	Usage,
} from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import type { ChatGoal } from './interaction/chatGoal';
import type { McpManager } from './tools/external/mcp';
import type { McpSettings } from './tools/external/mcpConfig';
import type { McpRun } from './tools/external/mcpTools';
import type { WebSearchService } from './tools/external/webTools';
import type { WebSearchSettings } from './tools/external/webSearchSettings';
import type { ShellJobHistory, ShellJobs } from './tools/external/shellJobs';
import type { ChatTask, ChatTaskBatch, ChatTaskCreate, ChatTaskEvent, ChatTaskStore, ChatTaskUpdate } from './orchestration/storage/chatTasks';

/** 占位骨架期各层尚未实现的统一信号 */
export class NotImplementedError extends Error {
	constructor(feature: string) {
		super(`scribe-ai: ${feature} 尚未实现`);
	}
}

/** 占位实现：函数体异常退出，保证类型契约可用而行为明确为空 */
export function notImplemented(feature: string): never {
	throw new NotImplementedError(feature);
}

/* ───────────── 对话与任务 ───────────── */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

type ThinkingBlock = Extract<AssistantMessage['content'][number], { type: 'thinking' }> & { durationMs?: number };
type AssistantRecord = Omit<AssistantMessage, 'content'> & {
	content: (Exclude<AssistantMessage['content'][number], { type: 'thinking' }> | ThinkingBlock)[];
};

export interface ModelMetrics {
	endedAt: number;
	modelMs: number;
	firstDeltaMs?: number;
	decodeMs?: number;
	contextWindow?: number;
}

export interface ReportedUsage {
	prompt?: number;
	videoInput?: number;
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
	total?: number;
}

export interface ModelUsageReceipt {
	reportedUsage?: ReportedUsage;
	estimatedUsage?: Pick<ReportedUsage, 'prompt' | 'output' | 'total'>;
	cost?: number;
	/** 最新累计用量是否已由服务端的收尾回执确认。 */
	usageStatus?: 'provisional' | 'final';
}

export interface AuxiliaryUsage extends ModelUsageReceipt {
	kind: 'review' | 'goal-review' | 'summary' | 'video' | 'main-attempt';
	/** 实时预览与保存回执共用同一次实际请求的标识。 */
	id?: string;
}

export interface Message {
	/** 只由发送层生成，原始消息记录不使用此字段。 */
	promptSections?: import('./orchestration/context/promptXml').PromptSection[];
	/** 原始内容各段的长度，用于在发送时区分指令、所选资料与聊天引文。 */
	taskPrompt?: { instruction: number; references: number; quotes: number; assignment?: true; approvedPlan?: [number, number] };
	imageRefs?: ImageReference[];
	skillInputLength?: number;
	skillMentions?: SkillMention[];
	skillScope?: string[];
	skillNotePaths?: string[];
	role: MessageRole;
	content: string;
	/** 应用生成的回复，只在聊天中显示，不计入模型用量。 */
	local?: true;
	/** 收件确认中按原题顺序保存等待回传的子任务。 */
	deliveryAgents?: string[];
	/** 保存协作消息在收到时的聊天位置。 */
	subagentActivity?: {
		id: string;
		agentId: string;
		agentName: string;
		kind: 'result' | 'instruction' | 'question';
	};
	/** 用于将流式更新与保存后的同一回复关联起来。 */
	id?: string;
	/** 原始响应无法保留时，记录时间线上已显示的思考和正文位置。 */
	thinkingBlocks?: (ThinkingBlock & { contentIndex: number })[];
	textIndex?: number;
	/** role 为 tool 时对应的工具调用 id */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	skipped?: boolean;
	incomplete?: true;
	truncated?: true;
	metrics?: ModelMetrics;
	usage?: Usage;
	/** 仅保留服务商确实报告的用量。空对象表示未报告。 */
	reportedUsage?: ReportedUsage;
	estimatedUsage?: ModelUsageReceipt['estimatedUsage'];
	usageStatus?: ModelUsageReceipt['usageStatus'];
	toolDurationMs?: number;
	shellStatus?: ShellStatus;
	approvalReview?: ToolReviewStatus;
	noteChange?: NoteChange;
	/** assistant 消息中由模型发起的工具调用 */
	toolCalls?: ToolCall[];
	/** 本次请求向模型提供了结构化目标报告工具。 */
	goalReportRequired?: true;
	/** 保留同一模型继续当前任务时所需的原始内容和签名 */
	rawAssistant?: AssistantRecord;
}

export interface NoteRef {
	path: string;
	kind?: 'file' | 'folder';
	pastedImage?: true;
	/** 本次任务显式提交的库外资料，用于恢复任务时校验授权来源。 */
	addedExternal?: true;
	/** 选区起止行，缺省表示整篇笔记 */
	lines?: [number, number];
}

export interface NoteSelection {
	path: string;
	title: string;
	text: string;
	lines: [number, number];
}

export interface SkillMention {
	sourceLabel?: string;
	id: string;
	name: string;
	start: number;
	end: number;
}

export interface SkillSettings {
	sharedDirectories: string[];
	disabledIds: string[];
	catalogBudgetPercent: number;
	catalogBudgetMaxTokens: number;
}

export interface TaskTarget {
	kind: 'mcp' | 'agent';
	id: string;
	label: string;
}

export interface TaskRequest {
	imageSourcePath?: string;
	/** Limit image link extraction to the user's portion of a generated request. */
	imageLinkEnd?: number;
	target?: TaskTarget;
	intent?: 'plan' | 'review';
	approvedPlanTaskId?: string;
	approvedPlanMode?: 'continue' | 'fresh';
	approvedPlanRevision?: string;
	revisesPlanTaskId?: string;
	reviewMaterial?: string;
	goalRound?: true;
	goalContext?: string;
	/** 子助手按名称和来源继承已投递的用户选择。 */
	inheritedSkills?: Pick<SkillMention, 'name' | 'id'>[];
	/** 兼容只记录了来源的旧任务。 */
	inheritedSkillIds?: string[];
	skillMentions?: SkillMention[];
	skillScope?: string[];
	/** 本次请求选定的库内笔记或文件夹，文件夹以 / 结尾。 */
	skillNotePaths?: string[];
	conversationId: string;
	instruction: string;
	refs: NoteRef[];
	/** 仅用于读取旧版选区问答记录。 */
	selection?: NoteSelection;
	chatQuotes?: string[];
	/** 子任务审核使用真实用户指令，派工文字只作为上下文。 */
	approvalSource?: string;
	/** 本次分派或返工所属的上级任务。 */
	subagentCallerTaskId?: string;
}

export interface QueuedMessage {
	id: string;
	request: TaskRequest;
	destination?: QueuedModelDestination;
}

export interface QueuedModelDestination {
	providerId: string;
	model: string;
	baseUrl: string;
	api: string;
	fingerprint: string;
}

export type TaskStatus =
	| 'pending'
	| 'running'
	| 'awaiting-user'
	| 'done'
	| 'file-changes-done'
	| 'partial'
	| 'failed'
	| 'limit'
	| 'interrupted'
	| 'cancelled';

export interface Task {
	id: string;
	request: TaskRequest;
	status: TaskStatus;
	parentId?: string;
	createdAt: number;
	updatedAt: number;
}

/* ───────────── 工具 ───────────── */

export interface ToolSpec {
	name: string;
	description: string;
	/** JSON Schema 形式的入参描述 */
	inputSchema: Record<string, unknown>;
}

export interface ToolCall {
	id: string;
	label?: string;
	name: string;
	input: unknown;
}

export const TOOL_NOT_APPROVED = '用户未批准本次操作。';

export type ToolReviewStatus = 'approved' | 'denied' | 'incomplete';
export class ToolReviewDeniedError extends Error {}

export type NoteChange = { path: string } & ({ before?: string; after: string } | { omitted: true });

export interface ToolResult {
	callId: string;
	content: string;
	isError: boolean;
	durationMs?: number;
	fileRead?: FileReadPage;
	shellStatus?: ShellStatus;
	approvalReview?: ToolReviewStatus;
	noteChange?: NoteChange;
	imageRefs?: ImageReference[];
}

export type ShellStatus = 'success' | 'failed' | 'timed-out' | 'stopped' | 'start-failed';

export interface ShellOutputPreview {
	stdout: string;
	stderr: string;
}

export interface FileReadPage {
	path: string;
	fingerprint: string;
	/** 零起点，end 不含。 */
	start: number;
	end: number;
	lineCount: number;
}

export interface ReadDelivery {
	remember(message: Message, page: FileReadPage): void;
	accept(messages: Message[]): void;
	hasFullRead(path: string, fingerprint: string): boolean;
}

export interface RunChatTasks {
	list(): Promise<ChatTaskBatch[]>;
	get(id: string): Promise<ChatTask>;
	create(input: ChatTaskCreate): Promise<ChatTask>;
	update(input: ChatTaskUpdate): Promise<ChatTask>;
}

export interface ToolContext {
	memory?: RunContext['memory'];
	goalReport?: RunContext['goalReport'];
	chatTasks?: RunChatTasks;
	plan?: import('./tools/planTools').RunPlanTools;
	mcpRun?: McpRun;
	skillRun?: SkillRun;
	subagents?: SubagentToolAccess;
	subagentId?: string;
	task: Task;
	app: App;
	signal: AbortSignal;
	permissions: PermissionPolicy;
	readFiles: Map<string, string>;
	readDelivery: ReadDelivery;
	cwd: string;
	approve?: (approval: ToolApproval, identity?: string) => Promise<boolean>;
	retryApproval?: { approval: ToolApproval; identity: string };
	onShellOutput?: (output: ShellOutputPreview) => void;
}

export interface ToolApproval {
	title: string;
	target: string;
	intent?: string;
	before?: string;
	after?: string;
	kind?: 'shell' | 'vault-shell' | 'access' | 'mcp' | 'web-search' | 'web-image';
	reason?: string;
	background?: true;
	humanRequired?: true;
}

export interface ImageToolOutput {
	content: string;
	isError?: boolean;
	images?: ImageContent[];
}

export interface PreparedTool {
	approval?: ToolApproval;
	approvalIdentity?: string;
	independent?: true;
	run(): Promise<string | { content: string; fileRead: FileReadPage } | { content: string; shellStatus: ShellStatus } | { content: string; noteChange: NoteChange } | ImageToolOutput> | string;
}

export interface ToolDefinition extends ToolSpec {
	mcp?: { kind: 'tool' | 'resource' | 'search' | 'invoke'; binding: string; label: string };
	isReadOnly: boolean;
	maxResultSizeChars?: number;
	isAvailable?(): boolean;
	prepare(input: unknown, ctx: ToolContext): Promise<PreparedTool> | PreparedTool;
}

/* ───────────── 模型 ───────────── */

export interface ModelRequest {
	beforeSend?: (address: string, destinationFingerprint?: string) => Promise<void>;
	/** 地址及授权检查通过，即将向模型发出网络请求。 */
	onTransmission?: (address: string) => Promise<void>;
	providerId: string;
	model: string;
	system?: string;
	messages: Message[];
	tools: ToolSpec[];
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
	/** null 固定为不请求推理档位，缺省兼容旧请求的默认行为。 */
	reasoning?: string | null;
	sessionId?: string;
	maxRetries?: number;
	/** 本次请求的最终答复需要遵循的 JSON Schema。 */
	responseSchema?: Record<string, unknown>;
	/** Explicitly attached to a user message. Binary data is loaded for this request only. */
	video?: { messageIndex: number; hasFiles: boolean; load: (signal: AbortSignal) => Promise<ModelVideo[]> };
	images?: {
		required: boolean;
		references: ReadonlyMap<number, readonly ImageReference[]>;
		load: (signal: AbortSignal) => Promise<Map<number, ImageContent[]>>;
	};
}

export type ImageReference =
	| { kind: 'file'; path: string }
	| { kind: 'vault-link'; path: string; sourcePath?: string }
	| { kind: 'url'; path: string }
	| { kind: 'pasted' | 'tool'; path: string };

export type ModelVideo = { mimeType: string } & ({ data: string; url?: never } | { url: string; data?: never });
export type VideoSourceKind = 'file' | 'link';

export type StopReason = 'end' | 'tool-calls' | 'limit';

export interface ModelResponse {
	id?: string;
	structuredOutput?: true;
	content: string;
	thinking?: string;
	toolCalls: ToolCall[];
	stopReason: StopReason;
	usage?: Usage;
	reportedUsage?: ReportedUsage;
	estimatedUsage?: ModelUsageReceipt['estimatedUsage'];
	usageStatus?: ModelUsageReceipt['usageStatus'];
	metrics?: ModelMetrics;
	/** pi-ai 已归一化的完整响应，供需要思考、用量与服务商元数据的调用方使用 */
	raw: AssistantRecord;
}

export class ContextOverflowError extends Error {}
export class RetryableModelError extends Error {}

export type ModelStreamEvent = AssistantMessageEvent;

export interface ModelStream extends AsyncIterable<ModelStreamEvent> {
	result(): Promise<ModelResponse>;
	cancel(reason?: unknown): void;
}

/* ───────────── 运行状态 ───────────── */

export type TerminalRunStatus = 'done' | 'file-changes-done' | 'partial' | 'failed' | 'cancelled' | 'limit' | 'interrupted';
export type RunStatus = 'idle' | 'running' | 'awaiting-approval' | TerminalRunStatus;

export interface ContextCompaction {
	reason: 'budget' | 'overflow';
	summary: 'none' | 'saved' | 'reused' | 'failed';
	droppedHistory: number;
	droppedCurrent: number;
	shortenedToolResults: number;
	throughMessage?: number;
}

export interface RunState {
	/** 本轮结束时的语义验收结论，由目标状态保存。 */
	goalReview?: 'passed' | 'needs-evidence';
	taskId: string;
	turn: number;
	messages: Message[];
	pendingCalls: ToolCall[];
	auxiliaryUsage?: AuxiliaryUsage[];
	contextCompaction?: ContextCompaction;
	status: RunStatus;
	createdAt?: number;
	finishedAt?: number;
	resumed?: boolean;
	error?: string;
}

export type RunEvent =
	| { type: 'state'; state: RunState }
	| { type: 'auxiliary-usage'; auxiliaryUsage: AuxiliaryUsage[] }
	| { type: 'turn-start'; turn: number }
	| { type: 'context-compaction'; compaction: ContextCompaction }
	| { type: 'model-retry'; messageId: string; waiting: boolean; reason?: 'context' }
	| { type: 'model-intent'; intent: string }
	| { type: 'text-delta'; messageId: string; contentIndex: number; text: string }
	| { type: 'thinking-delta'; messageId: string; contentIndex: number; text: string }
	| { type: 'thinking-end'; messageId: string; contentIndex: number; durationMs: number }
	| { type: 'tool-start'; call: ToolCall }
	| { type: 'tool-output'; callId: string; output: ShellOutputPreview }
	| { type: 'tool-end'; call: ToolCall; result: ToolResult; skipped?: boolean };

export type RunCheckpoint = Exclude<RunEvent, {
	type: 'text-delta' | 'thinking-delta' | 'thinking-end' | 'model-retry' | 'model-intent' | 'tool-output' | 'auxiliary-usage';
}>;

export interface SavedRetry {
	beforeMessage: number;
	event: Extract<RunEvent, { type: 'model-retry' }>;
	draft?: Pick<Message, 'content' | 'textIndex' | 'thinkingBlocks'>;
	blocks?: ({ type: 'text'; contentIndex: number; text: string } | (ThinkingBlock & { contentIndex: number }))[];
}

export interface RunObserver {
	onEvent?: (event: RunEvent) => void;
	onWork?: (taskId: string, active: boolean) => void;
	onAutoReviewDenied?: (denial: AutoReviewDenial) => void;
	approve?: (approval: ToolApproval, signal: AbortSignal) => Promise<boolean>;
	retryConnection?: (signal: AbortSignal) => Promise<void>;
	confirmResume?: (preview: ResumePreview, signal: AbortSignal) => Promise<boolean>;
}

export interface AutoReviewDenial {
	id: string;
	approval: ToolApproval;
	retry(signal: AbortSignal): Promise<ToolResult>;
}

export interface ResumePreview {
	address: string;
	request: ModelRequest;
	source: TaskRequest;
}

export interface ResumeReview {
	prepare(request: ModelRequest): void;
	beforeSend(this: void, address: string): Promise<void>;
}

/* ───────────── 第五层：通信层接口 ───────────── */

export type ModelModality = 'text' | 'image';
/** 配置中记录模型能力，当前 SDK 传输所用的 ModelModality 仍是文本和图像。 */
export type ModelInputModality = ModelModality | 'audio' | 'video' | 'pdf';
export type ConfiguredModelType = 'text' | 'image' | 'video' | 'speech-synthesis' | 'speech-recognition' | 'embedding' | 'rerank' | 'audio' | 'other';

export interface CustomProviderSettings {
	label: string;
	baseUrl: string;
	protocol: string;
}

/** 传给通信层的自建服务商定义，模型 ID 来自设置里的模型列表 */
export interface CustomProviderDef extends CustomProviderSettings {
	id: string;
	models: string[];
}

export interface ProviderModelInfo {
	id: string;
	/** 模型上下文长度，未知时为 0 */
	contextWindow: number;
	/** 输出上限，未知时为 0 */
	maxTokens: number;
	/** 输入模态（pi 聊天模型只有 text/image） */
	input: ModelModality[];
	/** pi 是否标记该模型支持推理 */
	reasoning: boolean;
	/** 目录明确标记该模型不能关闭推理 */
	requiresReasoning?: boolean;
	/** 目录里该模型自己的地址与协议 */
	baseUrl: string;
	api: string;
	/** 支持的推理档位，不含关闭 */
	thinkingLevels: ThinkingLevel[];
}

/** 单个模型的覆盖配置；缺省字段回落到服务商配置，再回落到目录元数据 */
export interface ModelOverride {
	type?: ConfiguredModelType;
	mediaOptions?: Partial<Record<import('./communication/mediaApi').MediaOperation, import('./communication/mediaApi').MediaValues>>;
	imageDefaults?: import('./orchestration/settings/mediaSettings').ImageOptions;
	videoDefaults?: import('./orchestration/settings/mediaSettings').VideoOptions;
	voice?: string;
	speechSynthesis?: import('./orchestration/settings/mediaSettings').SpeechSynthesisOptions;
	speechRecognition?: import('./orchestration/settings/mediaSettings').SpeechRecognitionOptions;
	baseUrl?: string;
	protocol?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ModelInputModality[];
	output?: ModelModality[];
	capabilities?: {
		reasoning?: boolean;
		tools?: boolean;
		structuredOutput?: boolean;
	};
	/** 该模型开放的推理档位，供聊天界面的档位选择器使用 */
	thinkingLevels?: string[];
	/** 新配置保留用户填写的英文值，旧配置沿用原有模型映射。 */
	literalThinkingLevels?: true;
	/** 旧版单档位字段，仅用于迁移读取 */
	thinkingLevel?: string;
}

export interface ModelProviderInfo {
	id: string;
	label: string;
	models: ProviderModelInfo[];
	/** 服务商自带的默认地址；模型地址不统一时为空 */
	baseUrl: string;
	/** 服务商自带的协议；模型协议不统一时为空 */
	protocol: string;
	/** 该服务商可选的协议（来自其模型目录） */
	protocols: string[];
	/** OAuth 登录能力及是否由订阅套餐提供 */
	oauth?: { subscription: boolean };
}

export type ModelCatalogModelType = ConfiguredModelType;

export interface ModelCatalogDetails {
	/** 服务商目录明确标注的模型类型，缺失时不作推断 */
	type?: ModelCatalogModelType;
	connectionProtocol?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	tools?: boolean;
	thinkingLevels?: readonly string[];
	reportedThinkingLevels?: readonly string[];
	inputModalities?: readonly string[];
	videoInput?: boolean;
	outputModalities?: readonly string[];
	structuredOutput?: boolean;
	/** The catalog advertises structured JSON without specifying a schema contract. */
	jsonOutput?: boolean;
	evidence?: Partial<Record<ModelCatalogField, ModelCatalogEvidence>>;
}

export type ModelCatalogField = Exclude<keyof ModelCatalogDetails, 'evidence'>;
export interface ModelCatalogEvidence {
	source: 'provider' | 'docs' | 'models.dev' | 'pi' | 'bundled';
	checkedAt?: string;
	conflict?: true;
}

export interface ModelCatalogResult {
	models: string[];
	source: 'provider' | 'pi' | 'bundled';
	details?: ReadonlyMap<string, ModelCatalogDetails>;
	updatedAt?: string;
	stale?: true;
}

export type ModelConnectionIssue = 'unknown-provider' | 'missing-protocol' | 'unsupported-protocol' | 'missing-address' | 'invalid-address' | 'incompatible-address';

export interface ModelConnection {
	api: string;
	baseUrl: string;
	source: 'catalog' | 'compatible' | 'configured' | 'unresolved';
	issue?: ModelConnectionIssue;
	addressFromAuth?: true;
}

export interface ModelService {
	providers(): ModelProviderInfo[];
	modelConnection(this: void, providerId: string, model: string): ModelConnection;
	modelCapabilities?(this: void, providerId: string, model: string): { structuredOutput: boolean; tools?: boolean; imageInput?: boolean; videoAnalysis?: VideoSourceKind };
	thinkingOptions(this: void, model: Pick<ModelRequest, 'providerId' | 'model'>, preferred?: string): {
		levels: string[];
		level?: string;
	};
	modelOrigin?(model: RunContext['model']): string | undefined;
	contextLimits?(model: RunContext['model']): Pick<ProviderModelInfo, 'contextWindow' | 'maxTokens'> | undefined;
	login(providerId: string, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential>;
	listProviderModels(providerId: string, signal?: AbortSignal, sharedPublicCatalog?: Promise<unknown>, sharedPiCatalog?: () => Promise<unknown>): Promise<ModelCatalogResult>;
	/** 自建/本地服务商：直接向它的 /models 查询模型清单 */
	listCustomModels(providerId: string, baseUrl: string, signal?: AbortSignal): Promise<Omit<ModelCatalogResult, 'source'> & { baseUrl: string }>;
	/** 用量回调更新当前尝试的累计快照，同一次请求的多次回调只保留最新值。 */
	send(request: ModelRequest, onUsage?: (usage: ModelUsageReceipt) => void): Promise<ModelResponse>;
	stream(request: ModelRequest, onUsage?: (receipt: ModelUsageReceipt) => void): ModelStream;
}

export type ConnectionPhase = 'connecting' | 'streaming' | 'done' | 'error';

export interface CommunicationLogEntry {
	requestId: string;
	phase: ConnectionPhase;
	at: number;
	method?: string;
	origin?: string;
	path?: string;
	status?: number;
	error?: string;
	proxy?: 'direct' | 'configured' | 'environment' | 'system';
	contextUsage?: { system: number; tools: number; project: number; session: number; dialog: number; cacheRead?: number; cacheWrite?: number };
}

export interface Transport {
	fetch: typeof fetch;
	configure(settings: CommunicationSettings): void;
	onStatus(listener: (entry: CommunicationLogEntry) => void): () => void;
	logs(): CommunicationLogEntry[];
}

export type CredentialStore = PiCredentialStore;

export interface CommunicationLayer {
	models: ModelService;
	modelCatalog: import('./orchestration/storage/modelCatalogStore').ModelCatalogStore;
	transport: Transport;
	credentials: CredentialStore;
}

/* ───────────── 第四层：工具层接口 ───────────── */

/** 各模块提供工具定义，校验、授权和结果处理统一走执行入口 */
export type ToolModule = () => ToolDefinition[];

export interface ToolRegistry {
	all(): ToolDefinition[];
	find(name: string): ToolDefinition | undefined;
}

export interface ToolExecutor {
	prepareParallelReads?(calls: ToolCall[], ctx: ToolContext): Promise<Array<() => Promise<ToolResult>> | undefined>;
	execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

export interface ExternalToolModules {
	web: ToolModule;
	shell: ToolModule;
	mcp: ToolModule;
}

export interface ToolLayer {
	mcp?: McpManager;
	registry: ToolRegistry;
	executor: ToolExecutor;
	external: ExternalToolModules;
	shellJobs: ShellJobs;
}

/* ───────────── 第二层：编排层接口 ───────────── */

export class MissingConversationError extends Error {}

export interface ConversationStore {
	saveRunProgress(id: string, taskId: string, summary: RunSummary): Promise<void>;
	chatTasks: ChatTaskStore;
	readPlanDraft(id: string, taskId: string): Promise<import('./interaction/chatPlan').PlanDraft | undefined>;
	savePlanDraft(id: string, taskId: string, draft: import('./interaction/chatPlan').PlanDraft, expectedRevision?: string): Promise<import('./interaction/chatPlan').PlanDraft>;
	shellJobHistory: ShellJobHistory;
	list(): Promise<ConversationSummary[]>;
	load(id: string): Promise<ConversationSnapshot>;
	loadGoal(id: string): Promise<ChatGoal | null | undefined>;
	saveGoal(id: string, goal: ChatGoal | null): Promise<void>;
	rename(id: string, title: string): Promise<void>;
	setArchived(id: string, archived: boolean): Promise<void>;
	saveManualCompaction(id: string, summary: HistorySummary): Promise<void>;
	delete(id: string): Promise<void>;
	lastOpened(): Promise<string | undefined>;
	setLastOpened(id: string): Promise<void>;
	append(id: string, entries: ConversationEntry[], consumption?: { messages: QueuedMessage[]; fifo?: boolean }): Promise<void>;
	getQueued(id: string): Promise<QueuedMessage[]>;
	enqueue(id: string, message: QueuedMessage): Promise<void>;
	editQueued(id: string, messageId: string, instruction: string, skillMentions?: SkillMention[]): Promise<void>;
	deleteQueued(id: string, messageId: string): Promise<void>;
	fork(id: string, taskId: string): Promise<ConversationSnapshot>;
	replaceFrom(id: string, taskId: string, entries: ConversationEntry[]): Promise<void>;
}

export interface RunStep {
	phase: 'starting' | 'model' | 'tool' | 'approval' | 'tool-result';
	turn: number;
	call?: Pick<ToolCall, 'id' | 'name'>;
}

export type ConversationEntry = MainConversationEntry
	| ChatTaskEvent
	| ({ type: 'subagent' } & SavedSubagentEntry)
	| { type: 'subagent-report'; taskId: string; report: SubagentReport };

export type MainConversationEntry =
	| { type: 'queue-add'; message: QueuedMessage }
	| { type: 'queue-edit'; messageId: string; instruction: string; skillMentions?: SkillMention[] }
	| { type: 'queue-delete'; messageId: string }
	| { type: 'start'; task: Task; model: RunContext['model']; consumedQueueIds?: string[] }
	| { type: 'messages'; taskId: string; messages: Message[]; step?: RunStep; consumedQueueIds?: string[] }
	| { type: 'step'; taskId: string; step: RunStep }
	| { type: 'plan-enter'; taskId: string }
	| { type: 'retry'; taskId: string; retry: SavedRetry }
	| { type: 'history-summary'; taskId: string; summary: HistorySummary }
	| { type: 'run-summary'; taskId: string; summary: RunSummary }
	| { type: 'prompt-context'; taskId: string; checkpoint: import('./orchestration/context/promptContext').PromptCheckpoint }
	| { type: 'video-item'; taskId: string; item: SavedVideoItem }
	| { type: 'video-analysis'; taskId: string; content: string; sources?: VideoSourceKind[] }
	| { type: 'context-compaction'; taskId: string; compaction: ContextCompaction }
	| { type: 'auxiliary-usage'; taskId: string; usage: AuxiliaryUsage }
	| { type: 'finish'; taskId: string; status: TerminalRunStatus; turn: number; error?: string; partial?: string; resumed?: boolean; finishedAt?: number };

export interface HistorySummary {
	throughTaskId: string;
	text: string;
}

export interface RunSummary {
	throughMessage: number;
	text: string;
}

export interface SavedVideoItem {
	key: string;
	content: string;
}

export interface SavedRun {
	request: TaskRequest;
	planDraft?: import('./interaction/chatPlan').PlanDraft;
	planArchived?: true;
	model: RunContext['model'];
	state: RunState;
	step?: RunStep;
	subagentReport?: SubagentReport;
	partial?: string;
	finalized?: boolean;
	retries?: SavedRetry[];
	historySummary?: HistorySummary;
	runSummary?: RunSummary;
	promptCheckpoints?: import('./orchestration/context/promptContext').PromptCheckpoint[];
	videoItems?: SavedVideoItem[];
	videoAnalysis?: string;
	videoAnalysisSources?: VideoSourceKind[];
}

export interface SubagentRole {
	name: string;
	description: string;
	instructions: string;
	model?: RunContext['model'];
	readOnly?: boolean;
}

export interface SubagentSettings {
	mode: 'auto' | 'explicit' | 'off';
	maxConcurrent: number;
	maxDepth: number;
	roles: SubagentRole[];
}

export interface SubagentIdentity {
	id: string;
	parentId?: string;
	parentTaskId?: string;
	rootTaskId: string;
	name: string;
	role: string;
	model: RunContext['model'];
}

export interface SubagentNote {
	id: string;
	from: string;
	to: string;
	text: string;
	kind: 'message' | 'result' | 'question' | 'answer';
	status?: RunStatus;
	agentName?: string;
	questionId?: string;
	path?: string;
	inline?: boolean;
	review?: { status: 'pending' | 'returned' | 'passed' | 'blocked'; reason?: string };
}

export type SubagentRecord =
	| { kind: 'create'; agent: SubagentIdentity; history?: Message[]; instructions?: string; readOnly?: boolean; planning?: true; allowProvider?: boolean; modelOrigin?: string; reportDestination?: QueuedModelDestination }
	| { kind: 'run'; entry: Exclude<MainConversationEntry, { type: 'queue-add' | 'queue-edit' | 'queue-delete' }> }
	| { kind: 'visibility'; closed: boolean }
	| { kind: 'note'; note: SubagentNote }
	| { kind: 'review'; noteId: string; disposition: 'use' | 'defer' | 'revise' | 'blocked'; reason?: string; errorKey?: string }
	| { kind: 'delivered'; ids: string[] };

export interface SavedSubagentEntry {
	agentId: string;
	record: SubagentRecord;
}

export interface SubagentView extends SubagentIdentity {
	closed?: boolean;
	runs: SavedRun[];
	notes?: SubagentNote[];
	status: RunStatus;
}

export type SubagentRequest = { id: string; agentId: string; createdAt: number } & (
	| { kind: 'approval'; approval: ToolApproval }
	| { kind: 'retry' }
	| { kind: 'send'; preview: ResumePreview }
);

export interface SubagentReport {
	content: string;
	sentAt: number;
}

export interface SubagentSnapshot {
	reports?: Readonly<Record<string, SubagentReport>>;
	reportUsage?: Readonly<Record<string, AuxiliaryUsage>>;
	submissions?: Readonly<Record<string, SubagentNote>>;
	agents: SubagentView[];
	requests: SubagentRequest[];
	error?: string;
}

export interface SubagentController {
	subscribe(conversationId: string, listener: () => void): () => void;
	snapshot(conversationId: string): SubagentSnapshot;
	load(conversationId: string): Promise<void>;
	addInstruction(conversationId: string, agentId: string, text: string, executionMode?: ExecutionMode): Promise<void>;
	stop(conversationId: string, agentId?: string): Promise<void>;
	close(conversationId: string, agentId: string): Promise<void>;
	reopen(conversationId: string, agentId: string): Promise<void>;
	resume(conversationId: string, agentId: string, executionMode?: ExecutionMode): Promise<void>;
	respond(conversationId: string, requestId: string, accepted: boolean): void;
}

export interface SubagentToolAccess {
	canSpawn: boolean;
	canAskParent?: boolean;
	resuming?: boolean;
	execute(name: string, input: unknown, signal: AbortSignal): Promise<string>;
}

export interface ConversationSnapshot {
	hasGoal?: true;
	subagents?: SavedSubagentEntry[];
	id: string;
	runs: SavedRun[];
	queue?: QueuedMessage[];
	manualCompaction?: HistorySummary;
}

export interface ConversationSummary {
	id: string;
	title: string;
	updatedAt: number;
	unreadResult?: boolean;
	archived?: true;
}

export interface SessionRunOptions {
	goal?: ChatGoal;
	model?: RunContext['model'];
	rememberConversation?: boolean;
	executionMode?: ExecutionMode;
	confirmQueuedDestination?: (previous: QueuedModelDestination | undefined, current: QueuedModelDestination, signal: AbortSignal) => Promise<boolean>;
}

export interface SessionController {
	subagents?: SubagentController;
	createConversation(): Promise<string>;
	listConversations(): Promise<ConversationSummary[]>;
	openConversation(id?: string): Promise<ConversationSnapshot | null>;
	forkConversation(id: string, taskId: string, rememberConversation?: boolean): Promise<ConversationSnapshot>;
	renameConversation(id: string, title: string): Promise<void>;
	deleteConversation(id: string): Promise<void>;
	createSideChat(parentRuns: SavedRun[], manualCompaction?: HistorySummary): SideChat;
	submit(request: TaskRequest, observer?: RunObserver, replaceFromTaskId?: string, options?: SessionRunOptions): { taskId: string; result: Promise<RunState> };
	submitQueued(message: QueuedMessage, observer: RunObserver, onStarted: () => void, options?: SessionRunOptions): { taskId: string; result: Promise<RunState> };
	canSteer(conversationId: string, taskId: string): boolean;
	steer(taskId: string, message: QueuedMessage): Promise<void>;
	resume(conversationId: string, taskId: string, observer?: RunObserver, options?: SessionRunOptions): { taskId: string; result: Promise<RunState> };
	cancel(taskId: string): Promise<void>;
	pause(taskId: string): void;
	dispose(): void;
}

export interface SideChat {
	id: string;
	skillScope?: string[];
	submit(draft: Pick<TaskRequest, 'instruction' | 'chatQuotes' | 'skillMentions' | 'skillScope' | 'skillNotePaths' | 'imageSourcePath'> & {
		refs?: NoteRef[]; model?: RunContext['model']; queued?: { destination?: QueuedModelDestination };
	}, observer?: RunObserver): {
		taskId: string; request: TaskRequest; model: SavedRun['model']; result: Promise<RunState>;
	};
	stop(): void;
	close(): void;
}

export interface SkillInfo {
	id: string;
	name: string;
	description: string;
	sourceLabel: string;
	displayName?: string;
	defaultPrompt?: string;
	enabled: boolean;
	manual: boolean;
	implicit: boolean;
}

export type SkillRegistry = import('./orchestration/context/skills').SkillRegistry;
export type SkillRun = import('./orchestration/context/skillRun').SkillRun;

export type ExecutionMode = 'ask' | 'auto-review' | 'full-access';

export interface PermissionPolicy {
	executionMode?: ExecutionMode;
	canSkipFullAccessApproval?(): boolean;
	canRequestPath?(this: void, path: string, operation: 'read' | 'write'): boolean;
	canRead(path: string): boolean;
	readLines?(path: string): [number, number] | undefined;
	canWrite(path: string): boolean;
	canCallTool(tool: ToolDefinition): boolean;
	canSendOutbound(): boolean;
}

export interface RunContext {
	chatTasks?: RunChatTasks;
	goalReport?: { criterionCount: number; recorded(): boolean };
	plan?: import('./tools/planTools').RunPlanTools;
	mcpRun?: McpRun;
	videoAnalysis?: { sources: readonly VideoSourceKind[]; read(): Promise<string> };
	manualSummary?: string;
	skillRun?: SkillRun;
	subagents?: SubagentToolAccess;
	subagentId?: string;
	subagentCatalog?: string;
	subagentPrompt?: string;
	subagentInstructions?: string;
	isolatedAgent?: boolean;
	destinationCheck?: (request: ModelRequest, address: string, destinationFingerprint?: string) => Promise<void>;
	inbox?: () => readonly SubagentNote[];
	acceptInbox?: (ids: string[]) => Promise<void>;
	collaboration?: {
		pending(): { blocking: boolean; questions: boolean; actionable: boolean };
		waitForProgress(signal: AbortSignal): Promise<void>;
	};
	task: Task;
	sideChat?: boolean;
	permissions: PermissionPolicy;
	cwd: string;
	model: Pick<ModelRequest, 'providerId' | 'model' | 'reasoning'>;
	checkModel?: () => void;
	reviewTool?: (approval: ToolApproval) => Promise<boolean>;
	resumeReview?: ResumeReview;
	takeSteering?: () => readonly QueuedMessage[];
	nextSteeringSignal?: () => AbortSignal;
	rejectSteering?: (ids: string[], reason?: string) => void;
	signal: AbortSignal;
	observer: RunObserver;
	readFiles: Map<string, string>;
	readDelivery: ReadDelivery;
	history?: Message[];
	agreements?: string[];
	summarizeHistory?: (dropped: ReadonlySet<Message>, room: number, maxBytes: number) => Promise<{
		text?: string;
		status: ContextCompaction['summary'];
	}>;
	runCompaction?: {
		summary?: RunSummary;
		summarize(messages: Message[], throughMessage: number, room: number, maxBytes: number): Promise<ContextCompaction['summary']>;
	};
	writingRules?: string;
	writingRulesCurrent?: () => Promise<string | undefined>;
	canDescribeTool?: PermissionPolicy['canCallTool'];
	memory?: import('./orchestration/context/longTermMemory').MemoryRun;
	directoryRules?: import('./orchestration/context/writingRules').DirectoryRules;
	promptContext?: import('./orchestration/context/promptContext').RunPromptContext;
	promptMessageCount?: number;
	promptResuming?: boolean;
	record?: (event: RunCheckpoint) => Promise<void>;
	previewModelUsage?: (receipt: ModelUsageReceipt) => void;
	recordUnfinishedRequest?: (receipt: ModelUsageReceipt) => Promise<void>;
}

export interface ContextBuilder {
	build(
		ctx: RunContext,
		current: Message[],
		maxBytes: number,
		reason?: ContextCompaction['reason'],
	): Promise<ModelRequest>;
}

export interface OrchestrationLayer {
	sessions: SessionController;
	context: ContextBuilder;
	skills: SkillRegistry;
	conversations: ConversationStore;
}

/* ───────────── 第三层：核心循环层接口 ───────────── */

export interface ModelCoordinator {
	nextTurn(state: RunState, ctx: RunContext): Promise<ModelResponse & { requiredToolIntents?: ReadonlySet<string>; goalReportRequired?: true }>;
}

export interface ToolCoordinator {
	runCalls(
		state: RunState,
		ctx: RunContext,
		approve: ToolContext['approve'],
		skip?: (call: ToolCall) => string | undefined | Promise<string | undefined>,
	): AsyncIterable<{ call: ToolCall; result: ToolResult; skipped?: boolean }>;
}

export interface AgentLoop {
	run(ctx: RunContext, state: RunState): Promise<RunState>;
}

export interface Agent {
	loop: AgentLoop;
	state: RunState;
}

export interface RuntimeLayer {
	createAgent(ctx: RunContext, state?: RunState): Agent;
	newState(ctx: RunContext): RunState;
	models: ModelCoordinator;
	tools: ToolCoordinator;
}

/* ───────────── 跨层汇总 ───────────── */

export interface CommunicationSettings {
	/** SecretStorage 条目的 ID；条目的值才是凭据，不保存到这里 */
	credentialIds: Record<string, string>;
	proxyUrl: string;
	proxyCredentialId?: string;
	/** 仅影响显示名称，索引仍然用服务商 ID */
	providerNames: Record<string, string>;
	/** 端点覆盖：该服务商的所有模型都走这里，空表示用自带地址 */
	baseUrls: Record<string, string>;
	/** 协议覆盖：该服务商的所有模型都走这个协议，空表示用模型自带协议 */
	protocols: Record<string, string>;
}

export type ChatLocation = 'right-sidebar' | 'left-sidebar' | 'editor-tab';

export interface LegacyWritingRules {
	vault: string;
	folders: Record<string, string>;
}

export interface ScribeSettings {
	mcp?: McpSettings;
	webSearch?: WebSearchSettings;
	media?: import('./orchestration/settings/mediaSettings').MediaSettings;
	videoModel?: Pick<ModelRequest, 'providerId' | 'model'>;
	videoLinkModel?: ScribeSettings['videoModel'] | null;
	skillSettings?: SkillSettings;
	subagents?: SubagentSettings;
	slashPresets?: Array<{ label: string; content: string } | null>;
	/** 聊天默认模型；服务商是否启用单独保存 */
	providerId: string;
	model: string;
	/** 每个已添加服务商的模型列表，键是内部服务商 ID */
	providerModels: Record<string, string[]>;
	disabledProviderIds: string[];
	chatLocation: ChatLocation;
	/** 删除、归档对话前是否弹出确认框；缺省视为开启。 */
	confirmChatRemoval: boolean;
	/** 完全访问模式下是否仍需本人批准库外写入和超出只读沙箱的命令。 */
	confirmFullAccessExternalActions?: boolean;
	/** 诊断日志保留天数；超过该天数没有新写入的日志文件会被清理，0 表示永久保留。 */
	logRetentionDays: number;
	/** Days before the one-shot startup cleanup removes spill files; 0 disables cleanup. */
	spillCleanupDays: number;
	/** 仅用于读取并迁移旧版配置。 */
	writingRules?: LegacyWritingRules;
	/** 旧文件夹规则和未迁移的全库规则，仅供恢复。 */
	writingRulesBackup?: LegacyWritingRules;
	/** providerId → modelId → 该模型的覆盖配置 */
	modelOverrides: Record<string, Record<string, ModelOverride>>;
	/** [服务商 ID, 模型 ID] 编码为键，记住各模型上次选中的推理档位。 */
	thinkingByModel: Record<string, string>;
	/** 自建服务商（自定义端点 / 本地模型）：label、地址与协议由用户填写 */
	customProviders: Record<string, CustomProviderSettings>;
	communication: CommunicationSettings;
}

export interface ScribeServices {
	app: App;
	settings: ScribeSettings;
	/** 插件自己的数据目录，供设置界面展示与清理。 */
	paths: { data: string; logs: string; cache: string };
	logs: import('./orchestration/storage/conversationLog').ConversationLogStore;
	localState: import('./orchestration/storage/localState').LocalState;
	communication: CommunicationLayer;
	tools: ToolLayer;
	webSearch: WebSearchService;
	orchestration: OrchestrationLayer;
	runtime: RuntimeLayer;
}
