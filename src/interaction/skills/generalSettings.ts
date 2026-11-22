import { Modal, Notice, Setting } from 'obsidian';
import type ScribeAiPlugin from '../../main';
import type { SkillSettings } from '../../types';
import { externalReferenceAt, pickExternalReference } from '../externalReferencePicker';
import { tr, errorText } from './dialog';

export function renderSkillPreferences(plugin: ScribeAiPlugin, container: HTMLElement) {
	const { settings, orchestration } = plugin.services;
	const prefs = () => orchestration.skills.options();
	async function update(patch: Partial<SkillSettings>) {
		const old = prefs();
		const next = { ...old, ...patch };
		settings.skillSettings = next;
		try { await plugin.saveSettings(); orchestration.skills.notify(); }
		catch (cause) { if (settings.skillSettings === next) settings.skillSettings = old; new Notice(errorText(cause)); }
	}
	const roots = container.createDiv();
	async function add(path: string) {
		await externalReferenceAt(path, 'folder');
		const canonical = await orchestration.skills.sharedDirectory(path);
		if (!prefs().sharedDirectories.includes(canonical)) await update({ sharedDirectories: [...prefs().sharedDirectories, canonical] });
		drawRoots();
	}
	function manual() {
		const modal = new Modal(plugin.app);
		modal.setTitle(tr('添加共享技能文件夹', 'Add shared skills folder'));
		let path = '';
		new Setting(modal.contentEl).setName(tr('文件夹完整路径', 'Full folder path')).addText((input) => input.onChange((value) => { path = value; }));
		const msg = modal.contentEl.createEl('p', { attr: { role: 'alert' } });
		new Setting(modal.contentEl).addButton((button) => button.setButtonText(tr('添加', 'Add')).onClick(async () => {
			try { await add(path.trim()); modal.close(); } catch (e) { msg.setText(errorText(e)); }
		}));
		modal.open();
	}
	function drawRoots() {
		roots.empty();
		new Setting(roots).setName(tr('从共享文件夹读取技能', 'Read skills from shared folders'))
			.setDesc(tr('选择存放技能的文件夹。这里的技能可直接引用；创建或安装技能时也可选择保存到这里。', 'Select a folder containing skills. You can use its skills directly and choose it as a destination when creating or installing a skill.'))
			.addButton((button) => button.setButtonText(tr('添加文件夹', 'Add folder')).onClick(async () => {
				let selected;
				try { selected = await pickExternalReference(container.ownerDocument, 'folder', tr('选择共享技能目录', 'Choose shared skills folder')); }
				catch { manual(); return; }
				if (selected) { try { await add(selected.path); } catch (e) { new Notice(errorText(e)); } }
			}));
		for (const path of prefs().sharedDirectories) new Setting(roots).setName(path)
			.addExtraButton((button) => button.setIcon('x').setTooltip(tr('移除目录', 'Remove folder')).onClick(async () => {
				await update({ sharedDirectories: prefs().sharedDirectories.filter((item) => item !== path) }); drawRoots();
			}));
	}
	drawRoots();
	const numberField = (key: 'catalogBudgetPercent' | 'catalogBudgetMaxTokens', name: string, description: string, step: string, valid: (value: number) => boolean) => {
		new Setting(container).setName(name).setDesc(description).addText((input) => {
			input.inputEl.type = 'number';
			input.inputEl.step = step;
			input.inputEl.min = key === 'catalogBudgetPercent' ? '0.01' : '1';
			if (key === 'catalogBudgetPercent') input.inputEl.max = '100';
			input.setValue(String(prefs()[key]));
			const save = () => {
				const value = Number(input.getValue());
				if (valid(value)) { if (prefs()[key] !== value) void update({ [key]: value }).then(() => input.setValue(String(prefs()[key]))); }
				else { input.setValue(String(prefs()[key])); new Notice(tr('请输入范围内的有效数值。', 'Enter a number within the allowed range.')); }
			};
			input.inputEl.addEventListener('blur', save);
			input.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.inputEl.blur(); });
		});
	};
	numberField('catalogBudgetPercent', tr('可用上下文占比（%）', 'Context share (percent)'), tr('技能目录可以使用的模型上下文比例。默认 2%。', 'Share of the model context used for the catalog. Default is 2%.'), '0.5', (value) => Number.isFinite(value) && value > 0 && value <= 100);
	numberField('catalogBudgetMaxTokens', tr('最多使用的词元数', 'Absolute token maximum'), tr('模型可以接收的技能目录大小上限。默认 10000。', 'Maximum catalog size even with a large context window. Default is 10,000 tokens.'), '1', (value) => Number.isSafeInteger(value) && value > 0);
}
