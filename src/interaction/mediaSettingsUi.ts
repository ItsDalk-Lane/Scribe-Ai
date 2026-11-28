import { Setting } from 'obsidian';
import type ScribeAiPlugin from '../main';
import { availableMediaSelections, selectedMedia, AGENT_PLAN_PROVIDER_ID, type MediaSelection, type MediaSettings } from '../orchestration/settings/mediaSettings';
import { errorText, tr } from './skills/dialog';

type SaveMedia = (update: (current: MediaSettings) => MediaSettings) => Promise<boolean>;

function saveWithStatus(plugin: ScribeAiPlugin, status: HTMLElement): SaveMedia {
	return async (update) => {
		try {
			await plugin.saveMediaSettings(update);
			status.empty();
			return true;
		} catch (error) {
			status.setText(errorText(error));
			return false;
		}
	};
}

function textValue(row: Setting, read: () => string, write: (value: string) => Promise<boolean>, placeholder: string): void {
	row.addText((input) => {
		input.setPlaceholder(placeholder).setValue(read());
		let saving = false;
		input.inputEl.addEventListener('change', () => {
			const value = input.getValue().trim();
			if (saving || value === read()) return;
			saving = true;
			input.setDisabled(true);
			void write(value).then((saved) => { if (saved) input.setValue(read()); }).finally(() => {
				input.setDisabled(false);
				saving = false;
			});
		});
	});
}

export function renderMediaSettings(panel: HTMLElement, plugin: ScribeAiPlugin): void {
	const section = panel.createDiv({ cls: 'scribe-settings-group' });
	section.createDiv({ cls: 'scribe-settings-group-title', text: tr('媒体生成与语音', 'Media generation and speech') });
	const { settings } = plugin.services;
	const providers = new Map(plugin.services.communication?.models.providers().map(({ id, label }) => [id, label]));
	const status = section.createDiv({ cls: 'scribe-settings-description', attr: { role: 'status' } });
	const save = saveWithStatus(plugin, status);
	for (const [kind, name] of [
		['image', tr('图片生成模型', 'Image generation model')],
		['video', tr('视频生成模型', 'Video generation model')],
		['speech-synthesis', tr('语音合成模型', 'Speech synthesis model')],
		['speech-recognition', tr('语音识别模型', 'Speech recognition model')],
		['image-edit', tr('图片编辑模型', 'Image editing model')],
		['video-edit', tr('视频编辑模型', 'Video editing model')],
	] as const) {
		const key = ({ providerId, model }: MediaSelection) => providerId === AGENT_PLAN_PROVIDER_ID ? model : JSON.stringify([providerId, model]);
		const choices = new Map(availableMediaSelections(settings, kind).map((entry) => [key(entry), entry]));
		const selection = () => {
			const selected = selectedMedia(settings, kind) ?? settings.media?.selections?.[kind];
			return selected ? key(selected) : '';
		};
		new Setting(section).setName(name).addDropdown((input) => {
			input.selectEl.setAttribute('aria-label', name);
			for (const [value, { providerId, model }] of choices) {
				const label = settings.communication?.providerNames[providerId] ?? providers.get(providerId) ?? providerId;
				input.addOption(value, `${label} / ${model}`);
			}
			if (selection() && !choices.has(selection())) input.addOption(selection(), tr('已选模型不可用', 'Saved model unavailable'));
			else if (!choices.size) input.addOption('', tr('请先在模型设置中添加', 'Add a model in model settings'));
			if (!choices.size) input.setDisabled(true);
			input.setValue(selection()).onChange(async (selected) => {
				const choice = choices.get(selected);
				if (!choice || selected === selection()
					|| !availableMediaSelections(settings, kind).some((entry) => key(entry) === selected)) return;
				input.setDisabled(true);
				try {
					await save((media) => ({ ...media, selections: { ...media.selections, [kind]: choice } }));
					input.setValue(selection());
				} finally { input.setDisabled(false); }
			});
		});
	}
}

export function renderMediaDirectorySettings(panel: HTMLElement, plugin: ScribeAiPlugin): void {
	const group = panel.createDiv({ cls: 'scribe-settings-group' });
	group.createDiv({ cls: 'scribe-settings-group-title', text: tr('媒体文件保存位置', 'Media output folders') });
	const status = group.createDiv({ cls: 'scribe-settings-description', attr: { role: 'status' } });
	const save = saveWithStatus(plugin, status);
	for (const [field, name] of [['imageDirectory', tr('图片保存目录', 'Image output folder')],
		['videoDirectory', tr('视频保存目录', 'Video output folder')],
		['speechDirectory', tr('生成语音保存目录', 'Generated speech output folder')]] as const) {
		textValue(new Setting(group).setName(name)
			.setDesc(tr('填写库内文件夹的相对路径。留空时，产物保存在对话的私有缓存。', 'Enter a vault-relative folder path. Leave blank to keep outputs in the conversation’s private cache.')),
			() => plugin.services.settings.media?.[field] ?? '', (value) => save((media) => ({ ...media, [field]: value })),
			tr('素材', 'Media'));
	}
}
