import { ButtonComponent, DropdownComponent, Modal, Notice, Setting } from 'obsidian';
import type ScribeAiPlugin from '../main';
import { BUILTIN_SUBAGENT_ROLES, DEFAULT_SUBAGENT_SETTINGS, normalizeSubagentRole } from '../orchestration/settings/subagentSettings';
import { chatModelKey } from '../orchestration/settings/thinking';
import type { SubagentRole, SubagentSettings } from '../types';
import { confirmAction } from './ConfirmModal';
import { subagentSettingsText } from './subagentSettingsText';
import { thinkingLabel, type UiText } from './uiText';
import { chatModelOptions } from './useChatModel';

type UpdateSettings = (change: (current: SubagentSettings) => SubagentSettings) => Promise<boolean>;

export function renderSubagentSettings(container: HTMLElement, plugin: ScribeAiPlugin, text: UiText): void {
	const copy = subagentSettingsText();
	const { settings } = plugin.services;
	const current = () => settings.subagents ?? DEFAULT_SUBAGENT_SETTINGS;
	const update: UpdateSettings = async (change) => {
		const previous = settings.subagents;
		const next = change(current());
		settings.subagents = next;
		try {
			await plugin.saveSettings();
			return true;
		} catch {
			if (settings.subagents === next) settings.subagents = previous;
			new Notice(text.saveFailed);
			return false;
		}
	};
	new Setting(container).setName(copy.mode).setDesc(copy.modeDescription).addDropdown((dropdown) => {
		for (const mode of ['auto', 'explicit', 'off'] as const) dropdown.addOption(mode, copy[mode]);
		dropdown.setValue(current().mode).onChange(async (mode) => {
			if (mode !== 'auto' && mode !== 'explicit' && mode !== 'off') return;
			dropdown.setDisabled(true);
			await update((value) => ({ ...value, mode }));
			dropdown.setValue(current().mode).setDisabled(false);
		});
	});

	const numberSetting = (key: 'maxConcurrent' | 'maxDepth', label: string, description = '') => {
		new Setting(container).setName(label).setDesc(description).addText((input) => {
			input.setValue(String(current()[key]));
			input.inputEl.type = 'number';
			input.inputEl.min = '1';
			input.inputEl.step = '1';
			input.inputEl.setAttribute('aria-label', label);
			const saveNumber = async () => {
				const value = input.inputEl.valueAsNumber;
				if (Number.isSafeInteger(value) && value >= 1 && value !== current()[key]) {
					input.setDisabled(true);
					await update((settings) => ({ ...settings, [key]: value }));
					input.setDisabled(false);
				}
				input.setValue(String(current()[key]));
			};
			input.inputEl.addEventListener('change', () => void saveNumber());
		});
	};
	numberSetting('maxConcurrent', copy.concurrency);
	numberSetting('maxDepth', copy.depth, copy.depthDescription);

	const heading = new Setting(container).setName(copy.roles).setHeading();
	const list = container.createDiv();
	const edit = (role?: SubagentRole, custom = false) => openRoleEditor(plugin, text, update, renderRoles, role, custom);
	const renderRoles = () => {
		list.empty();
		const custom = new Map(current().roles.map((role) => [role.name, role]));
		const roles = new Map(BUILTIN_SUBAGENT_ROLES.map((role) => [role.name, role]));
		for (const role of custom.values()) roles.set(role.name, role);
		for (const role of roles.values()) {
			const isCustom = custom.has(role.name);
			const description = isCustom ? role.description : `${copy.builtIn} · ${role.description}`;
			const row = new Setting(list).setName(role.name).setDesc(description)
				.addButton((button) => button.setButtonText(copy.editRole).onClick(() => edit(role, isCustom)));
			if (isCustom) row.addExtraButton((button) => button.setIcon('trash-2').setTooltip(copy.removeRole).onClick(() => {
				confirmAction(plugin.app, {
					title: copy.removeRole,
					message: copy.removeRoleQuestion.replace('{role}', () => role.name),
					confirmText: text.remove,
					cancelText: text.cancel,
					onConfirm: async () => {
						if (await update((settings) => ({ ...settings, roles: settings.roles.filter(({ name }) => name !== role.name) }))) {
							renderRoles();
						}
					},
				});
			}));
		}
	};
	heading.addButton((button) => button.setButtonText(copy.addRole).onClick(() => edit()));
	renderRoles();
}

function openRoleEditor(
	plugin: ScribeAiPlugin, text: UiText, update: UpdateSettings, refresh: () => void,
	role: SubagentRole | undefined, custom: boolean,
): void {
	const copy = subagentSettingsText();
	const { settings, communication } = plugin.services;
	const draft: SubagentRole = role ? { ...role } : { name: '', description: '', instructions: '' };
	const modal = new Modal(plugin.app);
	modal.modalEl.addClass('scribe-role-modal');
	modal.setTitle(role ? copy.editRole : copy.addRole);
	const content = modal.contentEl;
	new Setting(content).setName(copy.roleName).addText((input) => {
		input.inputEl.setAttribute('aria-label', copy.roleName);
		input.setValue(draft.name).onChange((value) => { draft.name = value; });
	});
	new Setting(content).setName(copy.roleDescription).addText((input) => {
		input.inputEl.setAttribute('aria-label', copy.roleDescription);
		input.setValue(draft.description).onChange((value) => { draft.description = value; });
	});
	new Setting(content).setName(copy.roleInstructions).addTextArea((input) => {
		input.inputEl.setAttribute('aria-label', copy.roleInstructions);
		input.inputEl.rows = 4;
		input.setValue(draft.instructions).onChange((value) => { draft.instructions = value; });
	});
	new Setting(content).setName(copy.readOnly).setDesc(copy.readOnlyDescription).addToggle((input) => {
		input.setValue(draft.readOnly === true).onChange((value) => { draft.readOnly = value; });
	});

	const choices = chatModelOptions(settings, () => communication.models.providers()).groups;
	const modelRow = new Setting(content).setName(text.models);
	const model = new DropdownComponent(modelRow.controlEl).addOption('', copy.inheritedModel);
	model.selectEl.setAttribute('aria-label', text.models);
	for (const group of choices) {
		for (const option of group.models) model.addOption(option.value, `${group.label} · ${option.id}`);
	}
	if (draft.model) {
		const key = chatModelKey(draft.model.providerId, draft.model.model);
		if (!settings.providerModels[draft.model.providerId]?.includes(draft.model.model)) {
			model.addOption(key, `${draft.model.model} · ${copy.unavailableModel}`);
			const unavailable = model.selectEl.options[model.selectEl.options.length - 1];
			if (unavailable) unavailable.disabled = true;
		}
		model.setValue(key);
	}
	const effort = new DropdownComponent(new Setting(content).setName(text.thinkingLevel).controlEl);
	effort.selectEl.setAttribute('aria-label', text.thinkingLevel);
	const syncModel = () => {
		const selection = draft.model;
		const levels = selection ? communication.models.thinkingOptions(selection).levels : [];
		const provider = selection && (choices.find(({ id }) => id === selection.providerId)?.label ?? selection.providerId);
		modelRow.setDesc(provider ? copy.providerNotice.replace('{provider}', () => provider) : '');
		effort.selectEl.empty();
		effort.addOption('', copy.defaultEffort);
		for (const level of levels) effort.addOption(level, thinkingLabel(text, level));
		const chosen = selection?.reasoning === null ? 'off' : selection?.reasoning ?? '';
		effort.setValue(levels.includes(chosen) ? chosen : '').setDisabled(!levels.length);
	};
	model.onChange((value) => {
		const provider = choices.find(({ models }) => models.some((option) => option.value === value));
		const selected = provider?.models.find((option) => option.value === value);
		draft.model = provider && selected ? { providerId: provider.id, model: selected.id } : undefined;
		syncModel();
	});
	effort.onChange((value) => {
		if (draft.model) draft.model = { ...draft.model, reasoning: value || undefined };
	});
	syncModel();

	const actions = content.createDiv({ cls: 'scribe-modal-actions is-end' });
	new ButtonComponent(actions).setButtonText(text.cancel).onClick(() => modal.close());
	const save = new ButtonComponent(actions).setCta().setButtonText(text.save);
	save.onClick(async () => {
		const normalized = normalizeSubagentRole(draft);
		if (!normalized) { new Notice(copy.invalidRole); return; }
		const oldName = custom ? role?.name : undefined;
		if (settings.subagents?.roles.some(({ name }) => name === normalized.name && name !== oldName)) {
			new Notice(copy.duplicateRole);
			return;
		}
		const selection = normalized.model;
		if (selection && !settings.providerModels[selection.providerId]?.includes(selection.model)) {
			new Notice(copy.unavailableModel);
			return;
		}
		save.setDisabled(true);
		const saved = await update((settings) => ({
			...settings,
			roles: oldName === undefined ? [...settings.roles, normalized]
				: settings.roles.map((entry) => entry.name === oldName ? normalized : entry),
		}));
		save.setDisabled(false);
		if (saved) {
			refresh();
			modal.close();
		}
	});
	modal.open();
}
