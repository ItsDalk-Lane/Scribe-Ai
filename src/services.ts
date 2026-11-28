import type { App, FileSystemAdapter, PluginManifest } from 'obsidian';
import { nodeRequire } from './communication/nodeRequire';
import { diagnostics } from './communication/diagnostics';
import { createConversationLogStore } from './orchestration/storage/conversationLog';
import { scribeDataPaths } from './orchestration/storage/paths';
import { createCredentialStore } from './communication/credentials';
import { createModelService } from './communication/providers';
import { createTransport } from './communication/transport';
import { createNodeFetch } from './communication/nodeFetch';
import { createContextBuilder } from './orchestration/context/contextBuilder';
import type { SkillReviewActions } from './orchestration/context/skills';
import { createSkillRegistry } from './orchestration/context/skills';
import { createSessionController } from './orchestration/sessionController';
import { isTextModel, reconcileDefaultModel } from './orchestration/settings/modelAvailability';
import { createRuntimeModelCatalog } from './orchestration/settings/runtimeModelCatalog';
import { createMediaVideoJobs } from './orchestration/mediaVideoJobs';
import { mediaConnection } from './orchestration/settings/mediaConnection';
import type { LocalState } from './orchestration/storage/localState';
import { createModelCatalogStore } from './orchestration/storage/modelCatalogStore';
import { createAgentLoop } from './runtime/agentLoop';
import { bindAgent } from './runtime/createAgent';
import { createModelCoordinator } from './runtime/modelCoordinator';
import { createRunState } from './runtime/runState';
import { createToolCoordinator } from './runtime/toolCoordinator';
import { createToolLayer } from './tools';
import { createMcpManager } from './tools/external/mcp';
import { normalizeMcpSettings } from './tools/external/mcpConfig';
import type { McpSettings } from './tools/external/mcpConfig';
import { createWebSearchService } from './tools/external/webTools';
import { arkPlanConnection, createMediaTools } from './tools/external/mediaTools';
import type {
	CommunicationLayer,
	ConversationStore,
	ModelService,
	OrchestrationLayer,
	RuntimeLayer,
	ScribeServices,
	ScribeSettings,
} from './types';

/** 根级依赖组装：只负责按层创建服务并把它们连起来，业务留在各层 */
export function createServices(app: App, settings: ScribeSettings, manifest: PluginManifest,
	conversations: ConversationStore, localState: LocalState, cacheDirectory: string,
	saveSettings: () => Promise<void>, skillReview: SkillReviewActions, saveMcp: (settings: McpSettings) => Promise<void>,
	onConversationDeleted: (id: string) => Promise<void>): ScribeServices {
	const cwd = (app.vault.adapter as FileSystemAdapter).getBasePath();
	const paths = scribeDataPaths(cwd);
	// 诊断日志写入当前笔记库的数据目录，按对话分文件保存。
	const logs = createConversationLogStore(paths.logs);
	diagnostics.useSink((scope, entry) => logs.append(scope, entry));
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
	const webSearch = createWebSearchService(settings, app.secretStorage, cwd, { name: manifest.id, version: manifest.version });
	const mediaFetch = createNodeFetch(undefined, { timeouts: { firstByteMs: 150_000 } });
	const mediaVideos = conversations.mediaVideoHistory && createMediaVideoJobs({
		history: conversations.mediaVideoHistory, fetcher: mediaFetch, cwd, configDir: app.vault.configDir,
		connection: () => arkPlanConnection(settings, app.secretStorage),
		externalConnection: (route) => mediaConnection(settings, app.secretStorage, route),
	});
	const media = createMediaTools({ settings, secrets: app.secretStorage, fetcher: mediaFetch, videos: mediaVideos, conversations,
		refreshRadiusLogin: (signal) => baseModels.refreshRadiusMediaLogin(signal) });
	const tools = createToolLayer(conversations.shellJobHistory, mcp, cacheDirectory, webSearch.tools, app, media);

	// 第五层：通信层（仅负责模型服务接入）
	const credentials = createCredentialStore(app, settings.communication);
	const transport = createTransport(settings.communication, app.secretStorage);
	const runtimeCatalog = createRuntimeModelCatalog(settings, () => modelService);
	const baseModels = createModelService(credentials, transport, {
		baseUrls: () => settings.communication.baseUrls,
		protocols: () => settings.communication.protocols,
		modelOverrides: () => settings.modelOverrides,
		catalogProtocol: (providerId, model) => runtimeCatalog.active()
			? runtimeCatalog.protocol(providerId, model) : modelCatalog.protocol(providerId, model),
		catalogDetails: (providerId, model, baseUrl) => runtimeCatalog.active()
			? runtimeCatalog.details(providerId, model, baseUrl) : modelCatalog.details(providerId, model, baseUrl),
		customProviders: () => Object.entries(settings.customProviders).map(([id, entry]) => ({
			id,
			label: entry.label,
			baseUrl: entry.baseUrl,
			protocol: entry.protocol,
			models: settings.providerModels[id] ?? [],
		})),
	});
	const modelCatalog = createModelCatalogStore(settings, baseModels);
	const modelService: ModelService = {
		...baseModels,
		withPreparedModels: runtimeCatalog.withPreparedModels,
		prepareModel: runtimeCatalog.prepareModel,
		send: (request, onUsage) => runtimeCatalog.withPreparedModels(async () => {
			await runtimeCatalog.prepareModel(request, request.signal);
			return baseModels.send(request, onUsage);
		}),
	};
	const reconcileCatalogModel = () => {
		if (!isTextModel(settings, settings, modelService.modelType)) reconcileDefaultModel(settings, modelService.modelType);
	};
	reconcileCatalogModel();
	modelCatalog.subscribeProtocols(reconcileCatalogModel);
	const communication: CommunicationLayer = {
		models: modelService,
		modelCatalog,
		transport,
		credentials,
	};

	// 核心循环接通模型通信和工具执行。
	const context = createContextBuilder(tools.registry, app);
	const models = createModelCoordinator(communication.models, context);
	const toolCoordinator = createToolCoordinator(app, tools.executor);
	const runtime: RuntimeLayer = {
		createAgent: bindAgent(createAgentLoop(models, toolCoordinator, mcp)),
		newState: createRunState,
		models,
		tools: toolCoordinator,
	};

	const skills = createSkillRegistry(app, settings, saveSettings, skillReview, mcp.isConnected);
	const orchestration: OrchestrationLayer = {
		sessions: createSessionController(
			app, settings, runtime, conversations, communication.models.thinkingOptions, communication.models, tools.shellJobs, skills, onConversationDeleted, localState, mediaVideos,
		),
		context,
		skills,
		conversations,
	};

	return { app, settings, paths: { data: paths.root, logs: paths.logs, cache: paths.cache }, logs,
		localState, communication, tools, webSearch, mediaVideos, orchestration, runtime };
}
