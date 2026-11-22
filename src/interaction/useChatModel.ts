import { useCallback, useEffect, useRef, useState } from 'react';
import type ScribeAiPlugin from '../main';
import type { ModelProviderInfo, RunContext, ScribeSettings } from '../types';
import { chatModelKey } from '../orchestration/settings/thinking';
import type { ThinkingSelection } from './components/ThinkingSlider';

export interface ChatModelGroup {
	id: string;
	label: string;
	models: { id: string; value: string; vision?: boolean }[];
}

export function chatModelOptions(
	settings: ScribeSettings,
	providers: () => readonly (Pick<ModelProviderInfo, 'id' | 'label'> & Partial<Pick<ModelProviderInfo, 'models'>>)[],
	selection: Pick<ScribeSettings, 'providerId' | 'model'> = settings,
) {
	const configured = Object.entries(settings.providerModels);
	const catalog = new Map(configured.length ? providers().map((provider) => [provider.id, provider]) : []);
	const displayLabels = new Map<string, number>();
	const groups: ChatModelGroup[] = configured.map(([id, models]) => {
		const provider = catalog.get(id);
		const label = settings.communication.providerNames[id] ?? settings.customProviders[id]?.label ?? provider?.label ?? id;
		displayLabels.set(label, (displayLabels.get(label) ?? 0) + 1);
		return { id, label, models: [...new Set(models)].map((model) => ({
			id: model, value: chatModelKey(id, model), vision: provider?.models?.find((entry) => entry.id === model)?.input.includes('image'),
		})) };
	});
	for (const group of groups) {
		if ((displayLabels.get(group.label) ?? 0) > 1) group.label = `${group.label} · ${group.id}`;
	}
	const active = chatModelKey(selection.providerId, selection.model);
	const value = groups.some(({ models }) => models.some((model) => model.value === active)) ? active : '';
	return { groups, active, value };
}

export function useChatModel(plugin: ScribeAiPlugin, initialModel?: RunContext['model'], scoped = false) {
	const { settings, communication } = plugin.services;
	const read = useCallback((preferred?: RunContext['model']) => {
		const { providerId, model } = preferred ?? settings;
		const options = chatModelOptions(settings, () => communication.models.providers(), { providerId, model });
		const storedLevel = preferred?.reasoning === null ? 'off' : preferred?.reasoning ?? settings.thinkingByModel[options.value];
		const thinking: ThinkingSelection = options.value
			? communication.models.thinkingOptions({ providerId, model }, storedLevel)
			: { levels: [] };
		const choice = options.value ? { providerId, model, reasoning: thinking.level ?? null } : undefined;
		return { ...options, thinking, choice };
	}, [communication, settings]);
	const [options, setOptions] = useState(() => read(scoped && initialModel
		&& settings.providerModels[initialModel.providerId]?.includes(initialModel.model) ? initialModel : undefined));
	const localChoice = useRef<RunContext['model'] | undefined>(options.choice);
	const [saving, setSaving] = useState<'model' | 'thinking' | null>(null);
	const pending = useRef<'model' | 'thinking' | null>(null);
	const latestLevel = useRef<string | undefined>(undefined);
	const [preview, setPreview] = useState<{ key: string; level: string } | null>(null);
	const sync = useCallback(() => {
		const next = read(scoped ? localChoice.current : undefined);
		if (scoped && next.choice) localChoice.current = next.choice;
		setOptions(next);
	}, [read, scoped]);

	useEffect(() => {
		const unsubscribe = plugin.subscribeSettings(sync);
		sync();
		return unsubscribe;
	}, [plugin, sync]);

	function refreshSelection() {
		const { providerId, model } = scoped ? localChoice.current ?? settings : settings;
		const configured = settings.providerModels[providerId]?.includes(model) === true;
		if (options.active === chatModelKey(providerId, model) && Boolean(options.value) === configured) return true;
		sync();
		return false;
	}

	async function selectModel(value: string, thinkingLevel?: string) {
		if (pending.current || (value === options.value && thinkingLevel === undefined)) return;
		for (const group of options.groups) {
			const model = group.models.find((entry) => entry.value === value);
			if (!model) continue;
			pending.current = 'model';
			setSaving('model');
			try {
				const choice = { providerId: group.id, model: model.id };
				await plugin.saveSettings({ ...choice, thinkingLevel });
				if (scoped) {
					localChoice.current = { ...choice, reasoning: thinkingLevel === 'off' ? null : thinkingLevel };
					sync();
				}
			} finally {
				pending.current = null;
				setSaving(null);
			}
			return;
		}
	}

	async function selectThinking(level: string) {
		if (pending.current === 'model' || !options.choice || !refreshSelection()
			|| !options.thinking.levels.includes(level) || level === (latestLevel.current ?? options.thinking.level)) return;
		const { providerId, model } = options.choice;
		latestLevel.current = level;
		setPreview({ key: options.value, level });
		if (pending.current) return;
		pending.current = 'thinking';
		setSaving('thinking');
		try {
			let next = level;
			// 拖动期间只保留排队中的最新一档，当前保存完成后再写入。
			while (true) {
				await plugin.saveSettings({ providerId, model, thinkingLevel: next, keepDefault: scoped });
				if (scoped) {
					localChoice.current = { providerId, model, reasoning: next };
					sync();
				}
				if (!latestLevel.current || latestLevel.current === next) break;
				next = latestLevel.current;
			}
		} finally {
			latestLevel.current = undefined;
			pending.current = null;
			setPreview(null);
			setSaving(null);
		}
	}

	const thinking = preview?.key === options.value ? { ...options.thinking, level: preview.level } : options.thinking;
	return {
		groups: options.groups, value: options.value, thinking, choice: options.choice, saving: saving !== null, selecting: saving === 'model',
		isSaving: () => pending.current !== null, refreshSelection, selectModel, selectThinking,
	};
}
