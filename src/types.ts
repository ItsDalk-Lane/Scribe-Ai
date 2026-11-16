import type {
	AssistantMessage,
	AssistantMessageEvent,
	CredentialStore as PiCredentialStore,
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

export interface ModelProviderInfo {
	id: string;
	label: string;
	models: string[];
}

export interface ModelService {
	providers(): ModelProviderInfo[];
	refresh(providerId?: string): Promise<void>;
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

export interface RunPolicy {
	maxTurns: number;
	maxToolCallsPerTurn: number;
	maxContextNotes: number;
}

export interface RunContext {
	task: Task;
	permissions: PermissionPolicy;
	policy: RunPolicy;
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
	policy: RunPolicy;
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
}

export interface ScribeSettings {
	enabled: boolean;
	providerId: string;
	model: string;
	run: RunPolicy;
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
