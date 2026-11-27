import { Buffer } from 'node:buffer';
import { neutralizePromptTags } from '../../orchestration/context/promptXml';
import { withToolIntent } from '../support/toolInput';
import { mcpDigest } from './mcp';
import type { McpLiveServer, McpManager } from './mcp';
import type { ImageToolOutput, ToolDefinition, ToolSpec } from '../../types';

const searchName = 'search_mcp_tools';
const invokeName = 'call_mcp_tool';

function alias(server: McpLiveServer['server'], name: string, kind: string): string {
	const slug = (value: string, length: number) => value.replace(/[^a-z0-9_-]/gi, '_').slice(0, length);
	const suffix = mcpDigest([server.id, kind, name]).slice(0, 12);
	return `mcp__${slug(server.name, 16)}__${slug(name, 24)}_${suffix}`;
}

function objectArgs(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MCP 工具参数必须是对象。');
	return input as Record<string, unknown>;
}

type McpOutput = ImageToolOutput & { isError: boolean };
type McpTool = ToolDefinition & { mcp: NonNullable<ToolDefinition['mcp']> & {
	serverId?: string; connectionKey?: string; remoteName?: string;
} };

const annotations = new Set(['description', 'title', '$comment', 'markdownDescription', 'markdownEnumDescriptions']);
const schemaGroups = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const schemaBranches = new Set(['additionalProperties', 'unevaluatedProperties', 'additionalItems', 'unevaluatedItems',
	'items', 'prefixItems', 'contains', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'contentSchema']);

function schemaAnnotations(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(schemaAnnotations);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(sortedEntries(value).map(([key, child]) => {
		if (annotations.has(key)) {
			if (typeof child === 'string') return [key, neutralizePromptTags(child)];
			if (Array.isArray(child)) return [key, child.map((entry: unknown) => typeof entry === 'string' ? neutralizePromptTags(entry) : entry)];
		}
		if (schemaGroups.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
			return [key, Object.fromEntries(sortedEntries(child).map(([name, schema]) => [name, schemaAnnotations(schema)]))];
		}
		return [key, schemaBranches.has(key) ? schemaAnnotations(child) : child];
	}));
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sortedEntries(value: object): [string, unknown][] {
	return Object.entries(value).sort(([a], [b]) => compare(a, b));
}

function spec({ name, description, inputSchema, mcp }: McpTool): ToolSpec {
	return mcp.serverId === undefined ? withToolIntent({ name, description, inputSchema })
		: { name, description: neutralizePromptTags(description), inputSchema: schemaAnnotations(inputSchema) as Record<string, unknown> };
}

// Preserve JSON Schema argument literals when presenting the definition as model-visible text.
const discoveryJson = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

function remoteTool(
	live: McpLiveServer, kind: 'tool' | 'resource', name: string, definition: Omit<ToolSpec, 'name'>,
	invoke: (args: Record<string, unknown>, signal: AbortSignal) => Promise<McpOutput>, signature?: string,
): McpTool {
	const label = live.server.name + ' / ' + name;
	const binding = mcpDigest([live.generation, kind, name, signature]);
	const tool: McpTool = {
		name: alias(live.server, name, kind), ...definition,
		isReadOnly: false,
		mcp: { kind, binding, label, serverId: live.server.id, connectionKey: live.connectionKey, ...(kind === 'tool' && { remoteName: name }) },
		maxResultSizeChars: 100_000,
		prepare(input, { signal, permissions }) {
			const args = objectArgs(input ?? {});
			const combined = AbortSignal.any([signal, live.signal]);
			const run = async () => {
				combined.throwIfAborted();
				if (!permissions.canCallTool(tool)) throw new Error('MCP 工具的权限已变更。');
				live.verify(signature, signature ? name : undefined);
				return invoke(args, combined);
			};
			if (permissions.executionMode === 'full-access') return { independent: true, run };
			const details = live.connection.redact(JSON.stringify(args, null, 2));
			// 审批内容必须完整可见，避免隐藏发送给外部服务的参数。
			if (details.length > 65_536) throw new Error('MCP 调用参数过长，无法完整预览。请分批操作。');
			return { approval: {
				title: '批准 MCP 工具调用', kind: 'mcp', target: label, after: details,
				reason: live.server.url
					? `参数会发送给远程 MCP 服务器 ${new URL(live.server.url).origin}。`
					: '参数会交给已启用的本地程序。',
			}, approvalIdentity: binding, run };
		},
	};
	return tool;
}

const discovery: McpTool = {
	name: searchName,
	description: '按服务器名、工具名或用途搜索 MCP，可用 offset 查下一页。结果提供工具标识和参数定义，包括按需访问资源的工具。',
	inputSchema: {
		type: 'object',
		properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
		required: ['query'], additionalProperties: false,
	},
	isReadOnly: true,
	mcp: { kind: 'search', binding: searchName, label: '搜索 MCP 工具' },
	prepare(input, ctx) {
		const value = objectArgs(input);
		return { run: () => ctx.mcpRun?.search(value, (tool) => ctx.permissions.canCallTool(tool)) ?? '本次聊天未启用 MCP 工具。' };
	},
};

const invocation: McpTool = {
	name: invokeName,
	description: '调用在上次模型请求前由 search_mcp_tools 找到的 MCP 工具。name 填结果中的工具标识，arguments 按该项参数定义填写，可能需要用户审批。',
	inputSchema: {
		type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } },
		required: ['name', 'arguments'], additionalProperties: false,
	},
	isReadOnly: false,
	mcp: { kind: 'invoke', binding: invokeName, label: '调用 MCP 工具' },
	maxResultSizeChars: 100_000,
	prepare(input, ctx) {
		const args = objectArgs(input);
		const tool = ctx.mcpRun?.resolve(args.name, (candidate) => ctx.permissions.canCallTool(candidate));
		if (!tool) throw new Error('MCP 工具尚未搜索，或连接与工具定义已变化。请重新搜索。');
		return tool.prepare(objectArgs(args.arguments), ctx);
	},
};

export function createMcpTools(manager: McpManager, serverId?: string): McpTool[] {
	const live = manager.live().filter(({ server }) => serverId === undefined || server.id === serverId);
	if (!manager.settings().servers.some((server) => server.enabled && (serverId === undefined || server.id === serverId))) return [];
	const tools = live.flatMap((entry) => {
		const { connection, server } = entry;
		const tools = entry.tools.map(({ tool, signature }) => remoteTool(entry, 'tool', tool.name, {
			description: `[${server.name} / ${tool.name}]` + (tool.description ? ' ' + tool.description : ''),
			inputSchema: tool.inputSchema,
		}, (args, signal) => connection.callTool(tool.name, args, signal), signature));
		if (!entry.resources) return tools;
		return [...tools,
			remoteTool(entry, 'resource', 'list_resources', {
				description: `列出 ${server.name} 提供的 MCP 资料和资料模板。`,
				inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			}, (_, signal) => connection.listResources(signal)),
			remoteTool(entry, 'resource', 'read_resource', {
				description: `读取 ${server.name} 提供的 MCP 资料。使用服务列出的地址，或按资料模板填入参数。`,
				inputSchema: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false },
			}, (args, signal) => {
				if (typeof args.uri !== 'string' || !args.uri.trim()) throw new Error('请提供要读取的资料地址。');
				return connection.readResource(args.uri, signal);
			}),
		];
	}).sort((a, b) => compare(a.name, b.name));
	return [discovery, invocation, ...tools];
}

export function createMcpRun(manager: McpManager, targetServerId?: string) {
	let published: McpTool[] | undefined;
	let offered = new Map<string, McpTool>();
	const selected = new Map<string, string>();
	const pending = new Map<string, string>();
	let searchBudget = 0;
	const target = () => targetServerId === undefined ? undefined : manager.settings().servers.find(({ id }) => id === targetServerId);
	const currentTools = () => createMcpTools(manager, targetServerId);
	const servers = () => manager.live().filter(({ server }) => targetServerId === undefined || server.id === targetServerId)
		.map(({ server, connectionKey, generation, instructions, resources, tools }) => ({
			id: server.id, name: server.name, key: connectionKey, instructions,
			revision: mcpDigest([generation, server.name, instructions, resources, tools.map(({ signature }) => signature).sort()]),
		})).sort((a, b) => compare(a.id, b.id));
	let initial: ReturnType<typeof servers> | undefined;
	let projected: ReturnType<typeof servers> | undefined;
	let projectedRevision: string | undefined;
	const helpers = (tool: McpTool) => tool.mcp.serverId === undefined;
	const remote = (tool: McpTool) => tool.mcp.serverId !== undefined;
	const definitionAllowed = ({ mcp }: McpTool) => mcp.serverId !== undefined && mcp.connectionKey !== undefined
		&& manager.allowsDefinition(mcp.serverId, mcp.connectionKey, mcp.remoteName);
	const revision = (live: ReturnType<typeof servers>) => mcpDigest([
		live,
		initial?.map(({ id, key }) => manager.allowsDefinition(id, key)),
		published?.filter(remote).map(definitionAllowed),
	]);

	function fit(items: McpTool[], limit: number): McpTool[] {
		return items.filter((tool) => {
			const size = Buffer.byteLength(JSON.stringify(spec(tool)));
			if (size > limit) return false;
			limit -= size;
			return true;
		});
	}

	return {
		targetName: () => target()?.name,
		canProject: (allowed: (tool: ToolDefinition) => boolean) => allowed(discovery),
		async ready(allowed: (tool: ToolDefinition) => boolean, signal: AbortSignal) {
			if (targetServerId !== undefined && !allowed(discovery)) {
				throw new Error('当前聊天无法调用 MCP 工具。请检查工具开关和聊天模式。');
			}
			if (initial) return;
			if (targetServerId === undefined) {
				if (allowed(discovery)) await manager.waitForRequired(signal);
				return;
			}
			const server = target();
			if (!server?.enabled) throw new Error('选中的 MCP 服务器已停用或移除。请在设置中检查服务器。');
			await manager.waitForServer(targetServerId, signal);
			const tools = createMcpTools(manager, targetServerId);
			if (!manager.live().some(({ server }) => server.id === targetServerId)) {
				throw new Error(`无法使用 MCP 服务器「${server.name}」。请在设置中检查连接状态。`);
			}
			if (!tools.some((tool) => remote(tool) && allowed(tool))) {
				throw new Error(`MCP 服务器「${server.name}」没有可用工具。请在设置中检查工具开关。`);
			}
		},
		project(definitions: ToolDefinition[], maxBytes: number, enabled = definitions.some(({ mcp }) => Boolean(mcp))) {
			offered = new Map();
			projected = undefined;
			projectedRevision = undefined;
			if (!enabled) return [];
			projected = servers();
			initial ??= projected;
			const all = definitions.filter((tool): tool is McpTool => Boolean(tool.mcp)).filter((tool) =>
				targetServerId === undefined || helpers(tool) || tool.mcp.serverId === targetServerId);
			const current = new Map(all.map((tool) => [tool.name, tool]));
			searchBudget = Math.min(16_000, Math.floor(maxBytes));
			if (!published) {
				const control = all.filter(helpers);
				const candidates = all.filter(({ mcp }) => mcp.kind === 'tool').sort((a, b) => compare(a.name, b.name));
				const total = candidates.reduce((size, tool) => size + JSON.stringify(spec(tool)).length, 0);
				const { loading, threshold } = manager.settings();
				const direct = targetServerId !== undefined || loading === 'direct' || (loading === 'auto' && total <= threshold);
				published = fit([...control, ...(direct ? candidates : [])], maxBytes);
				if (targetServerId !== undefined && !published.some(({ name }) => name === invokeName)) {
					throw new Error('选中的 MCP 工具超出当前模型的容量。请更换模型或减少启用的工具。');
				}
			}
			for (const [name, binding] of pending) selected.set(name, binding);
			pending.clear();
			const visible = published.filter((tool) => {
				const { name, mcp } = tool;
				if (mcp.serverId === undefined) return true;
				if (!definitionAllowed(tool)) return false;
				return !projected?.some(({ id }) => id === mcp.serverId) || current.get(name)?.mcp.binding === mcp.binding;
			});
			offered = new Map(visible.map((tool) => [tool.name, tool]));
			projectedRevision = revision(projected);
			return visible.map(spec);
		},
		beforeSend() {
			if (projectedRevision !== undefined && projectedRevision !== revision(servers())) {
				throw new Error('发送前 MCP 连接、工具或服务器说明已变化。请重试。');
			}
		},
		instructions() {
			if (!projected) return [];
			return (initial ?? []).flatMap(({ id, name, key, instructions }) => {
				if (!instructions || !manager.allowsDefinition(id, key)) return [];
				const now = projected?.find((entry) => entry.id === id);
				return !now || now.instructions === instructions ? [{ server: name, instructions }] : [];
			});
		},
		changes() {
			if (!initial || !projected) return [];
			const previous = new Map(initial.map((server) => [server.id, server]));
			const latest = new Map(projected.map((server) => [server.id, server]));
			return [...new Set([...previous.keys(), ...latest.keys()])].flatMap((id) => {
				const was = previous.get(id);
				const now = latest.get(id);
				if (!now && was) return [`MCP 服务「${was.name}」已断开或暂停，旧工具暂不可调用。`];
				if (now && !was) return [`MCP 服务「${now.name}」已连接。` + (offered.has(searchName)
					? '需要时可使用 MCP 搜索了解本轮可用工具。' : '下次任务可使用该服务。')];
				return now && now.revision !== was?.revision
					? [`MCP 服务「${now.name}」的连接或目录已更新。调用前重新搜索所需工具。`] : [];
			});
		},
		label(name: string, input?: unknown) {
			const projectedTool = offered.get(name);
			if (projectedTool && name === invokeName) {
				const args = input as { name?: unknown } | undefined;
				return currentTools().find((tool) => tool.name === args?.name)?.mcp.label ?? projectedTool.mcp.label;
			}
			return projectedTool?.mcp.label;
		},
		canInvoke(tool: ToolDefinition) {
			return tool.mcp !== undefined && offered.get(tool.name)?.mcp.binding === tool.mcp.binding;
		},
		resolve(name: unknown, allowed: (tool: ToolDefinition) => boolean) {
			if (typeof name !== 'string') return;
			return currentTools().find((tool) => remote(tool) && tool.name === name && allowed(tool)
				&& selected.get(name) === tool.mcp.binding);
		},
		canReplay(content: string, allowed: (tool: ToolDefinition) => boolean = () => true) {
			if (!content.startsWith('{')) return true;
			try {
				const result: unknown = JSON.parse(content);
				if (!result || typeof result !== 'object' || !('tools' in result) || !Array.isArray(result.tools)) return false;
				const current = new Map(currentTools().filter((tool) => remote(tool) && allowed(tool)).map((tool) => [tool.name, tool]));
				return result.tools.every((entry: unknown) => {
					if (!entry || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string') return false;
					const tool = current.get(entry.name);
					if (!tool) return false;
					if ('inputSchema' in entry) return JSON.stringify({ ...spec(tool), tool: tool.mcp.label }) === JSON.stringify(entry);
					return JSON.stringify({ name: tool.name, tool: tool.mcp.label, description: tool.description }) === JSON.stringify(entry);
				});
			} catch { return false; }
		},
		search(args: Record<string, unknown>, allowed: (tool: ToolDefinition) => boolean) {
			const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
			const offset = typeof args.offset === 'number' && Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
			const keywords = query.split(/\s+/).filter(Boolean);
			const matching = currentTools().filter((tool) => remote(tool) && allowed(tool)
				&& keywords.every((keyword) => (tool.mcp.label + ' ' + tool.name + ' ' + tool.description).toLowerCase().includes(keyword)));
			const definitions = (tool: McpTool) => ({ ...spec(tool), tool: tool.mcp.label });
			const fitting = matching.filter((tool) => Buffer.byteLength(discoveryJson(definitions(tool))) + 64 <= searchBudget);
			const batch: ReturnType<typeof definitions>[] = [];
			let remaining = searchBudget - 64;
			for (const tool of fitting.slice(offset, offset + 5)) {
				const entry = definitions(tool);
				remaining -= Buffer.byteLength(discoveryJson(entry)) + 1;
				if (remaining < 0) break;
				batch.push(entry);
				pending.set(tool.name, tool.mcp.binding);
			}
			if (!batch.length) return matching.length && !offset ? '匹配的 MCP 工具参数定义超出当前模型容量。' : '没有更多匹配的 MCP 工具。';
			return discoveryJson({
				tools: batch,
				nextOffset: offset + batch.length < fitting.length ? offset + batch.length : undefined,
			});
		},
	};
}

export type McpRun = ReturnType<typeof createMcpRun>;
