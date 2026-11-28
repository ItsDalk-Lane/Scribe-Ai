import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSettings } from '../settings/defaults';
import { AGENT_PLAN_PROVIDER_ID, IMAGE_MODELS, VIDEO_MODELS, hasPngAlpha, mediaModelConfig, normalizeMediaDirectory,
	normalizeMediaSettings, resolveImageOptions, resolveSpeechRecognitionOptions, resolveSpeechSynthesisOptions, resolveVideoOptions } from '../settings/mediaSettings';

void test('Agent Plan image presets and custom sizes obey the selected Seedream model', () => {
	const [seedream55, seedream50] = IMAGE_MODELS;
	assert.deepEqual(resolveImageOptions(seedream55, { size: '2K', background: 'auto' }, { size: '1280 × 720' }), {
		size: '1280x720', background: 'auto',
	});
	assert.throws(() => resolveImageOptions(seedream55, {}, { size: '1279x720' }), /总像素/u);
	assert.throws(() => resolveImageOptions(seedream55, {}, { size: '4096x250' }), /宽高比/u);
	assert.throws(() => resolveImageOptions(seedream55, { format: 'jpeg' }, { background: 'transparent' }), /PNG/u);
	assert.throws(() => resolveImageOptions(seedream50, {}, { background: 'transparent' }), /Alpha/u);
	assert.deepEqual(resolveImageOptions(seedream50, {}, { background: 'transparent' }, true), { format: 'png', background: 'transparent' });
	assert.throws(() => resolveImageOptions(seedream50, {}, { background: 'auto' }), /图片背景/u);
	assert.throws(() => resolveImageOptions(seedream55, {}, { extra: true }), /未支持/u);
});

void test('Agent Plan video resolution and duration are model-specific and Seedance 2.5 preserves the first frame ratio', () => {
	const [seedance25, seedance25Flash, seedance20] = VIDEO_MODELS;
	assert.deepEqual(resolveVideoOptions(seedance25, { ratio: '16:9', generateAudio: true }, {
		resolution: '4K', duration: 30, generateAudio: false,
	}, true), { resolution: '4k', duration: 30, ratio: 'adaptive', generateAudio: false });
	assert.throws(() => resolveVideoOptions(seedance25, {}, { ratio: '16:9' }, true), /自动/u);
	assert.throws(() => resolveVideoOptions(seedance25Flash, {}, { resolution: '1080p' }), /分辨率/u);
	assert.throws(() => resolveVideoOptions(seedance20, {}, { duration: 16 }), /15 秒/u);
	assert.throws(() => resolveVideoOptions(seedance20, {}, { generateAudio: 'false' }), /发声/u);
	assert.deepEqual(resolveVideoOptions(seedance20, {}, { ratio: '16:9', duration: -1 }, true), { duration: -1, ratio: '16:9' });
});

void test('loading old media settings migrates active and archived per-model defaults, voice and output paths without the old switches', () => {
	const [imageA, imageB, imageC] = IMAGE_MODELS;
	const [videoA, videoB] = VIDEO_MODELS;
	const voice = 'zh_female_vv_uranus_bigtts';
	const legacy = {
		media: {
			image: { model: imageA, enabled: false, defaults: { size: '2K', background: 'transparent' },
				defaultsByModel: { [imageB]: { format: 'jpeg' }, [imageC]: { size: '1.5K' } } },
			video: { model: videoB, enabled: false, defaults: { generateAudio: false },
				defaultsByModel: { [videoA]: { resolution: '4K', duration: 18 } } },
			speech: { synthesize: false, recognize: false, voice },
			imageDirectory: '素材/图片', videoDirectory: '素材/视频', speechDirectory: '素材/配音',
		},
		modelOverrides: { [AGENT_PLAN_PROVIDER_ID]: { [imageC]: { imageDefaults: { size: '1K' } } } },
	};
	const restored = normalizeSettings(JSON.parse(JSON.stringify(legacy)) as Parameters<typeof normalizeSettings>[0]);
	assert.deepEqual(restored.media, { models: { image: imageA, video: videoB }, imageDirectory: '素材/图片',
		videoDirectory: '素材/视频', speechDirectory: '素材/配音' });
	assert.deepEqual(restored.modelOverrides[AGENT_PLAN_PROVIDER_ID], {
		[imageA]: { imageDefaults: { size: '2K', background: 'transparent' } },
		[imageB]: { imageDefaults: { format: 'jpeg' } },
		[imageC]: { imageDefaults: { size: '1K' } },
		[videoA]: { videoDefaults: { resolution: '4k', duration: 18 } },
		[videoB]: { videoDefaults: { generateAudio: false } },
		'doubao-seed-tts-2.0': { voice },
	});
	const reopened = normalizeSettings(JSON.parse(JSON.stringify(restored)) as Parameters<typeof normalizeSettings>[0]);
	assert.deepEqual(reopened, restored);
	assert.deepEqual(reopened.providerModels, {});
	assert.equal(mediaModelConfig(reopened, 'speech-synthesis'), undefined);
	assert.equal(mediaModelConfig(reopened, 'image'), undefined);
	reopened.providerModels[AGENT_PLAN_PROVIDER_ID] = [imageA, 'doubao-seed-tts-2.0', 'doubao-seed-asr-2.0'];
	assert.equal(mediaModelConfig(reopened, 'speech-synthesis')?.voice, voice);
	assert.equal(mediaModelConfig(reopened, 'speech-recognition')?.model, 'doubao-seed-asr-2.0');
	assert.deepEqual(mediaModelConfig(reopened, 'image')?.imageDefaults, { size: '2K', background: 'transparent' });
});

void test('media settings reject cross-type model selections and unsafe directories', () => {
	const configured = { models: { image: IMAGE_MODELS[0] }, imageDirectory: '素材/图片' };
	assert.deepEqual(normalizeMediaSettings({ ...configured, models: { ...configured.models, video: IMAGE_MODELS[0] } }), configured);
	assert.throws(() => normalizeMediaSettings({ models: { video: IMAGE_MODELS[0] } }, true), /媒体模型/u);
	assert.deepEqual(normalizeMediaSettings({ ...configured, videoDirectory: '../private' }), configured);
	assert.throws(() => normalizeMediaSettings({ ...configured, videoDirectory: '../private' }, true), /相对路径/u);
	assert.equal(normalizeMediaDirectory('  '), '');
	for (const path of ['.scribe-ai/cache', '/tmp', 'C:folder', 'a/../b', 'a\\b']) {
		assert.throws(() => normalizeMediaDirectory(path), /相对路径/u);
	}
});

void test('voice defaults remain compatible and validated synthesis and recognition options reopen on their respective models', () => {
	assert.deepEqual(resolveSpeechSynthesisOptions(), { format: 'mp3', sampleRate: 24_000, speechRate: 0, loudnessRate: 0 });
	assert.deepEqual(resolveSpeechRecognitionOptions(), { enablePunctuation: true, normalizeText: true, showUtterances: false });
	const tts = 'doubao-seed-tts-2.0';
	const asr = 'doubao-seed-asr-2.0';
	const voice = 'zh_female_vv_uranus_bigtts';
	const speechSynthesis = resolveSpeechSynthesisOptions({ format: 'ogg_opus', speechRate: -50, loudnessRate: 100 });
	const speechRecognition = resolveSpeechRecognitionOptions({ enablePunctuation: false, normalizeText: false, showUtterances: true });
	assert.equal(speechSynthesis.sampleRate, 48_000);
	assert.throws(() => resolveSpeechSynthesisOptions({ format: 'ogg_opus', sampleRate: 24_000 }), /采样率/u);
	assert.throws(() => resolveSpeechSynthesisOptions({ speechRate: 101 }), /语速/u);
	assert.throws(() => resolveSpeechSynthesisOptions({ loudnessRate: 2.5 }), /音量/u);
	assert.throws(() => resolveSpeechRecognitionOptions({ showUtterances: 'false' }), /分句结果/u);
	const settings = normalizeSettings({
		providerModels: { [AGENT_PLAN_PROVIDER_ID]: [tts, asr] },
		modelOverrides: { [AGENT_PLAN_PROVIDER_ID]: { [tts]: { voice, speechSynthesis, speechRecognition }, [asr]: { speechRecognition } } },
	});
	const reopened = normalizeSettings(JSON.parse(JSON.stringify(settings)) as Parameters<typeof normalizeSettings>[0]);
	assert.deepEqual(reopened.modelOverrides[AGENT_PLAN_PROVIDER_ID], { [tts]: { voice, speechSynthesis }, [asr]: { speechRecognition } });
	assert.equal(mediaModelConfig(reopened, 'speech-synthesis')?.voice, voice);
	assert.deepEqual(mediaModelConfig(reopened, 'speech-synthesis')?.speechSynthesis, speechSynthesis);
	assert.deepEqual(mediaModelConfig(reopened, 'speech-recognition')?.speechRecognition, speechRecognition);
});

void test('switching generation models uses independent defaults and restores the last settings for each model', () => {
	const [imageA, imageB] = IMAGE_MODELS;
	const [videoA, videoB] = VIDEO_MODELS;
	const restored = normalizeSettings({
		providerModels: { [AGENT_PLAN_PROVIDER_ID]: [imageA, imageB, videoA, videoB] },
		media: { models: { image: imageB, video: videoB } },
		modelOverrides: { [AGENT_PLAN_PROVIDER_ID]: {
			[imageA]: { imageDefaults: { size: '2K', background: 'transparent' } },
			[imageB]: { imageDefaults: { format: 'jpeg' } },
			[videoA]: { videoDefaults: { duration: 10, generateAudio: false } },
		} },
	});
	assert.deepEqual(mediaModelConfig(restored, 'image')?.imageDefaults, { format: 'jpeg' });
	assert.equal(mediaModelConfig(restored, 'video')?.videoDefaults, undefined);
	restored.media = { models: { image: imageA, video: videoA } };
	assert.deepEqual(mediaModelConfig(restored, 'image')?.imageDefaults, { size: '2K', background: 'transparent' });
	assert.deepEqual(mediaModelConfig(restored, 'video')?.videoDefaults, { duration: 10, generateAudio: false });
	restored.media.models!.image = imageB;
	assert.deepEqual(mediaModelConfig(restored, 'image')?.imageDefaults, { format: 'jpeg' });
});

void test('PNG with an explicit alpha channel is distinguished from RGB PNG and arbitrary bytes', () => {
	const header = Uint8Array.from({ length: 33 }, (_, index) => [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82][index] ?? 0);
	header[24] = 8;
	header[25] = 6;
	assert.equal(hasPngAlpha(header), true);
	header[25] = 2;
	assert.equal(hasPngAlpha(header), false);
	header[25] = 6;
	assert.equal(hasPngAlpha(header.slice(1)), false);
});
