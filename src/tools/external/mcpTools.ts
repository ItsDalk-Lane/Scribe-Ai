import { Buffer } from 'node:buffer';
import { mcpDigest } from './mcp';
import type { McpLiveServer, McpManager } from './mcp';
import type { ImageToolOutput, ToolDefinition, ToolSpec } from '../../types';

const searchName = 'search_mcp_tools';

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
type McpTool = ToolDefinition & { mcp: NonNullable<ToolDefinition['mcp']> & { serverId?: string } };

function spec({ name, description, inputSchema }: ToolSpec): ToolSpec {
	return { name, description, inputSchema };
}

function remoteTool(
	live: McpLiveServer, kind: 'tool' | 'resource', name: string, definition: Omit<ToolSpec, 'name'>,
	invoke: (args: Record<string, unknown>, signal: AbortSignal) => Promise<McpOutput>, signature?: string,
): McpTool {
	const label = live.server.name + ' / ' + name;
	const binding = signature ?? mcpDigest([live.server.id, live.connectionKey, kind, name]);
	return {
		name: alias(live.server, name, kind), ...definition,
		isReadOnly: false,
		mcp: { kind, binding, label, serverId: live.server.id },
		maxResultSizeChars: 100_000,
		prepare(input, { signal, permissions }) {
			const args = objectArgs(input ?? {});
			const combined = AbortSignal.any([signal, live.signal]);
			const run = async () => {
				combined.throwIfAborted();
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
}

const discovery: McpTool = {
	name: searchName,
	description: '搜索按需加载的 MCP 工具。使用服务名称、工具名称或功能描述搜索，选五项匹配工具加入后续请求。可用 offset 查看下一页。',
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

export function createMcpTools(manager: McpManager, serverId?: string): McpTool[] {
	const live = manager.live().filter(({ server }) => serverId === undefined || server.id === serverId);
	if (!live.length) return [];
	return [discovery, ...live.flatMap((entry) => {
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
	})];
}

export function createMcpRun(manager: McpManager, targetServerId?: string) {
	let candidates: McpTool[] = [];
	let offered = new Map<string, string>();
	let selected = new Map<string, string>();
	let room = 0;
	let resources: McpTool[] = [];
	const target = () => targetServerId === undefined ? undefined : manager.settings().servers.find(({ id }) => id === targetServerId);

	function fit(items: McpTool[], limit: number): McpTool[] {
		return items.filter((tool) => {
			const size = Buffer.byteLength(JSON.stringify(spec(tool)));
			if (size > limit) return false;
			limit -= size;
			return true;
		});
	}
	const install = (tools: McpTool[]) => {
		offered = new Map(tools.map(({ name, mcp }) => [name, mcp.binding]));
		return tools.map(spec);
	};

	return {
		targetName: () => target()?.name,
		async ready(allowed: (tool: ToolDefinition) => boolean, signal: AbortSignal) {
			if (targetServerId === undefined) {
				if (allowed(discovery)) await manager.waitForRequired(signal);
				return;
			}
			const server = target();
			if (!server?.enabled) throw new Error('选中的 MCP 服务器已停用或移除。请在设置中检查服务器。');
			if (!allowed(discovery)) throw new Error('当前聊天无法调用 MCP 工具。请检查工具开关和聊天模式。');
			await manager.waitForServer(targetServerId, signal);
			const tools = createMcpTools(manager, targetServerId);
			if (!tools.length) throw new Error(`无法使用 MCP 服务器「${server.name}」。请在设置中检查连接状态。`);
			if (!tools.some((tool) => tool.mcp.kind !== 'search' && allowed(tool))) {
				throw new Error(`MCP 服务器「${server.name}」没有可用工具。请在设置中检查工具开关。`);
			}
		},
		project(definitions: ToolDefinition[], maxBytes: number) {
			room = Math.max(0, Math.floor(maxBytes));
			const all = definitions.filter((tool): tool is McpTool => Boolean(tool.mcp)).filter(({ mcp }) =>
				targetServerId === undefined || mcp.kind === 'search' || mcp.serverId === targetServerId);
			const search = all.find(({ name }) => name === searchName);
			resources = fit(all.filter(({ mcp }) => mcp.kind === 'resource'), room / 3);
			candidates = all.filter(({ mcp }) => mcp.kind !== 'search' && !resources.some(({ mcp: other }) => other.binding === mcp.binding));
			const total = candidates.reduce((size, tool) => size + JSON.stringify(spec(tool)).length, 0);
			const { loading, threshold } = manager.settings();
			const direct = targetServerId !== undefined || loading === 'direct' || (loading === 'auto' && total <= threshold);
			const visible = fit([...resources, ...(direct ? candidates : [])], room);
			if (targetServerId !== undefined && candidates.length && !visible.length) {
				throw new Error('选中的 MCP 工具超出当前模型的容量。请更换模型或减少启用的工具。');
			}
			if ((direct && visible.length === resources.length + candidates.length) || !candidates.length || !search) return install(visible);
			const loaded = candidates.filter(({ name, mcp }) => selected.get(name) === mcp.binding);
			const prioritized = direct ? [...loaded, ...candidates.filter((tool) => !loaded.includes(tool))] : loaded;
			const withSearch = fit([search, ...resources, ...prioritized], room);
			return install(targetServerId !== undefined && !withSearch.some(({ mcp }) => mcp.kind !== 'search') ? visible : withSearch);
		},
		label(name: string) {
			return offered.has(name) ? candidates.concat(resources, discovery).find((tool) => tool.name === name)?.mcp.label : undefined;
		},
		canInvoke(tool: ToolDefinition) {
			return tool.mcp !== undefined && offered.get(tool.name) === tool.mcp.binding;
		},
		search(args: Record<string, unknown>, allowed: (tool: ToolDefinition) => boolean) {
			const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
			const offset = typeof args.offset === 'number' && Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
			const keywords = query.split(/\s+/).filter(Boolean);
			const matching = createMcpTools(manager, targetServerId).filter((tool) => tool.mcp.kind !== 'search' && allowed(tool) && !resources.some(({ name }) => name === tool.name)
				&& keywords.every((keyword) => (tool.mcp.label + ' ' + tool.name + ' ' + tool.description).toLowerCase().includes(keyword)));
			const available = Math.max(0, room - Buffer.byteLength(JSON.stringify([spec(discovery), ...resources.map(spec)])));
			const fitting = matching.filter((tool) => Buffer.byteLength(JSON.stringify(spec(tool))) <= available);
			const batch: McpTool[] = [];
			let remaining = available;
			for (const tool of fitting.slice(offset, offset + 5)) {
				remaining -= Buffer.byteLength(JSON.stringify(spec(tool)));
				if (remaining < 0) break;
				batch.push(tool);
			}
			selected = new Map(batch.map(({ name, mcp }) => [name, mcp.binding]));
			if (!batch.length) return matching.length && !offset ? '匹配的 MCP 工具参数定义超出当前模型容量。' : '没有更多匹配的 MCP 工具。';
			return JSON.stringify({
				tools: batch.map(({ name, mcp, description }) => ({ name, tool: mcp.label, description })),
				nextOffset: offset + batch.length < fitting.length ? offset + batch.length : undefined,
			});
		},
	};
}

export type McpRun = ReturnType<typeof createMcpRun>;
