import type {
	AssistantMessage,
	AssistantMessageEvent,
	AuthInteraction,
	Credential,
	CredentialStore as PiCredentialStore,
	LoginOptions,
	ThinkingLevel,
	Usage,
} from '@earendil-works/pi-ai';
import type { App } from 'obsidian';

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
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
}

export interface Message {
	role: MessageRole;
	content: string;
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
	toolDurationMs?: number;
	/** assistant 消息中由模型发起的工具调用 */
	toolCalls?: ToolCall[];
	/** 保留同一模型继续当前任务时所需的原始内容和签名 */
	rawAssistant?: AssistantRecord;
}

export interface NoteRef {
	path: string;
	kind?: 'file' | 'folder';
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

export interface TaskRequest {
	conversationId: string;
	instruction: string;
	refs: NoteRef[];
	selection?: NoteSelection;
	chatQuotes?: string[];
}

export interface QueuedMessage {
	id: string;
	request: TaskRequest;
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
	name: string;
	input: unknown;
}

export interface ToolResult {
	callId: string;
	content: string;
	isError: boolean;
	durationMs?: number;
	fileRead?: FileReadPage;
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

export interface ToolContext {
	task: Task;
	app: App;
	signal: AbortSignal;
	permissions: PermissionPolicy;
	readFiles: Map<string, string>;
	readDelivery: ReadDelivery;
	cwd: string;
	approve?: (approval: ToolApproval) => Promise<boolean>;
}

export interface ToolApproval {
	title: string;
	target: string;
	before?: string;
	after?: string;
	kind?: 'shell' | 'access';
	reason?: string;
}

export interface PreparedTool {
	approval?: ToolApproval;
	independent?: true;
	run(): Promise<string | { content: string; fileRead: FileReadPage }> | string;
}

export interface ToolDefinition extends ToolSpec {
	isReadOnly: boolean;
	maxResultSizeChars?: number;
	isAvailable?(): boolean;
	prepare(input: unknown, ctx: ToolContext): Promise<PreparedTool> | PreparedTool;
}

/* ───────────── 模型 ───────────── */

export interface ModelRequest {
	beforeSend?: (address: string) => Promise<void>;
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
}

export type StopReason = 'end' | 'tool-calls' | 'limit';

export interface ModelResponse {
	id?: string;
	content: string;
	thinking?: string;
	toolCalls: ToolCall[];
	stopReason: StopReason;
	usage?: Usage;
	reportedUsage?: ReportedUsage;
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

export interface RunState {
	taskId: string;
	turn: number;
	messages: Message[];
	pendingCalls: ToolCall[];
	status: RunStatus;
	createdAt?: number;
	finishedAt?: number;
	resumed?: boolean;
	error?: string;
}

export type RunEvent =
	| { type: 'state'; state: RunState }
	| { type: 'turn-start'; turn: number }
	| { type: 'model-retry'; messageId: string; waiting: boolean; reason?: 'context' }
	| { type: 'model-intent'; intent: string }
	| { type: 'text-delta'; messageId: string; contentIndex: number; text: string }
	| { type: 'thinking-delta'; messageId: string; contentIndex: number; text: string }
	| { type: 'thinking-end'; messageId: string; contentIndex: number; durationMs: number }
	| { type: 'tool-start'; call: ToolCall }
	| { type: 'tool-end'; call: ToolCall; result: ToolResult; skipped?: boolean };

export type RunCheckpoint = Exclude<RunEvent, { type: 'text-delta' | 'thinking-delta' | 'thinking-end' | 'model-retry' | 'model-intent' }>;

export interface SavedRetry {
	beforeMessage: number;
	event: Extract<RunEvent, { type: 'model-retry' }>;
	draft?: Pick<Message, 'content' | 'textIndex' | 'thinkingBlocks'>;
	blocks?: ({ type: 'text'; contentIndex: number; text: string } | (ThinkingBlock & { contentIndex: number }))[];
}

export interface RunObserver {
	onEvent?: (event: RunEvent) => void;
	approve?: (approval: ToolApproval, signal: AbortSignal) => Promise<boolean>;
	retryConnection?: (signal: AbortSignal) => Promise<void>;
	confirmResume?: (preview: ResumePreview, signal: AbortSignal) => Promise<boolean>;
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
	baseUrl?: string;
	protocol?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ModelModality[];
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

export interface ModelService {
	providers(): ModelProviderInfo[];
	thinkingOptions(this: void, model: Pick<ModelRequest, 'providerId' | 'model'>, preferred?: string): {
		levels: string[];
		level?: string;
	};
	contextLimits?(model: RunContext['model']): Pick<ProviderModelInfo, 'contextWindow' | 'maxTokens'> | undefined;
	login(providerId: string, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential>;
	refresh(providerId?: string): Promise<void>;
	/** 自建/本地服务商：直接向它的 /models 查询模型清单 */
	listCustomModels(providerId: string, baseUrl: string): Promise<{ models: string[]; baseUrl: string }>;
	send(request: ModelRequest): Promise<ModelResponse>;
	stream(request: ModelRequest): ModelStream;
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
	execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

export interface ExternalToolModules {
	web: ToolModule;
	shell: ToolModule;
	mcp: ToolModule;
}

export interface ToolLayer {
	registry: ToolRegistry;
	executor: ToolExecutor;
	external: ExternalToolModules;
}

/* ───────────── 第二层：编排层接口 ───────────── */

export class MissingConversationError extends Error {}

export interface ConversationStore {
	list(): Promise<ConversationSummary[]>;
	load(id: string): Promise<ConversationSnapshot>;
	rename(id: string, title: string): Promise<void>;
	delete(id: string): Promise<void>;
	lastOpened(): Promise<string | undefined>;
	setLastOpened(id: string): Promise<void>;
	append(id: string, entries: ConversationEntry[], consumption?: { messages: QueuedMessage[]; fifo?: boolean }): Promise<void>;
	getQueued(id: string): Promise<QueuedMessage[]>;
	enqueue(id: string, message: QueuedMessage): Promise<void>;
	editQueued(id: string, messageId: string, instruction: string): Promise<void>;
	deleteQueued(id: string, messageId: string): Promise<void>;
	fork(id: string, taskId: string): Promise<ConversationSnapshot>;
	replaceFrom(id: string, taskId: string, entries: ConversationEntry[]): Promise<void>;
}

export interface RunStep {
	phase: 'starting' | 'model' | 'tool' | 'approval' | 'tool-result';
	turn: number;
	call?: Pick<ToolCall, 'id' | 'name'>;
}

export type ConversationEntry =
	| { type: 'queue-add'; message: QueuedMessage }
	| { type: 'queue-edit'; messageId: string; instruction: string }
	| { type: 'queue-delete'; messageId: string }
	| { type: 'start'; task: Task; model: RunContext['model']; consumedQueueIds?: string[] }
	| { type: 'messages'; taskId: string; messages: Message[]; step?: RunStep; consumedQueueIds?: string[] }
	| { type: 'step'; taskId: string; step: RunStep }
	| { type: 'retry'; taskId: string; retry: SavedRetry }
	| { type: 'finish'; taskId: string; status: TerminalRunStatus; turn: number; error?: string; partial?: string; resumed?: boolean; finishedAt?: number };

export interface SavedRun {
	request: TaskRequest;
	model: RunContext['model'];
	state: RunState;
	step?: RunStep;
	partial?: string;
	finalized?: boolean;
	retries?: SavedRetry[];
}

export interface ConversationSnapshot {
	id: string;
	runs: SavedRun[];
	queue?: QueuedMessage[];
}

export interface ConversationSummary {
	id: string;
	title: string;
	updatedAt: number;
}

export interface SessionRunOptions {
	model?: RunContext['model'];
	rememberConversation?: boolean;
	executionMode?: ExecutionMode;
}

export interface SessionController {
	createConversation(): Promise<string>;
	listConversations(): Promise<ConversationSummary[]>;
	openConversation(id?: string): Promise<ConversationSnapshot | null>;
	forkConversation(id: string, taskId: string, rememberConversation?: boolean): Promise<ConversationSnapshot>;
	renameConversation(id: string, title: string): Promise<void>;
	deleteConversation(id: string): Promise<void>;
	createSideChat(parentRuns: SavedRun[]): SideChat;
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
	submit(draft: Pick<TaskRequest, 'instruction' | 'chatQuotes'> & { refs?: NoteRef[]; model?: RunContext['model'] }, observer?: RunObserver): {
		taskId: string; request: TaskRequest; model: SavedRun['model']; result: Promise<RunState>;
	};
	stop(): void;
	close(): void;
}

export interface SkillInfo {
	name: string;
	description: string;
}

export interface SkillRegistry {
	list(): SkillInfo[];
	load(name: string): Promise<string>;
}

export type ExecutionMode = 'ask' | 'auto-review' | 'full-access';

export interface PermissionPolicy {
	executionMode?: ExecutionMode;
	canRequestPath?(this: void, path: string, operation: 'read' | 'write'): boolean;
	canRead(path: string): boolean;
	readLines?(path: string): [number, number] | undefined;
	canWrite(path: string): boolean;
	canCallTool(tool: ToolDefinition): boolean;
	canSendOutbound(): boolean;
}

export interface RunContext {
	task: Task;
	sideChat?: boolean;
	permissions: PermissionPolicy;
	cwd: string;
	model: Pick<ModelRequest, 'providerId' | 'model' | 'reasoning'>;
	checkModel?: () => void;
	reviewTool?: (approval: ToolApproval) => Promise<boolean>;
	resumeReview?: ResumeReview;
	takeSteering?: () => readonly QueuedMessage[];
	rejectSteering?: (ids: string[]) => void;
	signal: AbortSignal;
	observer: RunObserver;
	readFiles: Map<string, string>;
	readDelivery: ReadDelivery;
	history?: Message[];
	agreements?: string[];
	record?: (event: RunCheckpoint) => Promise<void>;
}

export interface ContextBuilder {
	build(
		ctx: RunContext,
		current: Message[],
		maxBytes: number,
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
	nextTurn(state: RunState, ctx: RunContext): Promise<ModelResponse>;
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
	/** 仅影响显示名称，索引仍然用服务商 ID */
	providerNames: Record<string, string>;
	/** 端点覆盖：该服务商的所有模型都走这里，空表示用自带地址 */
	baseUrls: Record<string, string>;
	/** 协议覆盖：该服务商的所有模型都走这个协议，空表示用模型自带协议 */
	protocols: Record<string, string>;
}

export type ChatLocation = 'right-sidebar' | 'left-sidebar' | 'editor-tab';

export interface ScribeSettings {
	/** 当前生效的模型；providerId + model 指向同一个服务商 */
	providerId: string;
	model: string;
	/** 每个已添加服务商的模型列表，键是内部服务商 ID */
	providerModels: Record<string, string[]>;
	chatLocation: ChatLocation;
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
	communication: CommunicationLayer;
	tools: ToolLayer;
	orchestration: OrchestrationLayer;
	runtime: RuntimeLayer;
}
