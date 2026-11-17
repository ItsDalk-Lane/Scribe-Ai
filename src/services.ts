import type { App } from 'obsidian';
import { createCredentialStore } from './communication/credentials';
import { createModelService } from './communication/providers';
import { createTransport } from './communication/transport';
import { createContextBuilder } from './orchestration/context/contextBuilder';
import { createSkillRegistry } from './orchestration/context/skills';
import { createPermissionPolicy } from './orchestration/policies/permissions';
import { createSessionController } from './orchestration/sessionController';
import { createConversationStore } from './orchestration/storage/conversationStore';
import { createTaskStore } from './orchestration/storage/taskStore';
import { createTaskManager } from './orchestration/taskManager';
import { createAgent } from './runtime/createAgent';
import { createModelCoordinator } from './runtime/modelCoordinator';
import { createRunState } from './runtime/runState';
import { createToolCoordinator } from './runtime/toolCoordinator';
import { createToolLayer } from './tools';
import type {
	CommunicationLayer,
	OrchestrationLayer,
	RuntimeLayer,
	ScribeServices,
	ScribeSettings,
} from './types';

/** 根级依赖组装：只负责按层创建服务并把它们连起来，业务留在各层 */
export function createServices(app: App, settings: ScribeSettings): ScribeServices {
	// 第四层：工具层（模型通信之外的执行能力）
	const tools = createToolLayer();

	// 第五层：通信层（仅负责模型服务接入）
	const credentials = createCredentialStore(app, settings.communication);
	const transport = createTransport(settings.communication);
	const communication: CommunicationLayer = {
		models: createModelService(credentials, transport, {
			baseUrls: () => settings.communication.baseUrls,
			protocols: () => settings.communication.protocols,
			modelOverrides: () => settings.modelOverrides,
			customProviders: () => Object.entries(settings.customProviders).map(([id, entry]) => ({
				id,
				label: entry.label,
				baseUrl: entry.baseUrl,
				protocol: entry.protocol,
				models: settings.providerModels[id] ?? [],
			})),
		}),
		transport,
		credentials,
	};

	// 第二层：编排层（会话、任务、上下文、授权、持久化）
	const orchestration: OrchestrationLayer = {
		sessions: createSessionController(),
		tasks: createTaskManager(),
		context: createContextBuilder(),
		skills: createSkillRegistry(),
		permissions: createPermissionPolicy(),
		conversations: createConversationStore(),
		taskStore: createTaskStore(),
	};

	// 第三层：核心循环层（单任务内部的推理与行动推进）
	const runtime: RuntimeLayer = {
		createAgent,
		newState: createRunState,
		models: createModelCoordinator(),
		tools: createToolCoordinator(),
	};

	// shortcut: 依赖目前直接按创建顺序注入，等实现具体模块时改为显式传入上游服务
	return { app, settings, communication, tools, orchestration, runtime };
}
