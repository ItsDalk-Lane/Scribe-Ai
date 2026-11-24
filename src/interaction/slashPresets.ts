import type { App } from 'obsidian';
import { parseSlashCommand, readSlashDraft, slashCommandAcceptsArgs } from './slashCommands';
import type { SlashUi } from './slashUi';

export interface Preset {
	label: string;
	content: string;
}

const storageKey = 'scribe-ai:slash-presets';
const presetLimit = 10;
type StoredPresets = (Preset | null)[];
interface PresetStorage {
	read(): StoredPresets | undefined;
	save(update: (current: StoredPresets) => StoredPresets): Promise<void>;
}

export function normalizePresets(stored: unknown): StoredPresets {
	return Array.from({ length: presetLimit }, (_, index) => {
		const value: unknown = Array.isArray(stored) ? stored[index] : undefined;
		if (!value || typeof value !== 'object') return null;
		const { label, content } = value as Partial<Preset>;
		return typeof label === 'string' && typeof content === 'string' && content.trim() && content.length <= 12_000
			? { label, content } : null;
	});
}

export function readLegacyPresets(app: Pick<App, 'loadLocalStorage'>): StoredPresets {
	return normalizePresets(app.loadLocalStorage(storageKey));
}

export function clearLegacyPresets(app: Pick<App, 'saveLocalStorage'>): void {
	app.saveLocalStorage(storageKey, null);
}

export function readPresets(stored: unknown): (Preset | undefined)[] {
	return normalizePresets(stored).map((preset) => preset ?? undefined);
}

export function presetLabel(preset: Preset): string {
	return preset.label || preset.content.slice(0, 60);
}

export async function showSlashPresets(storage: PresetStorage, ui: Pick<SlashUi, 'choose' | 'prompt' | 'confirm'>,
	tr: (zh: string, en: string) => string, createDirectly = false): Promise<string | boolean> {
	const presets = normalizePresets(storage.read());
	const choices = presets.flatMap((preset, index) => preset ? [index] : []);
	const empty = presets.indexOf(null);
	const fullMessage = tr('预设已满，请先删除一条再新建。', 'Preset slots are full. Delete one before creating another.');
	if (empty !== -1) choices.unshift(empty);
	const index = createDirectly ? empty : await ui.choose(tr('命令预设', 'Presets'), choices, (index) => {
		const preset = presets[index];
		return preset ? `${(index + 1) % presetLimit} · ${presetLabel(preset)}` : tr('新建预设', 'New preset');
	});
	if (index === undefined) return false;
	if (index === -1) throw new Error(fullMessage);
	const existing = presets[index];
	const readCurrent = (value: StoredPresets) => {
		const current = normalizePresets(value);
		if (existing && (current[index]?.label !== existing.label || current[index]?.content !== existing.content)) {
			throw new Error(tr('这条预设已更改，请重新打开。', 'This preset changed. Open it again.'));
		}
		return current;
	};
	if (existing) {
		const action = await ui.choose(existing.label || existing.content, ['run', 'edit', 'delete'], (action) =>
			action === 'run' ? tr('运行', 'Run') : action === 'edit' ? tr('编辑', 'Edit') : tr('删除', 'Delete'));
		if (action === undefined) return false;
		if (action === 'run') return existing.content;
		if (action === 'delete') {
			if (!await ui.confirm(tr('删除预设', 'Delete preset'), existing.label || existing.content, tr('删除', 'Delete'))) return false;
			await storage.save((value) => {
				const current = readCurrent(value);
				current[index] = null;
				return current;
			});
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
	await storage.save((value) => {
		const current = readCurrent(value);
		const target = existing ? index : current.indexOf(null);
		if (target === -1) throw new Error(fullMessage);
		current[target] = { label: label.slice(0, 80), content };
		return current;
	});
	return true;
}
