import { Setting } from 'obsidian';
import type ScribeAiPlugin from '../main';
import { isProviderEnabled, videoModelFor } from '../orchestration/settings/modelAvailability';
import { chatModelKey } from '../orchestration/settings/thinking';
import type { VideoSourceKind } from '../types';
import { isWebSearchProvider, normalizeWebSearchSettings, WEB_SEARCH_PROVIDERS, type WebSearchSettings } from '../tools/external/webSearchSettings';
import { renderCredentialLink } from './credentialLink';
import { errorText, tr } from './skills/dialog';
import { uiText } from './uiText';

export function renderServiceSettings(panel: HTMLElement, plugin: ScribeAiPlugin): () => void {
	const { settings, webSearch, communication: { models } } = plugin.services;
	const labels = new Map(models.providers().map(({ id, label }) => [id, label]));
	const videoOptions = Object.entries(settings.providerModels).flatMap(([providerId, ids]) => {
		if (!isProviderEnabled(settings, providerId)) return [];
		const provider = settings.communication.providerNames[providerId] ?? labels.get(providerId) ?? providerId;
		return ids.flatMap((model) => {
			const input = models.modelCapabilities?.(providerId, model).videoAnalysis;
			return input ? [{ choice: { providerId, model }, input, label: provider + ' / ' + model }] : [];
		});
	});
	const renderVideoPicker = (kind: VideoSourceKind, name: string, description: string) => {
		const selection = () => {
			const choice = videoModelFor(settings, kind);
			return choice ? chatModelKey(choice.providerId, choice.model) : '';
		};
		const status = panel.createDiv({ cls: 'scribe-settings-description', attr: { role: 'status' } });
		new Setting(panel).setName(name).setDesc(description).addDropdown((dropdown) => {
			const options = new Map<string, NonNullable<typeof settings.videoModel>>();
			dropdown.addOption('', tr('使用聊天模型', 'Use chat model'));
			for (const { choice, input, label } of videoOptions) {
				if (kind === 'file' && input === 'link') continue;
				const key = chatModelKey(choice.providerId, choice.model);
				options.set(key, choice);
				dropdown.addOption(key, input === 'link' ? label + tr('（仅 HTTPS 直链）', ' (HTTPS link only)') : label);
			}
			const saved = selection();
			if (saved && !options.has(saved)) dropdown.addOption(saved, tr('已选模型不可用', 'Saved model unavailable'));
			if (!options.size) status.setText(tr('请先在「模型」中添加并启用支持此类视频输入的模型。',
				'Add and enable a model that accepts this video source under Models.'));
			dropdown.setValue(saved).onChange(async (key) => {
				if (key && !options.has(key)) return;
				dropdown.setDisabled(true);
				try {
					await plugin.saveVideoModel(kind, options.get(key));
					status.empty();
				} catch (error) {
					status.setText(errorText(error));
					dropdown.setValue(selection());
				} finally {
					dropdown.setDisabled(false);
				}
		});
		});
	};
	renderVideoPicker('file', tr('本地视频解析模型', 'Local video analysis model'),
		tr('先用 FFmpeg 检查和转码，再发送视频和当前问题。收到视频回执后，把带时间戳的结果交给聊天模型。',
			'Checks and converts local videos with FFmpeg, then sends the video and current question. Hands timestamped results to chat after video confirmation.'));
	renderVideoPicker('link', tr('链接视频解析模型', 'Linked video analysis model'),
		tr('把公开 HTTPS 视频链接交给专用模型。只收直链的连接打开原链接；其他连接会下载并按需转码。收到回执后才交接结果。',
			'Analyzes public HTTPS video links. Link-only connections open the URL directly. Other connections download and convert as needed. Results require video confirmation.'));
	const current = () => normalizeWebSearchSettings(settings.webSearch);
	let probe: AbortController | undefined;
	let disposed = false;
	const save = async (update: (value: WebSearchSettings) => WebSearchSettings) => {
		try {
			await plugin.saveWebSearchSettings(update);
			return true;
		} catch (error) {
			if (!disposed) status.setText(errorText(error));
			return false;
		}
	};

	new Setting(panel).setName(tr('网页搜索', 'Web search')).setHeading();
	new Setting(panel).setName(tr('启用网页搜索', 'Enable web search'))
		.setDesc(tr('允许支持工具调用的 Agent 根据任务自行搜索。搜索沿用聊天的权限模式。',
			'Let agents with tool access search when needed. Searches follow the chat permission mode.'))
		.addToggle((toggle) => toggle.setValue(current().enabled).onChange(async (enabled) => {
			if (!await save((value) => ({ ...value, enabled }))) toggle.setValue(current().enabled);
		}));
	new Setting(panel).setName(tr('搜索服务商', 'Search provider'))
		.addDropdown((dropdown) => {
			for (const [id, { label }] of Object.entries(WEB_SEARCH_PROVIDERS)) dropdown.addOption(id, label);
			dropdown.setValue(current().provider).onChange(async (selected) => {
				if (!isWebSearchProvider(selected)) return;
				dropdown.setDisabled(true);
				try {
					if (await save((value) => ({ ...value, provider: selected }))) {
						if (!disposed) renderProvider();
					} else dropdown.setValue(current().provider);
				} finally {
					dropdown.setDisabled(false);
				}
			});
		});
	const details = panel.createDiv();
	const status = panel.createDiv({ cls: 'scribe-settings-description', attr: { role: 'status' } });

	function renderProvider() {
		probe?.abort();
		probe = undefined;
		status.empty();
		details.empty();
		const { provider } = current();

		if (provider !== 'exa') {
			const credential = new Setting(details).setName(tr('搜索 API 密钥', 'Search API key'));
			const describeCredential = () => {
				const reuse = current().credentialIds[provider] === undefined && webSearch.isConfigured(provider);
				credential.setDesc(reuse ? tr('正在使用模型设置中关联的密钥。', 'Uses the key linked in model settings.') : '');
			};
			renderCredentialLink(plugin.app, credential.controlEl, credential.nameEl, {
				text: uiText(),
				read: () => webSearch.credentialId(provider) ?? '',
				isLinked: () => webSearch.isConfigured(provider),
				change: async (id) => {
					probe?.abort();
					status.empty();
					await save((config) => ({ ...config, credentialIds: { ...config.credentialIds, [provider]: id || null } }));
					if (!disposed && current().provider === provider) describeCredential();
				},
			});
			describeCredential();
		}

		new Setting(details).setName(tr('测试搜索', 'Test search'))
			.setDesc(tr('发送一次关于 Obsidian 开发文档的公开查询，可能消耗额度。', 'Sends one public query about Obsidian developer docs and may use quota.'))
			.addButton((button) => button.setButtonText(tr('测试', 'Test')).onClick(async () => {
				const controller = probe = new AbortController();
				button.setDisabled(true);
				status.setText(tr('正在搜索…', 'Searching…'));
				try {
					const results = await webSearch.test(provider, controller.signal);
					if (!controller.signal.aborted) status.setText(results.length
						? tr(`成功返回 ${results.length} 条结果。`, `Received ${results.length} results.`)
						: tr('服务已响应，未找到结果。', 'The service responded with no results.'));
				} catch (error) {
					if (!controller.signal.aborted) status.setText(errorText(error));
				} finally {
					if (probe === controller) probe = undefined;
					button.setDisabled(false);
				}
			}));
	}

	renderProvider();
	return () => { disposed = true; probe?.abort(); };
}
