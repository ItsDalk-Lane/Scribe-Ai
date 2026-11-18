import { join, resolve } from 'node:path';
import type { App, FileSystemAdapter, PluginManifest } from 'obsidian';
import { createCredentialStore } from './communication/credentials';
import { createModelService } from './communication/providers';
import { createTransport } from './communication/transport';
import { createContextBuilder } from './orchestration/context/contextBuilder';
import { createSkillRegistry } from './orchestration/context/skills';
import { createSessionController } from './orchestration/sessionController';
import { createConversationStore } from './orchestration/storage/conversationStore';
import { createAgentLoop } from './runtime/agentLoop';
import { bindAgent } from './runtime/createAgent';
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
export function createServices(app: App, settings: ScribeSettings, manifest: PluginManifest): ScribeServices {
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

	// 核心循环接通模型通信和工具执行。
	const context = createContextBuilder(tools.registry);
	const models = createModelCoordinator(communication.models, context);
	const toolCoordinator = createToolCoordinator(app, tools.executor);
	const runtime: RuntimeLayer = {
		createAgent: bindAgent(createAgentLoop(models, toolCoordinator)),
		newState: createRunState,
		models,
		tools: toolCoordinator,
	};

	const cwd = (app.vault.adapter as FileSystemAdapter).getBasePath();
	const pluginDirectory = manifest.dir ?? join(app.vault.configDir, 'plugins', manifest.id);
	const conversations = createConversationStore(resolve(cwd, pluginDirectory, 'conversations'));
	const orchestration: OrchestrationLayer = {
		sessions: createSessionController(app, settings, runtime, conversations),
		context,
		skills: createSkillRegistry(),
		conversations,
	};

	return { app, settings, communication, tools, orchestration, runtime };
}
