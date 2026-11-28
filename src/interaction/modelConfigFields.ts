import { DropdownComponent, ToggleComponent } from 'obsidian';
import { ARK_ASR_URL, ARK_TTS_URL } from '../communication/arkSpeech';
import { ARK_IMAGE_URL, ARK_VIDEO_URL } from '../communication/arkVisual';
import { mediaFields, type MediaAdapter, type MediaOperation } from '../communication/mediaApi';
import { DEFAULT_MEDIA_VOICE, IMAGE_FORMATS, IMAGE_SIZES, SPEECH_OUTPUT_FORMATS, VIDEO_RATIOS, imageBackgrounds,
	resolveSpeechRecognitionOptions, resolveSpeechSynthesisOptions, speechSampleRates, videoDurationLimit, videoResolutions }
	from '../orchestration/settings/mediaSettings';
import type { ModelOverride } from '../types';
import { tr } from './skills/dialog';

export const ARK_MEDIA_CONNECTIONS = {
	image: { address: ARK_IMAGE_URL, protocol: 'HTTP' },
	video: { address: ARK_VIDEO_URL, protocol: 'HTTP' },
	'speech-synthesis': { address: ARK_TTS_URL, protocol: 'HTTP' },
	'speech-recognition': { address: ARK_ASR_URL, protocol: 'WebSocket' },
};

export type MediaModelFields = Pick<ModelOverride, 'imageDefaults' | 'videoDefaults' | 'voice' | 'speechSynthesis' | 'speechRecognition'>;

export function mediaOperationLabel(operation: MediaOperation): string {
	const labels: Record<MediaOperation, [string, string]> = {
		image: ['图片生成', 'Image generation'], 'image-edit': ['图片编辑', 'Image editing'],
		video: ['视频生成', 'Video generation'], 'video-edit': ['视频编辑', 'Video editing'],
		'speech-synthesis': ['语音合成', 'Speech synthesis'], 'speech-recognition': ['语音识别', 'Speech recognition'],
	};
	return tr(...labels[operation]);
}

export function formField(container: HTMLElement, label: string, stacked = false): HTMLDivElement {
	const field = container.createDiv({ cls: stacked ? 'scribe-form-field is-stacked' : 'scribe-form-field' });
	field.createEl('label', { text: label });
	return field.createDiv({ cls: 'scribe-form-control' });
}

function selectOption<T extends string>(container: HTMLElement, label: string, options: readonly T[], current: T | undefined,
	change: (value: T | undefined) => void, display: (value: T) => string = (value) => value) {
	const dropdown = new DropdownComponent(formField(container, label));
	dropdown.selectEl.setAttribute('aria-label', label);
	dropdown.addOption('', tr('服务默认', 'Service default'));
	for (const value of options) dropdown.addOption(value, display(value));
	return dropdown.setValue(current ?? '').onChange((value) => change(options.find((option) => option === value)));
}

function renderImageFields(fields: HTMLElement, model: string, draft: MediaModelFields): void {
	const options = draft.imageDefaults ??= {};
	const sizeLabel = tr('图片尺寸', 'Image size');
	const size = options.size;
	const preset = IMAGE_SIZES.find((value) => value === size);
	selectOption(fields, sizeLabel, [...IMAGE_SIZES, 'custom'],
		preset ?? (size ? 'custom' : undefined), (value) => {
			const isCustom = value === 'custom';
			customRow?.toggleClass('scribe-hidden', !isCustom);
			options.size = isCustom ? input.value.trim() || undefined : value;
			if (isCustom) input.focus();
		}, (value) => value === 'custom' ? tr('自定义', 'Custom') : value);
	const customLabel = tr('宽 × 高（像素）', 'Width × height (pixels)');
	const custom = formField(fields, customLabel);
	const customRow = custom.parentElement;
	const input = custom.createEl('input', { cls: 'scribe-full-input', attr: {
		type: 'text', 'aria-label': customLabel, value: size && !preset ? size : '', placeholder: '2048×2048',
	} });
	customRow?.toggleClass('scribe-hidden', !size || Boolean(preset));
	input.addEventListener('input', () => { options.size = input.value.trim() || undefined; });
	selectOption(fields, tr('图片格式', 'Image format'), IMAGE_FORMATS, options.format,
		(value) => { options.format = value; }, (value) => value.toUpperCase());
	selectOption(fields, tr('图片背景', 'Image background'), imageBackgrounds(model), options.background,
		(value) => { options.background = value; }, (value) => {
			if (value === 'auto') return tr('自动', 'Automatic');
			return value === 'transparent' ? tr('透明', 'Transparent') : tr('不透明', 'Opaque');
		});
}

function renderVideoFields(fields: HTMLElement, model: string, draft: MediaModelFields): void {
	const options = draft.videoDefaults ??= {};
	selectOption(fields, tr('视频分辨率', 'Video resolution'), videoResolutions(model), options.resolution,
		(value) => { options.resolution = value; }, (value) => value === '4k' ? '4K' : value);
	const durations = ['-1', ...Array.from({ length: videoDurationLimit(model) - 3 }, (_, index) => String(index + 4))];
	selectOption(fields, tr('视频时长', 'Video duration'), durations, options.duration === undefined ? undefined : String(options.duration),
		(value) => { options.duration = value === undefined ? undefined : Number(value); },
		(value) => value === '-1' ? tr('自动选择时长', 'Automatic duration') : tr(`${value} 秒`, `${value} seconds`));
	selectOption(fields, tr('视频宽高比', 'Video aspect ratio'), VIDEO_RATIOS, options.ratio,
		(value) => { options.ratio = value; }, (value) => value === 'adaptive' ? tr('自动', 'Adaptive') : value);
	const audio = options.generateAudio === undefined ? undefined : options.generateAudio ? 'with-audio' : 'silent';
	selectOption(fields, tr('视频声音', 'Video audio'), ['with-audio', 'silent'], audio,
		(value) => { options.generateAudio = value === undefined ? undefined : value === 'with-audio'; },
		(value) => value === 'with-audio' ? tr('有声', 'With audio') : tr('静音', 'Silent'));
}

function renderSpeechSynthesisFields(fields: HTMLElement, draft: MediaModelFields): void {
	const options = draft.speechSynthesis ??= resolveSpeechSynthesisOptions();
	const voiceLabel = tr('合成音色', 'Synthesis voice');
	const voiceField = formField(fields, voiceLabel);
	const voice = voiceField.createEl('input', { cls: 'scribe-full-input', attr: {
		type: 'text', 'aria-label': voiceLabel, value: draft.voice ?? '', placeholder: DEFAULT_MEDIA_VOICE,
	} });
	voiceField.createDiv({ cls: 'scribe-dialog-muted', text: tr('填入火山 Agent Plan 支持的音色 ID，留空使用服务默认音色。',
		'Enter a voice ID supported by Agent Plan. Leave blank to use the default voice.') });
	voice.addEventListener('input', () => { draft.voice = voice.value.trim() || undefined; });

	const formatLabel = tr('输出格式', 'Output format');
	const format = new DropdownComponent(formField(fields, formatLabel));
	format.selectEl.setAttribute('aria-label', formatLabel);
	for (const value of SPEECH_OUTPUT_FORMATS) format.addOption(value, value === 'ogg_opus' ? 'OGG Opus' : value.toUpperCase());
	format.setValue(options.format);

	const sampleRateLabel = tr('采样率', 'Sample rate');
	const sampleRate = new DropdownComponent(formField(fields, sampleRateLabel));
	sampleRate.selectEl.setAttribute('aria-label', sampleRateLabel);
	const updateSampleRates = () => {
		const rates = speechSampleRates(options.format);
		if (!rates.includes(options.sampleRate)) options.sampleRate = resolveSpeechSynthesisOptions({ format: options.format }).sampleRate;
		sampleRate.selectEl.empty();
		for (const rate of rates) sampleRate.addOption(String(rate), `${rate / 1_000} kHz`);
		sampleRate.setValue(String(options.sampleRate)).setDisabled(rates.length === 1);
	};
	updateSampleRates();
	format.onChange((value) => {
		const chosen = SPEECH_OUTPUT_FORMATS.find((entry) => entry === value);
		if (!chosen) return;
		options.format = chosen;
		updateSampleRates();
	});
	sampleRate.onChange((value) => {
		const rate = Number(value);
		if (speechSampleRates(options.format).includes(rate)) options.sampleRate = rate;
	});

	for (const [key, label] of [['speechRate', tr('语速调整（%）', 'Speech rate adjustment (%)')],
		['loudnessRate', tr('音量调整（%）', 'Volume adjustment (%)')]] as const) {
		const input = formField(fields, label).createEl('input', { cls: 'scribe-full-input', attr: {
			type: 'number', min: '-50', max: '100', step: '1', 'aria-label': label,
			value: String(options[key]), placeholder: '0',
		} });
		input.addEventListener('input', () => { options[key] = input.validity?.badInput ? NaN : Number(input.value); });
	}
}

function renderSpeechRecognitionFields(fields: HTMLElement, draft: MediaModelFields): void {
	const options = draft.speechRecognition ??= resolveSpeechRecognitionOptions();
	for (const [key, label] of [['enablePunctuation', tr('自动标点', 'Automatic punctuation')],
		['normalizeText', tr('文本规范化', 'Text normalization')],
		['showUtterances', tr('分句结果', 'Sentence segments')]] as const) {
		const toggle = new ToggleComponent(formField(fields, label));
		toggle.toggleEl.setAttribute('aria-label', label);
		toggle.setValue(options[key]).onChange((enabled) => { options[key] = enabled; });
	}
}

export function renderMediaModelFields(fields: HTMLElement, model: string, type: keyof typeof ARK_MEDIA_CONNECTIONS, draft: MediaModelFields): void {
	if (type === 'image') renderImageFields(fields, model, draft);
	else if (type === 'video') renderVideoFields(fields, model, draft);
	else if (type === 'speech-synthesis') renderSpeechSynthesisFields(fields, draft);
	else renderSpeechRecognitionFields(fields, draft);
}

export function renderProviderMediaFields(container: HTMLElement, adapter: MediaAdapter, model: string,
	draft: NonNullable<ModelOverride['mediaOptions']>): void {
	const values = draft[adapter.operation] ??= {};
	const operation = mediaOperationLabel(adapter.operation);
	const group = container.createDiv({ cls: 'scribe-dialog-fields', attr: { role: 'group', 'aria-label': operation } });
	group.createDiv({ cls: 'scribe-settings-group-title', text: operation });
	for (const field of mediaFields(adapter, model)) {
		const label = typeof field.label === 'string' ? field.label : tr(...field.label);
		const control = formField(group, label);
		if (field.choices || field.type === 'boolean') {
			const choices = field.choices ?? [true, false];
			const dropdown = new DropdownComponent(control);
			dropdown.selectEl.setAttribute('aria-label', label);
			dropdown.addOption('', field.default === undefined ? tr('服务默认', 'Service default') : String(field.default));
			for (const option of choices) dropdown.addOption(String(option), typeof option === 'boolean'
				? option ? tr('是', 'Yes') : tr('否', 'No') : String(option));
			dropdown.setValue(values[field.key] === undefined ? '' : String(values[field.key])).onChange((value) => {
				const option = choices.find((candidate) => String(candidate) === value);
				if (option === undefined) delete values[field.key];
				else values[field.key] = option;
			});
			continue;
		}
		const number = field.type === 'number';
		const input = control.createEl('input', { cls: 'scribe-full-input', attr: {
			type: number ? 'number' : 'text', 'aria-label': label, value: String(values[field.key] ?? ''),
			placeholder: String(field.default ?? ''), ...(number && { step: 'any' }),
			...(field.min !== undefined && { min: String(field.min) }), ...(field.max !== undefined && { max: String(field.max) }),
		} });
		input.addEventListener('input', () => {
			const text = input.value.trim();
			if (number && input.validity?.badInput) values[field.key] = NaN;
			else if (!text) delete values[field.key];
			else values[field.key] = number ? Number(text) : text;
		});
	}
}
