import type { App, FileSystemAdapter, PluginManifest } from 'obsidian';
import { nodeRequire } from './communication/nodeRequire';
import { createCredentialStore } from './communication/credentials';
import { createModelService } from './communication/providers';
import { createTransport } from './communication/transport';
import { createContextBuilder } from './orchestration/context/contextBuilder';
import type { SkillReviewActions } from './orchestration/context/skills';
import { createSkillRegistry } from './orchestration/context/skills';
import { createSessionController } from './orchestration/sessionController';
import type { LocalState } from './orchestration/storage/localState';
import { createAgentLoop } from './runtime/agentLoop';
import { bindAgent } from './runtime/createAgent';
import { createModelCoordinator } from './runtime/modelCoordinator';
import { createRunState } from './runtime/runState';
import { createToolCoordinator } from './runtime/toolCoordinator';
import { createToolLayer } from './tools';
import { createMcpManager } from './tools/external/mcp';
import { normalizeMcpSettings } from './tools/external/mcpConfig';
import type { McpSettings } from './tools/external/mcpConfig';
import type {
	CommunicationLayer,
	ConversationStore,
	OrchestrationLayer,
	RuntimeLayer,
	ScribeServices,
	ScribeSettings,
} from './types';

/** 根级依赖组装：只负责按层创建服务并把它们连起来，业务留在各层 */
export function createServices(app: App, settings: ScribeSettings, manifest: PluginManifest,
	conversations: ConversationStore, localState: LocalState, cacheDirectory: string,
	saveSettings: () => Promise<void>, skillReview: SkillReviewActions, saveMcp: (settings: McpSettings) => Promise<void>): ScribeServices {
	const cwd = (app.vault.adapter as FileSystemAdapter).getBasePath();
	// 第四层：工具层（模型通信之外的执行能力）
	const mcp = createMcpManager({
		settings: () => settings.mcp ?? normalizeMcpSettings(undefined), commit: saveMcp,
		storage: app.secretStorage, cwd, clientInfo: { name: manifest.id, version: manifest.version },
		openBrowser: (url) => {
			try {
				const { shell } = nodeRequire('electron') as { shell?: { openExternal(url: string): Promise<void> } };
				if (shell) {
					void shell.openExternal(url).catch(() => { activeWindow.open(url, '_blank', 'noopener'); });
					return;
				}
			} catch { /* 使用 Obsidian 窗口的外部链接行为。 */ }
			activeWindow.open(url, '_blank', 'noopener');
		},
	});
	const tools = createToolLayer(conversations.shellJobHistory, mcp, cacheDirectory);

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
		createAgent: bindAgent(createAgentLoop(models, toolCoordinator, mcp)),
		newState: createRunState,
		models,
		tools: toolCoordinator,
	};

	const skills = createSkillRegistry(app, settings, saveSettings, skillReview);
	const orchestration: OrchestrationLayer = {
		sessions: createSessionController(
			app, settings, runtime, conversations, communication.models.thinkingOptions, communication.models, tools.shellJobs, skills,
		),
		context,
		skills,
		conversations,
	};

	return { app, settings, localState, communication, tools, orchestration, runtime };
}
