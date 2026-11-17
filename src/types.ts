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

export interface Message {
	role: MessageRole;
	content: string;
	/** role 为 tool 时对应的工具调用 id */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** assistant 消息中由模型发起的工具调用 */
	toolCalls?: ToolCall[];
}

export interface NoteRef {
	path: string;
	/** 选区起止行，缺省表示整篇笔记 */
	lines?: [number, number];
}

export interface TaskRequest {
	conversationId: string;
	instruction: string;
	refs: NoteRef[];
}

export type TaskStatus =
	| 'pending'
	| 'running'
	| 'awaiting-user'
	| 'done'
	| 'failed'
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
}

export interface ToolContext {
	task: Task;
	app: App;
}

/* ───────────── 模型 ───────────── */

export interface ModelRequest {
	providerId: string;
	model: string;
	system?: string;
	messages: Message[];
	tools: ToolSpec[];
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
	reasoning?: ThinkingLevel;
	sessionId?: string;
	maxRetries?: number;
}

export type StopReason = 'end' | 'tool-calls' | 'limit';

export interface ModelResponse {
	content: string;
	thinking?: string;
	toolCalls: ToolCall[];
	stopReason: StopReason;
	usage?: Usage;
	/** pi-ai 已归一化的完整响应，供需要思考、用量与服务商元数据的调用方使用 */
	raw: AssistantMessage;
}

export type ModelStreamEvent = AssistantMessageEvent;

export interface ModelStream extends AsyncIterable<ModelStreamEvent> {
	result(): Promise<ModelResponse>;
	cancel(reason?: unknown): void;
}

/* ───────────── 运行状态 ───────────── */

export type RunStatus = 'idle' | 'running' | 'awaiting-approval' | 'done' | 'failed';

export interface RunState {
	taskId: string;
	turn: number;
	messages: Message[];
	pendingCalls: ToolCall[];
	status: RunStatus;
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
	thinkingLevels?: ThinkingLevel[];
	/** 旧版单档位字段，仅用于迁移读取 */
	thinkingLevel?: ThinkingLevel;
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

/** 一个工具模块只声明能力清单，实际执行统一走工具执行入口 */
export type ToolModule = () => ToolSpec[];

export interface ToolRegistry {
	all(): ToolSpec[];
	find(name: string): ToolSpec | undefined;
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

export interface ConversationStore {
	load(conversationId: string): Promise<Message[]>;
	append(conversationId: string, messages: Message[]): Promise<void>;
}

export interface TaskStore {
	load(taskId: string): Promise<Task | null>;
	save(task: Task): Promise<void>;
	list(): Promise<Task[]>;
}

export interface TaskManager {
	create(request: TaskRequest, parentId?: string): Promise<Task>;
	update(taskId: string, patch: Partial<Task>): Promise<Task>;
	children(taskId: string): Promise<Task[]>;
}

export interface SessionController {
	createConversation(): Promise<string>;
	submit(request: TaskRequest): Promise<Task>;
	cancel(taskId: string): Promise<void>;
}

export interface SkillInfo {
	name: string;
	description: string;
}

export interface SkillRegistry {
	list(): SkillInfo[];
	load(name: string): Promise<string>;
}

export interface PermissionPolicy {
	canRead(path: string): boolean;
	canWrite(path: string): boolean;
	canCallTool(tool: ToolSpec): boolean;
	canSendOutbound(): boolean;
}

export interface RunContext {
	task: Task;
	permissions: PermissionPolicy;
}

export interface ContextBuilder {
	build(
		ctx: RunContext,
		history: Message[],
		skills: SkillRegistry,
	): Promise<ModelRequest>;
}

export interface OrchestrationLayer {
	sessions: SessionController;
	tasks: TaskManager;
	context: ContextBuilder;
	skills: SkillRegistry;
	permissions: PermissionPolicy;
	conversations: ConversationStore;
	taskStore: TaskStore;
}

/* ───────────── 第三层：核心循环层接口 ───────────── */

export interface ModelCoordinator {
	nextTurn(state: RunState, ctx: RunContext): Promise<ModelResponse>;
}

export interface ToolCoordinator {
	runCalls(state: RunState, ctx: RunContext): Promise<ToolResult[]>;
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
