import { App, Menu, Modal, Notice, setIcon } from 'obsidian';
import type ScribeAiPlugin from '../main';
import { exportMcpJson, previewMcpImport, type McpSettings } from '../tools/external/mcpConfig';
import { McpSettingsEditor } from './McpSettingsEditor';
import { mcpButton, mcpSearch, mcpSegments, mcpStatus, mcpSwitch, mcpTypeLabels, type McpServerView, type McpSettingsManager } from './mcpSettingsControls';
import { errorText, tr } from './skills/dialog';

type StateFilter = 'all' | 'enabled' | 'disabled';
type ServerType = McpServerView['server']['type'];
const types: readonly ServerType[] = ['stdio', 'sse', 'http'];

export function renderMcpSettings(panel: HTMLElement, plugin: ScribeAiPlugin): () => void {
	const mcp = plugin.services.tools.mcp;
	if (!mcp) return () => {};
	const manager: McpSettingsManager = mcp;
	panel.addClass('scribe-mcp-panel');
	const page = panel.createDiv({ cls: 'scribe-mcp-page' });
	const heading = page.createDiv({ cls: 'scribe-mcp-header' });
	const headingText = heading.createDiv({ cls: 'scribe-mcp-heading' });
	headingText.createEl('h3', { text: tr('MCP 服务器', 'MCP servers') });
	headingText.createEl('p', { text: tr('连接外部服务，让聊天可以使用它们提供的工具。', 'Connect external services to use their tools in chat.'), cls: 'scribe-mcp-description' });
	const add = mcpButton(heading, tr('添加服务器', 'Add server'), 'scribe-icon-text-button', 'plus');
	setIcon(add.createSpan({ cls: 'scribe-icon-text-icon', attr: { 'aria-hidden': 'true' } }), 'chevron-down');
	add.setAttribute('aria-haspopup', 'menu');
	let activeMenu: Menu | undefined;
	let activeModal: Modal | undefined;
	const showModal = (modal: Modal) => {
		activeModal?.close();
		activeModal = modal;
		modal.open();
	};
	const showMenu = (anchor: HTMLElement, menu: Menu) => {
		activeMenu?.hide();
		activeMenu = menu;
		menu.onHide(() => { if (activeMenu === menu) activeMenu = undefined; });
		const bounds = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, anchor.ownerDocument);
	};
	const act = async (action: () => Promise<void>) => {
		try { await action(); }
		catch (cause) { new Notice(errorText(cause)); }
		finally { if (page.isConnected) paint(); }
	};
	add.addEventListener('click', () => {
		const menu = new Menu()
			.addItem((item) => item.setTitle(tr('快速创建', 'Quick create')).setIcon('plus').onClick(() => showModal(new McpSettingsEditor(plugin.app, manager))))
			.addItem((item) => item.setTitle(tr('导入配置', 'Import configuration')).setIcon('file-json').onClick(() => showModal(new McpImportModal(plugin.app, manager))))
			.addItem((item) => item.setTitle(tr('导出 JSON', 'Export JSON')).setIcon('clipboard-copy').setDisabled(manager.settings().servers.length === 0)
				.onClick(() => void act(async () => {
					const clipboard = heading.ownerDocument.defaultView?.navigator.clipboard;
					if (!clipboard) throw new Error(tr('无法访问剪贴板。', 'Clipboard is unavailable.'));
					await clipboard.writeText(exportMcpJson(manager.settings().servers));
					new Notice(tr('已复制服务器配置。', 'Copied server configuration.'));
				})));
		showMenu(add, menu);
	});

	const loading = page.createDiv({ cls: 'scribe-mcp-loading' });
	const loadingLabel = loading.createDiv();
	loadingLabel.createSpan({ text: tr('MCP 工具加载', 'MCP tool loading') });
	const thresholdLabel = loadingLabel.createEl('label', { cls: 'scribe-mcp-threshold', text: tr('字符阈值', 'Character threshold') });
	const threshold = thresholdLabel.createEl('input', { attr: { type: 'number', min: '1', step: '1' } });
	const readThreshold = () => {
		const value = threshold.valueAsNumber;
		return Number.isSafeInteger(value) && value > 0 ? value : manager.settings().threshold;
	};
	const setLoading = mcpSegments<McpSettings['loading']>(loading, tr('MCP 工具加载', 'MCP tool loading'), [
		['auto', tr('自动', 'Auto')], ['deferred', tr('按需加载', 'On demand')], ['direct', tr('直接加载', 'Direct')],
	], (mode) => void act(() => manager.setLoading(mode, readThreshold())));
	const commitThreshold = () => {
		const current = manager.settings();
		const value = readThreshold();
		threshold.value = String(value);
		if (value !== current.threshold) void act(() => manager.setLoading(current.loading, value));
	};
	threshold.addEventListener('change', commitThreshold);
	threshold.addEventListener('keydown', (event) => { if (event.key === 'Enter') threshold.blur(); });

	const toolbar = page.createDiv({ cls: 'scribe-mcp-toolbar' });
	let state: StateFilter = 'all';
	let query = '';
	const typeFilter = new Set<ServerType>();
	const setState = mcpSegments<StateFilter>(toolbar, tr('按启用状态筛选', 'Filter by enabled state'), [
		['all', tr('全部', 'All')], ['enabled', tr('已启用', 'Enabled')], ['disabled', tr('已停用', 'Disabled')],
	], (value) => { state = value; paint(); });
	const typeButton = mcpButton(toolbar, tr('筛选', 'Filter'), '', 'list-filter');
	typeButton.setAttribute('aria-haspopup', 'menu');
	const count = typeButton.createSpan({ cls: 'scribe-mcp-type' });
	typeButton.addEventListener('click', () => {
		const menu = new Menu();
		for (const type of types) menu.addItem((item) => item.setTitle(mcpTypeLabels[type]).setChecked(typeFilter.has(type)).onClick(() => {
			if (!typeFilter.delete(type)) typeFilter.add(type);
			paint();
		}));
		showMenu(typeButton, menu);
	});
	mcpSearch(toolbar, tr('搜索 MCP 服务器…', 'Search MCP servers…'), (value) => { query = value; paint(); });
	const list = page.createDiv({ cls: 'scribe-mcp-list', attr: { role: 'list' } });
	let dragged: string | undefined;
	let reorderAnnouncement = '';
	const announcement = page.createDiv({ cls: 'scribe-mcp-announcement', attr: { role: 'status' } });
	const move = (server: McpServerView['server'], target: string) => void act(async () => {
		await manager.reorder(server.id, target);
		reorderAnnouncement = tr(`已移动 ${server.name}。`, `Moved ${server.name}.`);
	});

	function paint() {
		const current = manager.settings();
		const focused = list.contains(list.ownerDocument.activeElement) ? list.ownerDocument.activeElement as HTMLElement : undefined;
		const focusedServer = focused?.closest<HTMLElement>('[data-server-id]')?.dataset.serverId;
		const focusedAction = focused?.dataset.mcpAction;
		const views = manager.snapshot();
		const filtered = views.filter(({ server }) => (state === 'all' || (state === 'enabled') === server.enabled)
			&& (typeFilter.size === 0 || typeFilter.has(server.type))
			&& [server.name, server.description, ...(server.tags ?? [])].filter(Boolean).join(' ').toLowerCase().includes(query));
		setLoading(current.loading);
		thresholdLabel.hidden = current.loading !== 'auto';
		if (threshold.ownerDocument.activeElement !== threshold) threshold.value = String(current.threshold);
		setState(state);
		count.hidden = typeFilter.size === 0;
		count.setText(String(typeFilter.size));
		announcement.setText(reorderAnnouncement);
		list.empty();
		if (!filtered.length) list.createDiv({ cls: 'scribe-mcp-empty', text: views.length
			? tr('没有符合筛选条件的服务器。', 'No servers match the current filters.')
			: tr('还没有配置 MCP 服务器。', 'No MCP servers configured yet.') });
		for (const [index, view] of filtered.entries()) {
			const { server } = view;
			const row = list.createDiv({ cls: 'scribe-mcp-row', attr: { role: 'listitem', 'data-server-id': server.id } });
			const destination = (step: number) => filtered[index + step]?.server.id;
			const handle = row.createEl('button', { cls: 'clickable-icon scribe-mcp-reorder', attr: {
				type: 'button', 'aria-label': tr(`调整 ${server.name} 的顺序`, `Reorder ${server.name}`),
				'aria-haspopup': 'menu', 'data-mcp-action': 'reorder', draggable: 'true',
			} });
			setIcon(handle, 'grip-vertical');
			handle.disabled = filtered.length < 2;
			handle.addEventListener('click', () => {
				const menu = new Menu();
				for (const [step, label] of [[-1, tr('上移', 'Move up')], [1, tr('下移', 'Move down')]] as const) {
					const target = destination(step);
					menu.addItem((item) => item.setTitle(label).setDisabled(!target).onClick(() => { if (target) move(server, target); }));
				}
				showMenu(handle, menu);
			});
			handle.addEventListener('dragstart', (event) => {
				if (!event.dataTransfer || handle.disabled) return;
				dragged = server.id;
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData('text/plain', 'scribe-mcp');
			});
			handle.addEventListener('dragend', () => { dragged = undefined; list.querySelector('.is-drop-target')?.removeClass('is-drop-target'); });
			row.addEventListener('dragover', (event) => {
				if (!dragged || dragged === server.id) return;
				event.preventDefault();
				row.addClass('is-drop-target');
			});
			row.addEventListener('dragleave', (event) => {
				if (!row.contains(event.relatedTarget as Node | null)) row.removeClass('is-drop-target');
			});
			row.addEventListener('drop', (event) => {
				if (!dragged) return;
				event.preventDefault();
				const moved = filtered.find((entry) => entry.server.id === dragged)?.server;
				dragged = undefined;
				row.removeClass('is-drop-target');
				if (moved && moved.id !== server.id) move(moved, server.id);
			});
			const status = mcpStatus(view);
			const open = row.createEl('button', { cls: 'scribe-mcp-row-main', attr: { type: 'button', title: status,
				'aria-label': `${server.name} · ${status}`, 'data-mcp-action': 'edit' } });
			open.createSpan({ cls: 'scribe-mcp-status-dot', attr: { 'data-state': view.state, 'aria-hidden': 'true' } });
			open.createSpan({ text: server.name });
			open.addEventListener('click', () => showModal(new McpSettingsEditor(plugin.app, manager, server.id)));
			row.createSpan({ cls: 'scribe-mcp-version', text: view.version ?? '—' });
			row.createSpan({ cls: 'scribe-mcp-type', text: mcpTypeLabels[server.type] });
			const toggle = mcpSwitch(row, tr(`启用 ${server.name}`, `Enable ${server.name}`), server.enabled, (enabled) => {
				toggle.disabled = true;
				void act(() => manager.setEnabled(server.id, enabled));
			});
			toggle.dataset.mcpAction = 'enable';
			if (focusedServer === server.id && focusedAction) row.querySelector<HTMLElement>(`[data-mcp-action="${focusedAction}"]`)?.focus({ preventScroll: true });
		}
	}

	const unsubscribe = manager.subscribe(paint);
	paint();
	return () => { unsubscribe(); activeMenu?.hide(); activeModal?.close(); };
}

class McpImportModal extends Modal {
	constructor(app: App, private readonly manager: McpSettingsManager) { super(app); }

	onOpen(): void {
		this.modalEl.addClass('scribe-mcp-modal', 'scribe-mcp-import');
		this.setTitle(tr('导入 MCP 配置', 'Import MCP configuration'));
		const { contentEl } = this;
		contentEl.createEl('p', { cls: 'scribe-mcp-description', text: tr('粘贴 MCP 的 JSON 或 Codex 的 TOML 配置。确认导入后，可识别的密钥会存入 Obsidian 钥匙串。服务器保持停用，启用后才会连接。', 'Paste MCP JSON or Codex TOML. Import saves recognized credentials in Obsidian secret storage. Servers stay disabled until enabled.') });
		const label = contentEl.createEl('label', { cls: 'scribe-mcp-field', text: tr('服务器配置', 'Server configuration') });
		const input = label.createEl('textarea', { cls: 'scribe-mcp-code', attr: { spellcheck: 'false', placeholder: '{ "mcpServers": { … } }' } });
		const issues = contentEl.createDiv({ cls: 'scribe-mcp-issue', attr: { role: 'status' } });
		const result = contentEl.createEl('p', { cls: 'scribe-mcp-description', attr: { role: 'status' } });
		const actions = contentEl.createDiv({ cls: 'scribe-mcp-actions' });
		const cancel = mcpButton(actions, tr('取消', 'Cancel'));
		const submit = mcpButton(actions, tr('导入', 'Import'), 'mod-cta');
		const preview = () => {
			issues.empty();
			result.empty();
			const parsed = input.value.trim() ? previewMcpImport(input.value, this.manager.settings().servers.map(({ name }) => name)) : { drafts: [], issues: [] };
			for (const issue of parsed.issues) issues.createDiv({ text: issue });
			if (parsed.drafts.length) result.setText(tr(`可导入 ${parsed.drafts.length} 个服务器：${parsed.drafts.map(({ name }) => name).join('、')}`, `${parsed.drafts.length} servers ready to import: ${parsed.drafts.map(({ name }) => name).join(', ')}`));
			submit.disabled = parsed.drafts.length === 0;
			return parsed.drafts;
		};
		input.addEventListener('input', preview);
		cancel.addEventListener('click', () => this.close());
		submit.addEventListener('click', () => {
			const drafts = preview();
			if (!drafts.length) return;
			input.disabled = submit.disabled = cancel.disabled = true;
			void this.manager.import(drafts).then(() => {
				new Notice(tr(`已导入 ${drafts.length} 个服务器。`, `Imported ${drafts.length} servers.`));
				this.close();
			}).catch((cause: unknown) => {
				issues.createDiv({ text: errorText(cause) });
				input.disabled = submit.disabled = cancel.disabled = false;
			});
		});
		preview();
		input.focus();
	}

	onClose(): void { this.contentEl.empty(); }
}
