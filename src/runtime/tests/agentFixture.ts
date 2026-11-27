import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { App } from 'obsidian';
import { createContextBuilder } from '../../orchestration/context/contextBuilder';
import { createSessionController } from '../../orchestration/sessionController';
import { normalizeSettings } from '../../orchestration/settings/defaults';
import { createConversationStore } from '../../orchestration/storage/conversationStore';
import type { LocalState } from '../../orchestration/storage/localState';
import { createToolRegistry } from '../../tools';
import { createToolExecutor } from '../../tools/executor';
import { isDirectMcpToolName } from '../../tools/support/toolInput';
import type { ModelRequest, ModelResponse, ModelService, ModelStream, RuntimeLayer, SkillRegistry, ToolCall, ToolLayer, ToolModule } from '../../types';
import { createAgentLoop } from '../agentLoop';
import { bindAgent } from '../createAgent';
import { createModelCoordinator } from '../modelCoordinator';
import { createRunState } from '../runState';
import { createToolCoordinator } from '../toolCoordinator';

function testApp(cwd: string): App {
	return { vault: {
		adapter: {
			getBasePath: () => cwd,
			async process(path: string, update: (content: string) => string) {
				const file = join(cwd, path);
				await writeFile(file, update(await readFile(file, 'utf8')));
			},
		},
		configDir: 'fixture-vault-config',
		getFileByPath: () => null,
		create: (path: string, content: string) => writeFile(join(cwd, path), content, { flag: 'wx' }),
	} } as unknown as App;
}

export async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), 'scribe-agent-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, 'vault');
	await mkdir(cwd);
	return { root, cwd, app: testApp(cwd) };
}

export function fixtureToolIntents(calls: ToolCall[]): ToolCall[] {
	return calls.map((call) => isDirectMcpToolName(call.name) || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)
		|| 'i' in call.input ? call : { ...call, input: { intent: '检查测试资料', ...call.input } });
}

export function emptyModelResponse(content: string, toolCalls: ToolCall[] = [], stopReason?: ModelResponse['stopReason']): ModelResponse {
	toolCalls = fixtureToolIntents(toolCalls);
	const raw: AssistantMessage = {
		role: 'assistant', content: [{ type: 'text', text: content }], api: 'openai-completions',
		provider: 'fake', model: 'fake',
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: toolCalls.length ? 'toolUse' : 'stop', timestamp: Date.now(),
	};
	return { raw, content, toolCalls, stopReason: stopReason ?? (toolCalls.length ? 'tool-calls' : 'end') };
}

export function fakeStream(response: ModelResponse, signal?: AbortSignal): ModelStream {
	return {
		async *[Symbol.asyncIterator]() {
			await Promise.resolve();
			signal?.throwIfAborted();
			yield { type: 'text_delta', delta: response.content, contentIndex: 0, partial: response.raw };
		},
		result: () => Promise.resolve(response),
		cancel() {},
	};
}

export function sessionsFor(app: App, service: Pick<ModelService, 'stream' | 'contextLimits' | 'modelCapabilities'>, modules: ToolModule[] | ToolLayer, settings = normalizeSettings(null), skills?: SkillRegistry, localState?: LocalState) {
	settings.providerId = 'test-model-service';
	settings.model = 'test-model';
	const registry = Array.isArray(modules) ? createToolRegistry(modules) : modules.registry;
	const models = createModelCoordinator(service, createContextBuilder(registry));
	const tools = createToolCoordinator(app, Array.isArray(modules) ? createToolExecutor(registry) : modules.executor);
	const runtime: RuntimeLayer = { newState: createRunState, createAgent: bindAgent(createAgentLoop(models, tools)), models, tools };
	const adapter = app.vault.adapter as import('obsidian').FileSystemAdapter;
	const store = createConversationStore(join(adapter.getBasePath(), 'transcripts'));
	const modelsForSession = service.modelCapabilities && {
		modelCapabilities: service.modelCapabilities,
		send: async (request: ModelRequest) => service.stream(request).result(),
	};
	return createSessionController(app, settings, runtime, store, undefined, modelsForSession,
		Array.isArray(modules) ? undefined : modules.shellJobs, skills, undefined, localState);
}
