import { Modal, Notice, Setting } from 'obsidian';
import type { FileSystemAdapter } from 'obsidian';
import type ScribeAiPlugin from '../main';
import { createLongTermMemory, type MemoryEntry, type MemoryRun } from '../orchestration/context/longTermMemory';
import { tr } from './skills/dialog';

function editMemory(plugin: ScribeAiPlugin, memory: MemoryRun, entry: MemoryEntry, refresh: () => void) {
	const modal = new Modal(plugin.app).setTitle(entry.topic);
	let summary = entry.summary;
	let content = entry.content;
	new Setting(modal.contentEl).setName(tr('摘要', 'Summary')).addText((input) =>
		input.setValue(summary).onChange((value) => { summary = value; }));
	new Setting(modal.contentEl).setName(tr('正文', 'Notes')).addTextArea((input) =>
		input.setValue(content).onChange((value) => { content = value; }));
	const error = modal.contentEl.createEl('p', { attr: { role: 'alert' } });
	const actions = new Setting(modal.contentEl);
	actions.addButton((button) => button.setButtonText(tr('保存', 'Save')).setCta().onClick(async () => {
		button.setDisabled(true);
		try {
			await memory.save(entry.topic, summary, content, entry, true);
			modal.close();
			refresh();
		} catch (failure) {
			error.setText(failure instanceof Error ? failure.message : String(failure));
		} finally {
			button.setDisabled(false);
		}
	}));
	actions.addButton((button) => button.setButtonText(tr('删除', 'Delete')).onClick(() => {
		const confirm = new Modal(plugin.app).setTitle(tr('删除这条记忆？', 'Delete this memory?'));
		const controls = new Setting(confirm.contentEl);
		controls.addButton((cancel) => cancel.setButtonText(tr('取消', 'Cancel')).onClick(() => confirm.close()));
		controls.addButton((remove) => remove.setButtonText(tr('删除', 'Delete')).onClick(async () => {
			remove.setDisabled(true);
			try {
				await memory.remove(entry.topic, entry, true);
				confirm.close();
				modal.close();
				refresh();
			} catch (failure) {
				confirm.close();
				error.setText(failure instanceof Error ? failure.message : String(failure));
			}
		}));
		confirm.open();
	}));
	modal.open();
}

function manageMemory(plugin: ScribeAiPlugin, memory: MemoryRun) {
	const modal = new Modal(plugin.app).setTitle(tr('管理长期记忆', 'Manage long-term memory'));
	function refresh() {
		modal.contentEl.empty();
		void memory.list().then((entries) => {
			if (!modal.contentEl.isConnected) return;
			if (!entries.length) modal.contentEl.createEl('p', { text: tr('还没有已保存的记忆。', 'No memories saved yet.') });
			for (const { topic, summary, updatedAt } of entries) new Setting(modal.contentEl).setName(topic)
				.setDesc(summary + ' · ' + updatedAt.slice(0, 10)).addButton((button) =>
					button.setButtonText(tr('打开', 'Open')).onClick(async () => {
						try {
							const entry = await memory.read(topic, true);
							if (entry) editMemory(plugin, memory, entry, refresh);
							else refresh();
						} catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
					}));
		}).catch((error: unknown) => {
			if (modal.contentEl.isConnected) modal.contentEl.createEl('p', { text: error instanceof Error ? error.message : String(error) });
		});
	}
	modal.open();
	refresh();
}

export function renderContextPreferences(container: HTMLElement, plugin: ScribeAiPlugin) {
	const { localState } = plugin.services;
	const group = container.createDiv({ cls: 'scribe-settings-group' });
	function toggle(name: string, description: string, get: () => boolean, save: (enabled: boolean) => Promise<void>) {
		new Setting(group).setName(name).setDesc(description).addToggle((input) =>
			input.setValue(get()).onChange(async (enabled) => {
				input.setDisabled(true);
				try { await save(enabled); } catch { new Notice(tr('无法保存设置。', 'Could not save this setting.')); }
				finally { input.setValue(get()).setDisabled(false); }
			}));
	}
	toggle(tr('信任目录规则', 'Trust folder instructions'), tr(
		'允许将此库相关目录中的 AGENTS.md 随当前任务发送给所用模型。请先核对这些文件的来源。',
		'Allow AGENTS.md files in relevant vault folders to be sent to the current model. Review the sources before enabling.',
	), localState.directoryRulesTrusted, localState.saveDirectoryRulesTrust);
	toggle(tr('长期记忆', 'Long-term memory'), tr(
		'在此库保存经你确认的记忆。索引和按需读取的记忆会发给当前模型。文件随笔记库存放。',
		'Save memories you approve in this vault. The index and requested entries are sent to the current model. Memory files are stored with the vault.',
	), localState.memoryEnabled, localState.saveMemoryEnabled);
	toggle(tr('检索此库其他对话', 'Search other conversations in this vault'), tr(
		'开启长期记忆时，允许按关键词将其他已保存对话的短摘录发送给当前模型。',
		'While long-term memory is enabled, allow short keyword-matched excerpts from other saved conversations to be sent to the current model.',
	), localState.vaultHistoryEnabled, localState.saveVaultHistoryEnabled);
	new Setting(group).setName(tr('已保存的记忆', 'Saved memories')).addButton((button) =>
		button.setButtonText(tr('管理', 'Manage')).onClick(() => {
			const root = (plugin.app.vault.adapter as FileSystemAdapter).getBasePath();
			manageMemory(plugin, createLongTermMemory(root, localState));
		}));
}
