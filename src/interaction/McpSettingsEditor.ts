import { App, Modal, setIcon } from 'obsidian';
import type { McpServerDraft } from '../tools/external/mcpConfig';
import { confirmAction } from './ConfirmModal';
import { renderMcpServerForm } from './mcpServerForm';
import { mcpButton, mcpSearch, mcpSegments, mcpStatus, mcpSwitch, type McpServerView, type McpSettingsManager } from './mcpSettingsControls';
import { errorText, tr } from './skills/dialog';

type EditorSection = 'general' | 'tools';
type ToolView = McpServerView['tools'][number];

export class McpSettingsEditor extends Modal {
	private unsubscribe?: () => void;

	constructor(app: App, private readonly manager: McpSettingsManager, private readonly serverId?: string) { super(app); }

	onOpen(): void {
		const { manager, serverId, contentEl } = this;
		this.modalEl.addClass('scribe-mcp-modal');
		let saved: McpServerDraft | undefined;
		try { saved = serverId ? manager.draft(serverId) : undefined; }
		catch {
			this.setTitle(tr('无法读取服务器配置', 'Could not load server configuration'));
			contentEl.createEl('p', { cls: 'scribe-mcp-issue', text: tr('无法读取已保存的连接信息。', 'Could not read saved connection details.') });
			return;
		}
		if (serverId && !saved) { this.close(); return; }
		const original: McpServerDraft = saved ?? { id: '', name: '', type: 'stdio', enabled: false };

		this.setTitle(original.name || tr('新建 MCP 服务器', 'New MCP server'));
		const heading = contentEl.createDiv({ cls: 'scribe-mcp-modal-heading' });
		const status = heading.createDiv({ cls: 'scribe-mcp-status', attr: { role: 'status' } });
		const dot = status.createSpan({ cls: 'scribe-mcp-status-dot', attr: { 'aria-hidden': 'true' } });
		const statusText = status.createSpan();
		const enableSetting = heading.createDiv({ cls: 'scribe-mcp-tool-switch' });
		const enabledLabel = tr('启用服务器', 'Enable server');
		enableSetting.createSpan({ text: enabledLabel });
		let enabled = original.enabled;
		const enabledSwitch = mcpSwitch(enableSetting, enabledLabel, enabled, (checked) => {
			enabled = checked;
			enabledSwitch.setAttribute('aria-checked', String(enabled));
		});
		const auth = contentEl.createDiv({ cls: 'scribe-mcp-auth' });
		const alert = contentEl.createEl('p', { cls: 'scribe-mcp-issue', attr: { role: 'alert' } });
		alert.hidden = true;
		const showError = (message = '') => { alert.hidden = !message; alert.setText(message); };
		const act = async (action: () => Promise<void>) => {
			showError();
			try { await action(); }
			catch (cause) { if (alert.isConnected) showError(errorText(cause)); }
		};

		const navigation = contentEl.createDiv({ cls: 'scribe-mcp-toolbar' });
		let section: EditorSection = 'general';
		const generalLabel = tr('常规', 'General');
		const toolsLabel = tr('工具', 'Tools');
		const setSection = mcpSegments<EditorSection>(navigation, tr('服务器设置', 'Server settings'), [
			['general', generalLabel], ['tools', toolsLabel],
		], (value) => { section = value; paintSection(); });
		const toolsTab = navigation.querySelectorAll<HTMLButtonElement>('button')[1];
		const general = contentEl.createDiv({ cls: 'scribe-mcp-fields' });
		const fields = renderMcpServerForm(this.app, general, original);
		const readDraft = () => {
			const previous = serverId ? manager.draft(serverId) : original;
			if (!previous) throw new Error(tr('此服务器已被移除。', 'This server was removed.'));
			return fields.read(enabled, previous);
		};
		const tools = contentEl.createDiv({ cls: 'scribe-mcp-tools' });
		const paintSection = () => { setSection(section); general.hidden = section !== 'general'; tools.hidden = section !== 'tools'; };
		paintSection();
		let toolsQuery = '';
		const search = mcpSearch(tools, tr('搜索工具…', 'Search tools…'), (value) => { toolsQuery = value; paintTools(); });
		const toolList = tools.createDiv({ cls: 'scribe-mcp-list' });
		const expanded = new Set<string>();
		const toolPending = new Set<string>();
		const updateTool = async (name: string, action: () => Promise<void>) => {
			toolPending.add(name);
			await act(action);
			toolPending.delete(name);
			if (toolList.isConnected) paintTools();
		};
		let view: McpServerView | undefined;
		function paintTools() {
			const entries = view?.tools ?? [];
			if (toolsTab) toolsTab.setText(`${toolsLabel} (${entries.length})`);
			search.parentElement!.hidden = entries.length === 0;
			const activeElement = toolList.ownerDocument.activeElement as HTMLElement | null;
			const focusKey = toolList.contains(activeElement) ? activeElement?.dataset.mcpTool : undefined;
			toolList.empty();
			const matched = entries.filter((item) => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(toolsQuery));
			if (!matched.length) toolList.createDiv({ cls: 'scribe-mcp-empty', text: entries.length ? tr('没有找到匹配的工具。', 'No matching tools.')
				: tr('保存并启用服务器后，这里会显示可用工具。', 'Save and enable this server to see its tools.') });
			for (const item of matched) {
				const row = toolList.createDiv({ cls: 'scribe-mcp-tool' });
				const head = row.createDiv({ cls: 'scribe-mcp-tool-head' });
				const title = mcpButton(head, item.name, 'scribe-mcp-tool-name', expanded.has(item.name) ? 'chevron-down' : 'chevron-right');
				title.title = item.name;
				const detail = row.createDiv({ cls: 'scribe-mcp-tool-detail' });
				if (item.description) detail.createDiv({ text: item.description });
				detail.createEl('pre', { text: JSON.stringify(item.inputSchema, null, 2), attr: { 'aria-label': tr('工具参数', 'Tool parameters') } });
				const setExpanded = (open: boolean) => {
					if (open) expanded.add(item.name);
					else expanded.delete(item.name);
					detail.hidden = !open;
					title.setAttribute('aria-expanded', String(open));
					const icon = title.querySelector('span');
					if (icon) setIcon(icon, open ? 'chevron-down' : 'chevron-right');
				};
				setExpanded(expanded.has(item.name));
				title.addEventListener('click', () => setExpanded(detail.hidden));
				title.dataset.mcpTool = `${item.name}:details`;
				const disabled = !serverId || toolPending.has(item.name);
				const label = tr('启用', 'Enabled');
				const control = head.createDiv({ cls: 'scribe-mcp-tool-switch' });
				control.createSpan({ text: label });
				const enable = mcpSwitch(control, `${label} · ${item.name}`, item.enabled,
					(checked) => void updateTool(item.name, () => manager.setToolEnabled(serverId!, item.name, checked)));
				enable.dataset.mcpTool = `${item.name}:enabled`;
				enable.disabled = disabled;
				for (const element of [title, enable]) if (focusKey === element.dataset.mcpTool) element.focus({ preventScroll: true });
			}
		}

		let signingIn = false;
		let lastTools: ToolView[] | undefined;
		const paintAuth = () => {
			auth.empty();
			if (!serverId || !view?.server.enabled) { auth.hidden = true; return; }
			auth.hidden = false;
			if (signingIn && view.state === 'connecting') {
				auth.createSpan({ cls: 'scribe-mcp-description', text: tr('请在浏览器中完成登录。', 'Finish signing in in your browser.') });
				mcpButton(auth, tr('取消登录并停用', 'Cancel sign-in and disable')).addEventListener('click', () => void act(async () => {
					await manager.setEnabled(serverId, false);
					enabled = false;
					enabledSwitch.setAttribute('aria-checked', 'false');
				}));
				return;
			}
			if (view.state === 'connecting') { auth.hidden = true; return; }
			if (view.state === 'error') {
				const retry = mcpButton(auth, tr('保存并重试', 'Save and retry'), '', 'refresh-cw');
				retry.addEventListener('click', () => void act(async () => {
					retry.disabled = true;
					try { await manager.save(readDraft(), true); }
					finally { retry.disabled = false; }
				}));
			}
			if (view.server.type !== 'stdio') {
				const signedIn = view.signedIn;
				mcpButton(auth, signedIn ? tr('退出登录', 'Sign out') : tr('在浏览器中登录', 'Sign in in browser')).addEventListener('click', () => void act(async () => {
					if (signedIn) { await manager.logout(serverId); return; }
					signingIn = true;
					try { await manager.login(serverId); }
					finally { signingIn = false; if (auth.isConnected) paintAuth(); }
				}));
			}
			auth.hidden = !auth.childElementCount;
		};
		const paint = () => {
			view = serverId ? manager.snapshot().find(({ server }) => server.id === serverId) : undefined;
			dot.dataset.state = view?.state ?? 'disabled';
			statusText.setText([mcpStatus(view), view?.version].filter(Boolean).join(' · '));
			const entries = view?.tools ?? [];
			if (JSON.stringify(lastTools) !== JSON.stringify(entries)) { lastTools = entries; paintTools(); }
			paintAuth();
		};
		this.unsubscribe = manager.subscribe(paint);
		paint();

		const actions = contentEl.createDiv({ cls: 'scribe-mcp-actions' });
		if (serverId) mcpButton(actions, tr('删除', 'Delete'), 'mod-warning').addEventListener('click', () => {
			confirmAction(this.app, {
				title: tr('移除 MCP 服务器', 'Remove MCP server'),
				message: tr(`要移除「${original.name}」吗？关联的钥匙串条目会保留。`, `Remove “${original.name}”? Linked secret storage entries will be kept.`),
				confirmText: tr('移除', 'Remove'), cancelText: tr('取消', 'Cancel'),
				onConfirm: () => act(async () => { await manager.remove(serverId); this.close(); }),
			});
		});
		const cancel = mcpButton(actions, tr('取消', 'Cancel'));
		cancel.addEventListener('click', () => this.close());
		const save = mcpButton(actions, tr('保存', 'Save'), 'mod-cta');
		const initialName = original.name;
		fields.name.addEventListener('input', () => this.setTitle(fields.name.value.trim() || initialName || tr('新建 MCP 服务器', 'New MCP server')));
		const doSave = () => void act(async () => {
			if (save.disabled) return;
			const draft = readDraft();
			const buttons = actions.querySelectorAll('button');
			buttons.forEach((button) => { button.disabled = true; });
			try { await manager.save(draft); this.close(); }
			finally { buttons.forEach((button) => { button.disabled = false; }); }
		});
		save.addEventListener('click', doSave);
		general.addEventListener('keydown', (event) => {
			const target = event.target as HTMLElement | null;
			if (event.key === 'Enter' && target?.tagName === 'INPUT' && target.getAttribute('type') !== 'checkbox') {
				event.preventDefault();
				doSave();
			}
		});
		if (!serverId) fields.name.focus();
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.contentEl.empty();
	}
}
