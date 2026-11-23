import type { App } from 'obsidian';
import { parseSlashCommand, readSlashDraft, slashCommandAcceptsArgs } from './slashCommands';
import type { SlashUi } from './slashUi';

export interface Preset {
	label: string;
	content: string;
}

const storageKey = 'scribe-ai:slash-presets';
const presetLimit = 10;
type PresetStorage = Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>;

export function readPresets(app: PresetStorage): (Preset | undefined)[] {
	const stored: unknown = app.loadLocalStorage(storageKey);
	return Array.from({ length: presetLimit }, (_, index) => {
		const value: unknown = Array.isArray(stored) ? stored[index] : undefined;
		if (!value || typeof value !== 'object') return;
		const { label, content } = value as Partial<Preset>;
		if (typeof label === 'string' && typeof content === 'string' && content.trim() && content.length <= 12_000) return { label, content };
		return undefined;
	});
}

export function presetLabel(preset: Preset): string {
	return preset.label || preset.content.slice(0, 60);
}

export async function showSlashPresets(app: PresetStorage, ui: Pick<SlashUi, 'choose' | 'prompt' | 'confirm'>,
	tr: (zh: string, en: string) => string, createDirectly = false): Promise<string | boolean> {
	const presets = readPresets(app);
	const choices = presets.flatMap((preset, index) => preset ? [index] : []);
	const empty = presets.indexOf(undefined);
	const fullMessage = tr('预设已满，请先删除一条再新建。', 'Preset slots are full. Delete one before creating another.');
	if (empty !== -1) choices.unshift(empty);
	const index = createDirectly ? empty : await ui.choose(tr('命令预设', 'Presets'), choices, (index) => {
		const preset = presets[index];
		return preset ? `${(index + 1) % presetLimit} · ${presetLabel(preset)}` : tr('新建预设', 'New preset');
	});
	if (index === undefined) return false;
	if (index === -1) throw new Error(fullMessage);
	const existing = presets[index];
	if (existing) {
		const action = await ui.choose(existing.label || existing.content, ['run', 'edit', 'delete'], (action) =>
			action === 'run' ? tr('运行', 'Run') : action === 'edit' ? tr('编辑', 'Edit') : tr('删除', 'Delete'));
		if (action === undefined) return false;
		if (action === 'run') return existing.content;
		if (action === 'delete') {
			if (!await ui.confirm(tr('删除预设', 'Delete preset'), existing.label || existing.content, tr('删除', 'Delete'))) return false;
			const current = readPresets(app);
			current[index] = undefined;
			app.saveLocalStorage(storageKey, current);
			return true;
		}
	}
	const content = await ui.prompt(tr('填写一条提示词或斜杠命令', 'Enter one prompt or slash command'), existing?.content, true);
	if (content === undefined) return false;
	if (!content.trim() || content.length > 12_000) throw new Error(tr('请输入 1 到 12000 个字符。', 'Enter between 1 and 12,000 characters.'));
	const command = parseSlashCommand(content);
	if (command?.name === 'presets') throw new Error(tr('预设不能再次打开预设。', 'A preset cannot reopen presets.'));
	if ((!command && readSlashDraft(content)) || (command?.args && !slashCommandAcceptsArgs(command.name))) {
		throw new Error(tr('请输入有效的斜杠命令。', 'Enter a valid slash command.'));
	}
	const label = await ui.prompt(tr('命名预设（可留空）', 'Name the preset (optional)'), existing?.label);
	if (label === undefined) return false;
	const current = readPresets(app);
	const target = existing ? index : current.indexOf(undefined);
	if (target === -1) throw new Error(fullMessage);
	current[target] = { label: label.slice(0, 80), content };
	app.saveLocalStorage(storageKey, current);
	return true;
}
