import type { ConfiguredModelType, ModelCatalogDetails, ModelOverride, ProviderModelInfo, ScribeSettings } from '../../types';
import { SCRIBE_DATA_DIRECTORY } from '../storage/paths';
import { normalizeVaultRelativePath } from '../../tools/support/pathUtils';
import { MEDIA_OPERATIONS, type MediaOperation } from '../../communication/mediaApi';
import { mediaAdapter, mediaModelKind, modelMediaAdapters } from '../../communication/mediaRegistry';

export const AGENT_PLAN_PROVIDER_ID = 'volcengine-agent-plan';
export const DEFAULT_MEDIA_VOICE = 'zh_female_vv_uranus_bigtts';

// https://docs.volcengine.com/docs/ark/agent-plan-personal-visual-models
export const IMAGE_MODELS = ['doubao-seedream-5.5', 'doubao-seedream-5.0-pro', 'doubao-seedream-5.0-flash'] as const;
export const IMAGE_SIZES = ['1K', '1.5K', '2K'] as const;
export const IMAGE_FORMATS = ['png', 'jpeg'] as const;
export const VIDEO_MODELS = ['doubao-seedance-2.5', 'doubao-seedance-2.5-flash', 'doubao-seedance-2.0',
	'doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini'] as const;
export const VIDEO_RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'] as const;

export const MEDIA_MODELS = {
	image: IMAGE_MODELS,
	video: VIDEO_MODELS,
	'speech-synthesis': ['doubao-seed-tts-2.0'],
	'speech-recognition': ['doubao-seed-asr-2.0'],
} satisfies Record<string, readonly [string, ...string[]]>;
export type MediaModelKind = keyof typeof MEDIA_MODELS;
const mediaKinds = Object.keys(MEDIA_MODELS) as MediaModelKind[];
export const CONFIGURED_MODEL_TYPES: readonly ConfiguredModelType[] = [
	'text', 'image', 'video', 'speech-synthesis', 'speech-recognition', 'embedding', 'rerank', 'audio', 'other',
];

export type ImageOptions = { size?: string; format?: 'png' | 'jpeg'; background?: string };
export type VideoOptions = { resolution?: string; duration?: number; ratio?: string; generateAudio?: boolean };
export const SPEECH_OUTPUT_FORMATS = ['mp3', 'wav', 'ogg_opus', 'pcm'] as const;
export type SpeechOutputFormat = typeof SPEECH_OUTPUT_FORMATS[number];
export type SpeechSynthesisOptions = { format: SpeechOutputFormat; sampleRate: number; speechRate: number; loudnessRate: number };
export type SpeechRecognitionOptions = { enablePunctuation: boolean; normalizeText: boolean; showUtterances: boolean };

export interface MediaSettings {
	models?: Partial<Record<MediaModelKind, string>>;
	selections?: Partial<Record<MediaOperation, MediaSelection>>;
	imageDirectory?: string;
	videoDirectory?: string;
	speechDirectory?: string;
}

export interface MediaSelection { providerId: string; model: string }

export function knownMediaModelType(providerId: string, model: string): MediaModelKind | undefined {
	const legacy = arkMediaModelType(providerId, model);
	const adapters = modelMediaAdapters(providerId, model);
	const types = new Set(adapters.map(({ operation }) => mediaModelKind(operation)));
	return legacy ?? (types.size === 1 ? types.values().next().value : undefined);
}

export function arkMediaModelType(providerId: string, model: string): MediaModelKind | undefined {
	if (providerId !== AGENT_PLAN_PROVIDER_ID) return;
	return mediaKinds.find((kind) => MEDIA_MODELS[kind].some((entry) => entry === model));
}

export function confirmedCatalogModelType(details?: ModelCatalogDetails, bundled?: ProviderModelInfo): ConfiguredModelType | undefined {
	if (details?.evidence?.type?.conflict) return undefined;
	return details?.type ?? (bundled ? 'text' : undefined);
}

export function configuredModelType(settings: Pick<ScribeSettings, 'modelOverrides'>, providerId: string, model: string): ConfiguredModelType {
	return knownMediaModelType(providerId, model) ?? settings.modelOverrides[providerId]?.[model]?.type ?? 'text';
}

export function availableMediaModels(settings: Pick<ScribeSettings, 'providerModels'>, kind: MediaModelKind): readonly string[] {
	const configured = settings.providerModels[AGENT_PLAN_PROVIDER_ID] ?? [];
	return MEDIA_MODELS[kind].filter((model) => configured.includes(model));
}

export function mediaModelConfig(settings: Pick<ScribeSettings, 'media' | 'modelOverrides' | 'providerModels'>, kind: MediaModelKind) {
	const current = settings.media?.selections?.[kind];
	const selected = current?.providerId === AGENT_PLAN_PROVIDER_ID ? current.model : settings.media?.models?.[kind];
	const available = availableMediaModels(settings, kind);
	const model = available.find((entry) => entry === selected) ?? available[0];
	if (!model) return undefined;
	const override = settings.modelOverrides[AGENT_PLAN_PROVIDER_ID]?.[model];
	return {
		model,
		imageDefaults: kind === 'image' ? override?.imageDefaults : undefined,
		videoDefaults: kind === 'video' ? override?.videoDefaults : undefined,
		voice: kind === 'speech-synthesis' ? override?.voice : undefined,
		speechSynthesis: kind === 'speech-synthesis' ? override?.speechSynthesis : undefined,
		speechRecognition: kind === 'speech-recognition' ? override?.speechRecognition : undefined,
	};
}

export function availableMediaSelections(settings: Pick<ScribeSettings, 'providerModels' | 'disabledProviderIds'>,
	operation: MediaOperation): MediaSelection[] {
	return Object.entries(settings.providerModels).flatMap(([providerId, models]) => settings.disabledProviderIds.includes(providerId)
		? [] : models.flatMap((model) => mediaAdapter(providerId, model, operation) || arkMediaModelType(providerId, model) === operation
			? [{ providerId, model }] : []));
}

export function selectedMedia(settings: Pick<ScribeSettings, 'providerModels' | 'disabledProviderIds' | 'media' | 'modelOverrides'>,
	operation: MediaOperation): MediaSelection | undefined {
	const choices = availableMediaSelections(settings, operation);
	const selected = settings.media?.selections?.[operation];
	if (selected) return choices.find(({ providerId, model }) => providerId === selected.providerId && model === selected.model);
	const original = operation === 'image-edit' || operation === 'video-edit' ? undefined : mediaModelConfig(settings, operation);
	return choices.find(({ providerId, model }) => providerId === AGENT_PLAN_PROVIDER_ID && model === original?.model) ?? choices[0];
}

export function imageBackgrounds(model: string, alphaReference = false): readonly string[] {
	return model === IMAGE_MODELS[0] ? ['auto', 'opaque', 'transparent'] : alphaReference ? ['opaque', 'transparent'] : ['opaque'];
}

export function videoResolutions(model: string): readonly string[] {
	return model === VIDEO_MODELS[0] || model === VIDEO_MODELS[2] ? ['480p', '720p', '1080p', '4k'] : ['480p', '720p'];
}

function seedance25(model: string): boolean {
	return model === VIDEO_MODELS[0] || model === VIDEO_MODELS[1];
}

export function videoDurationLimit(model: string): number {
	return seedance25(model) ? 30 : 15;
}

function record(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('生成参数必须是对象。');
	return value as Record<string, unknown>;
}

function options(defaults: unknown, overrides: unknown, allowed: readonly string[]): Record<string, unknown> {
	const saved = record(defaults);
	const supplied = Object.entries(record(overrides)).filter(([, value]) => value !== undefined);
	if ([...Object.keys(saved), ...supplied.map(([field]) => field)].some((field) => !allowed.includes(field))) {
		throw new Error('包含未支持的生成参数。');
	}
	return { ...saved, ...Object.fromEntries(supplied) };
}

function option<T>(value: unknown, allowed: readonly T[], name: string): T | undefined {
	if (value === undefined) return;
	const match = allowed.find((entry) => entry === value);
	if (match === undefined) throw new Error(`${name}可选值为 ${allowed.join('、')}。`);
	return match;
}

function imageSize(value: unknown): string | undefined {
	if (value === undefined) return;
	const size = typeof value === 'string' ? value.trim() : '';
	if (IMAGE_SIZES.some((option) => option === size.toUpperCase())) return size.toUpperCase();
	const dimensions = /^([1-9]\d{0,4})\s*[x×]\s*([1-9]\d{0,4})$/iu.exec(size);
	if (dimensions) {
		const width = Number(dimensions[1]);
		const height = Number(dimensions[2]);
		const pixels = width * height;
		if (pixels >= 921_600 && pixels <= 4_624_220 && width <= 16 * height && height <= 16 * width) return `${width}x${height}`;
	}
	throw new Error('图片尺寸可选 1K、1.5K、2K 或宽×高。自定义总像素须在 921600 至 4624220 之间，宽高比须在 1:16 至 16:1 之间。');
}

// https://docs.volcengine.com/docs/ark/image-generation-api
export function resolveImageOptions(model: string, defaults?: ImageOptions,
	overrides?: unknown, alphaReference = false): ImageOptions {
	if (!IMAGE_MODELS.some((entry) => entry === model)) throw new Error('请选择火山 Agent Plan 支持的图片生成模型。');
	const values = options(defaults, overrides, ['size', 'format', 'background']);
	const size = imageSize(values.size);
	const format = option(values.format, IMAGE_FORMATS, '图片格式');
	if (values.background === 'transparent' && model !== IMAGE_MODELS[0] && !alphaReference) {
		throw new Error('Seedream 5.0 生成透明背景需要且仅允许一张带 Alpha 通道的 PNG 参考图。');
	}
	const background = option(values.background, imageBackgrounds(model, alphaReference), '图片背景');
	if (background === 'transparent' && format === 'jpeg') throw new Error('透明背景须使用 PNG 格式。');
	return { ...(size && { size }), ...(format && { format }), ...(background && { background }),
		...(background === 'transparent' && !format && model !== IMAGE_MODELS[0] && { format: 'png' as const }) };
}

// https://docs.volcengine.com/docs/ark/create-video-generation-task-api
export function resolveVideoOptions(model: string, defaults?: VideoOptions, overrides?: unknown, firstFrame = false): VideoOptions {
	if (!VIDEO_MODELS.some((entry) => entry === model)) throw new Error('请选择火山 Agent Plan 支持的视频生成模型。');
	const specified = record(overrides);
	const values = options(defaults, specified, ['resolution', 'duration', 'ratio', 'generateAudio']);
	const resolution = option(typeof values.resolution === 'string' ? values.resolution.toLowerCase() : values.resolution,
		videoResolutions(model), '视频分辨率');
	const { duration, generateAudio } = values;
	const limit = videoDurationLimit(model);
	if (duration !== undefined && (typeof duration !== 'number' || !Number.isInteger(duration) || (duration !== -1 && (duration < 4 || duration > limit)))) {
		throw new Error(`此模型的视频时长须为 4 至 ${limit} 秒的整数，或选自动。`);
	}
	if (generateAudio !== undefined && typeof generateAudio !== 'boolean') throw new Error('视频是否发声须选择是或否。');
	let ratio = option(values.ratio, VIDEO_RATIOS, '视频宽高比');
	if (firstFrame && seedance25(model)) {
		if (specified.ratio !== undefined && ratio !== 'adaptive') throw new Error('Seedance 2.5 首帧生视频的宽高比须设为自动。');
		ratio = 'adaptive';
	}
	return { ...(resolution && { resolution }), ...(duration !== undefined && { duration }), ...(ratio && { ratio }),
		...(generateAudio !== undefined && { generateAudio }) };
}

export function hasPngAlpha(bytes: Uint8Array): boolean {
	const header = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
	return bytes.length >= 33 && header.every((value, index) => bytes[index] === value)
		&& (bytes[24] === 8 || bytes[24] === 16) && (bytes[25] === 4 || bytes[25] === 6);
}

export function normalizeMediaDirectory(value: string): string {
	const entered = value.trim();
	if (!entered) return '';
	const path = normalizeVaultRelativePath(entered);
	if (!path || path.length > 1_024 || /[\\:]/u.test(entered) || Array.from(entered).some((char) => char.charCodeAt(0) < 32)
		|| entered.split('/').includes('..') || path.split('/')[0]!.toLowerCase() === SCRIBE_DATA_DIRECTORY) {
		throw new Error('请输入库内普通文件夹的相对路径，例如「素材/图片」。');
	}
	return path;
}

export function resolveMediaVoice(value?: unknown): string | undefined {
	if (value === undefined) return;
	if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/u.test(value.trim())) throw new Error('请填写火山 Agent Plan 支持的音色 ID。');
	return value.trim();
}

export function speechSampleRates(format: SpeechOutputFormat): readonly number[] {
	return format === 'ogg_opus' ? [48_000] : [8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000];
}

export function resolveSpeechSynthesisOptions(value?: unknown): SpeechSynthesisOptions {
	const input = options(undefined, value, ['format', 'sampleRate', 'speechRate', 'loudnessRate']);
	const format = option(input.format, SPEECH_OUTPUT_FORMATS, '语音输出格式') ?? 'mp3';
	const sampleRate = option(input.sampleRate, speechSampleRates(format), '采样率') ?? (format === 'ogg_opus' ? 48_000 : 24_000);
	const adjustment = (value: unknown, label: string) => {
		if (value === undefined) return 0;
		if (typeof value !== 'number' || !Number.isInteger(value) || value < -50 || value > 100) {
			throw new Error(`${label}须为 -50 至 100 的整数。`);
		}
		return value;
	};
	return { format, sampleRate, speechRate: adjustment(input.speechRate, '语速'), loudnessRate: adjustment(input.loudnessRate, '音量') };
}

export function resolveSpeechRecognitionOptions(value?: unknown): SpeechRecognitionOptions {
	const input = options(undefined, value, ['enablePunctuation', 'normalizeText', 'showUtterances']);
	const choices = [true, false] as const;
	return {
		enablePunctuation: option(input.enablePunctuation, choices, '自动标点') ?? true,
		normalizeText: option(input.normalizeText, choices, '文本规范化') ?? true,
		showUtterances: option(input.showUtterances, choices, '分句结果') ?? false,
	};
}

export function normalizeMediaSettings(raw: unknown, strict = false, legacyOverrides?: ScribeSettings['modelOverrides']): MediaSettings {
	function read<T>(resolve: () => T): T | undefined {
		try { return resolve(); } catch (error) {
			if (strict) throw error;
			return undefined;
		}
	}
	const values = read(() => record(raw)) ?? {};
	const selected = read(() => record(values.models)) ?? {};
	const models: NonNullable<MediaSettings['models']> = {};
	for (const kind of mediaKinds) {
		const model = read(() => option(selected[kind], MEDIA_MODELS[kind], '媒体模型'));
		if (model) models[kind] = model;
	}
	const savedSelections = read(() => record(values.selections)) ?? {};
	const selections: NonNullable<MediaSettings['selections']> = {};
	for (const operation of MEDIA_OPERATIONS) {
		const saved = read(() => record(savedSelections[operation]));
		if (!savedSelections[operation] || !saved) continue;
		const { providerId, model } = saved;
		if (typeof providerId === 'string' && providerId.length <= 128 && typeof model === 'string' && model.length <= 256
			&& (mediaAdapter(providerId, model, operation) || arkMediaModelType(providerId, model) === operation)) selections[operation] = { providerId, model };
		else if (strict) throw new Error('媒体模型不支持所选操作。');
	}
	if (legacyOverrides) {
		const defaults = (model: string, patch: ModelOverride) => {
			const overrides = legacyOverrides[AGENT_PLAN_PROVIDER_ID] ??= {};
			overrides[model] = { ...patch, ...overrides[model] };
		};
		for (const kind of ['image', 'video'] as const) {
			const legacy = read(() => record(values[kind])) ?? {};
			const model = MEDIA_MODELS[kind].find((candidate) => candidate === legacy.model);
			if (model) models[kind] ??= model;
			const archived = read(() => record(legacy.defaultsByModel)) ?? {};
			for (const id of MEDIA_MODELS[kind]) {
				const value = id === model ? legacy.defaults : archived[id];
				if (value === undefined) continue;
				if (kind === 'image') {
					const imageDefaults = read(() => resolveImageOptions(id, undefined, value));
					if (imageDefaults && Object.keys(imageDefaults).length) defaults(id, { imageDefaults });
				} else {
					const videoDefaults = read(() => resolveVideoOptions(id, undefined, value));
					if (videoDefaults && Object.keys(videoDefaults).length) defaults(id, { videoDefaults });
				}
			}
		}
		const voice = read(() => resolveMediaVoice(record(values.speech).voice));
		if (voice) defaults(MEDIA_MODELS['speech-synthesis'][0], { voice });
	}
	const directory = (value: unknown) => {
		if (value === undefined || value === '') return '';
		if (typeof value !== 'string') throw new Error('媒体保存位置须为库内相对路径。');
		return normalizeMediaDirectory(value);
	};
	const imageDirectory = read(() => directory(values.imageDirectory));
	const videoDirectory = read(() => directory(values.videoDirectory));
	const speechDirectory = read(() => directory(values.speechDirectory));
	return { ...(Object.keys(models).length && { models }), ...(Object.keys(selections).length && { selections }),
		...(imageDirectory && { imageDirectory }), ...(videoDirectory && { videoDirectory }), ...(speechDirectory && { speechDirectory }) };
}
