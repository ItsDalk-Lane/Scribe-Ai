import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type ScribeAiPlugin from '../main';
import type { ModelProviderInfo, ScribeSettings } from '../types';
import { chatModelKey } from '../orchestration/settings/thinking';
import type { ThinkingSelection } from './components/ThinkingSlider';

export interface ChatModelGroup {
	id: string;
	label: string;
	models: { id: string; value: string }[];
}

export function chatModelOptions(
	settings: ScribeSettings,
	providers: () => readonly Pick<ModelProviderInfo, 'id' | 'label'>[],
) {
	const configured = Object.entries(settings.providerModels).filter(([, models]) => models.length > 0);
	const labels = new Map(configured.length ? providers().map(({ id, label }) => [id, label]) : []);
	const displayLabels = new Map<string, number>();
	const groups: ChatModelGroup[] = configured.map(([id, models]) => {
		const label = settings.communication.providerNames[id] ?? settings.customProviders[id]?.label ?? labels.get(id) ?? id;
		displayLabels.set(label, (displayLabels.get(label) ?? 0) + 1);
		return { id, label, models: [...new Set(models)].map((model) => ({ id: model, value: chatModelKey(id, model) })) };
	});
	for (const group of groups) {
		if ((displayLabels.get(group.label) ?? 0) > 1) group.label = `${group.label} · ${group.id}`;
	}
	const active = chatModelKey(settings.providerId, settings.model);
	const value = groups.some(({ models }) => models.some((model) => model.value === active)) ? active : '';
	return { groups, active, value };
}

export function useChatModel(plugin: ScribeAiPlugin) {
	const { settings, communication } = plugin.services;
	const read = useCallback(() => {
		const options = chatModelOptions(settings, () => communication.models.providers());
		const thinking: ThinkingSelection = options.value
			? communication.models.thinkingOptions({ providerId: settings.providerId, model: settings.model }, settings.thinkingByModel[options.value])
			: { levels: [] };
		return { ...options, thinking };
	}, [communication, settings]);
	const [options, setOptions] = useState(read);
	const [saving, setSaving] = useState<'model' | 'thinking' | null>(null);
	const pending = useRef<'model' | 'thinking' | null>(null);
	const latestLevel = useRef<ModelThinkingLevel | undefined>(undefined);
	const [preview, setPreview] = useState<{ key: string; level: ModelThinkingLevel } | null>(null);
	const sync = useCallback(() => setOptions(read()), [read]);

	useEffect(() => {
		const unsubscribe = plugin.subscribeSettings(sync);
		sync();
		return unsubscribe;
	}, [plugin, sync]);

	function refreshSelection() {
		if (options.active === chatModelKey(settings.providerId, settings.model)) return true;
		sync();
		return false;
	}

	async function selectModel(value: string) {
		if (pending.current || value === options.value) return;
		for (const group of options.groups) {
			const model = group.models.find((entry) => entry.value === value);
			if (!model) continue;
			pending.current = 'model';
			setSaving('model');
			try {
				await plugin.saveSettings({ providerId: group.id, model: model.id });
			} finally {
				pending.current = null;
				setSaving(null);
			}
			return;
		}
	}

	async function selectThinking(level: ModelThinkingLevel) {
		if (pending.current === 'model' || !options.thinking.levels.includes(level)) return;
		const { providerId, model } = settings;
		if (options.value !== chatModelKey(providerId, model) || level === (latestLevel.current ?? options.thinking.level)) return;
		latestLevel.current = level;
		setPreview({ key: options.value, level });
		if (pending.current) return;
		pending.current = 'thinking';
		setSaving('thinking');
		try {
			let next: ModelThinkingLevel = level;
			// 拖动期间只保留排队中的最新一档，当前保存完成后再写入。
			while (true) {
				await plugin.saveSettings({ providerId, model, thinkingLevel: next });
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
		groups: options.groups, value: options.value, thinking, saving: saving !== null, selecting: saving === 'model',
		isSaving: () => pending.current !== null, refreshSelection, selectModel, selectThinking,
	};
}
