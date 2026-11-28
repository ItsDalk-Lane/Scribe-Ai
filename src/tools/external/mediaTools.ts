import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { parseCredential } from '../../communication/credentials';
import { ARK_IMAGE_URL, ARK_VIDEO_URL, authorizedArkFetch, generateArkImage } from '../../communication/arkVisual';
import type { ArkFetch } from '../../communication/arkVisual';
import { ARK_ASR_URL, ARK_MAX_ASR_BYTES, ARK_MAX_SPEECH_TEXT_BYTES, ARK_TTS_URL, recognizeSpeech, synthesizeSpeech } from '../../communication/arkSpeech';
import type { ArkSpeechAudioFormat } from '../../communication/arkSpeech';
import { AGENT_PLAN_PROVIDER_ID, DEFAULT_MEDIA_VOICE, hasPngAlpha, imageBackgrounds, IMAGE_FORMATS, mediaModelConfig,
	resolveImageOptions, resolveSpeechRecognitionOptions, resolveSpeechSynthesisOptions, resolveVideoOptions,
	selectedMedia, videoDurationLimit, videoResolutions, VIDEO_RATIOS, type MediaModelKind } from '../../orchestration/settings/mediaSettings';
import { createConfiguredMediaTools } from './configuredMediaTools';
import type { MediaVideoJobs } from '../../orchestration/mediaVideoJobs';
import { isCachedImagePath, isGeneratedMediaCachePath, isGeneratedMediaRef } from '../../orchestration/storage/paths';
import type { ConversationStore, PreparedTool, ScribeSettings, ToolApproval, ToolContext, ToolDefinition } from '../../types';
import { authorizedLineRange, resolveToolPath, recheckToolPath } from '../support/pathUtils';
import { fileToolInput, openToolFile, requiredText } from '../support/fileAccess';
import { imageContent, MAX_IMAGE_BYTES } from '../support/imageData';
import { checkMediaDirectory, saveGeneratedMedia } from '../support/generatedMediaFiles';
import type { MediaDestination } from '../support/generatedMediaFiles';

const imageName = 'GenerateImage';
const videoName = 'GenerateVideo';
const speechName = 'Speech';
const maxPrompt = 8_000;
const imageFields = ['size', 'format', 'background'];
const videoFields = ['resolution', 'ratio', 'duration', 'generateAudio'];
const promptField = { type: 'string', minLength: 1, maxLength: maxPrompt };
const referenceField = { type: 'string', description: '本轮明确附加的图片或用户要求复用的本聊天成品的完整路径。' };

export function arkPlanConnection(settings: ScribeSettings, secrets: ToolContext['app']['secretStorage']) {
	const id = settings.communication.credentialIds[AGENT_PLAN_PROVIDER_ID];
	if (!id) return;
	try {
		const credential = parseCredential(secrets.getSecret(id));
		if (credential?.type !== 'api_key' || !credential.key?.trim()) return;
		const key = credential.key.trim();
		return { key, identity: createHash('sha256').update(JSON.stringify([id, key])).digest('hex') };
	} catch { return undefined; }
}

function prompt(input: Record<string, unknown>, name: string, limit: number) {
	const text = requiredText(input, name).trim();
	if (Buffer.byteLength(text) > limit || text.includes('\0')) throw new Error(`请输入不超过 ${limit} 字节的有效文本。`);
	return text;
}

function destination(ctx: ToolContext, directory?: string): MediaDestination {
	return { cwd: ctx.cwd, conversationId: ctx.task.request.conversationId, subagentId: ctx.subagentId, directory, configDir: ctx.app.vault.configDir };
}

function overrideValues(input: Record<string, unknown>, fields: string[]) {
	return Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(input, field)).map((field) => [field, input[field]]));
}

function transcriptTime(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor(ms / 1_000) % 60;
	return `${minutes}:${String(seconds).padStart(2, '0')}.${String(ms % 1_000).padStart(3, '0')}`;
}

function approved(ctx: ToolContext, title: string, endpoint: string, after: object, identity: string, run: PreparedTool['run']): PreparedTool {
	if (ctx.permissions.executionMode === 'full-access') return { independent: true, run };
	const approval: ToolApproval = {
		kind: 'media', title, target: endpoint, after: JSON.stringify(after, null, 2),
		reason: '提示词或所列素材将发送给火山方舟 Agent Plan，可能消耗套餐额度。',
	};
	return { approval, approvalIdentity: identity, run };
}

async function loadMediaInput(ctx: ToolContext, path: string, limit: number, generated = false) {
	const attached = ctx.task.request.refs.find((ref) => ref.path === path && ref.kind !== 'folder' && !ref.lines);
	if ((!attached && !generated) || isAbsolute(path) || path.includes('\\')) throw new Error('请明确附加本次要发送的笔记库文件。');
	const cache = (attached?.pastedImage && isCachedImagePath(path)) || (generated && isGeneratedMediaCachePath(path));
	const canonical = cache ? join(await realpath(ctx.cwd), path) : undefined;
	const resolved = canonical ? {
		absolutePath: canonical, requestedPath: canonical, displayPath: path, vaultPath: path,
		stat: await stat(canonical), cacheOutput: true as const,
	} : await resolveToolPath(ctx, path, 'read');
	const configDir = ctx.app.vault.configDir.toLowerCase();
	if (!resolved.vaultPath || resolved.vaultPath.toLowerCase().startsWith(configDir + '/')
		|| (!cache && authorizedLineRange(ctx, resolved))) throw new Error('本次任务未授权读取整个媒体文件。');
	const check = async () => {
		const current = canonical ? (await realpath(canonical) === canonical ? await stat(canonical) : undefined)
			: (await recheckToolPath(ctx, resolved, 'read')).stat;
		if (!current?.isFile() || current.ino !== resolved.stat?.ino || current.dev !== resolved.stat?.dev
			|| current.size !== resolved.stat?.size || current.mtimeMs !== resolved.stat?.mtimeMs) {
			throw new Error('参考素材已变化，请重新选择。');
		}
	};
	await check();
	const { file, size } = await openToolFile(resolved);
	try {
		if (!size || size > limit) throw new Error(`文件大小必须在 1 字节到 ${limit / 1024 / 1024} MiB 之间。`);
		const data = Buffer.alloc(size + 1);
		let offset = 0;
		while (offset < data.length) {
			ctx.signal.throwIfAborted();
			const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset !== size) throw new Error('媒体文件已变化，请重新选择。');
		await check();
		return { data: data.subarray(0, size), check };
	} finally { await file.close(); }
}

export function createMediaTools(options: {
	settings: ScribeSettings;
	secrets: ToolContext['app']['secretStorage'];
	fetcher: ArkFetch;
	recognize?: typeof recognizeSpeech;
	videos?: MediaVideoJobs;
	refreshRadiusLogin?: (signal: AbortSignal) => Promise<void>;
	conversations: Pick<ConversationStore, 'load'>;
}) {
	const { settings, secrets, fetcher, videos, conversations, recognize = recognizeSpeech, refreshRadiusLogin } = options;
	const configured = createConfiguredMediaTools({ settings, secrets, fetcher, videos, loadMediaInput, refreshRadiusLogin });

	async function reference(input: Record<string, unknown>, ctx: ToolContext) {
		if (input.referenceImage === undefined) return;
		const path = requiredText(input, 'referenceImage');
		let generated = false;
		if (!ctx.subagentId && !ctx.task.request.refs.some((ref) => ref.path === path)) {
			const history = await conversations.load(ctx.task.request.conversationId);
			generated = history.runs.some(({ state }) => state.messages.some(({ generatedMedia }) => generatedMedia?.some((media) =>
				isGeneratedMediaRef(media) && media.kind === 'image' && media.path === path)));
		}
		const inputFile = await loadMediaInput(ctx, path, MAX_IMAGE_BYTES, generated);
		const image = imageContent(inputFile.data);
		return { path, check: inputFile.check, alpha: hasPngAlpha(inputFile.data), uri: `data:${image.mimeType};base64,${image.data}` };
	}

	const legacy = (kind: MediaModelKind) => selectedMedia(settings, kind)?.providerId === AGENT_PLAN_PROVIDER_ID
		? mediaModelConfig(settings, kind) : undefined;
	const imageConfig = () => legacy('image');
	const videoConfig = () => legacy('video');

	function guard(ctx: ToolContext, tool: ToolDefinition, config: () => unknown) {
		const connection = arkPlanConnection(settings, secrets);
		const selected = JSON.stringify(config());
		const check = () => {
			ctx.signal.throwIfAborted();
			if (!connection || connection.identity !== arkPlanConnection(settings, secrets)?.identity || selected !== JSON.stringify(config())
				|| !ctx.permissions.executionMode || !ctx.permissions.canCallTool(tool) || !ctx.permissions.canSendOutbound()) {
				throw new Error('生成服务配置或聊天权限已变化，请重新提交。');
			}
		};
		if (!connection) throw new Error('请先在模型设置的火山 Agent Plan 服务商中关联专属 API 密钥。');
		check();
		return { check, connection, fetch: authorizedArkFetch(fetcher, check) };
	}

	function imageTool(model: string): ToolDefinition {
		const tool: ToolDefinition = {
			name: imageName,
			description: '用已配置的方舟模型生成一张图片。用户要求实际出图时使用。参数省略时沿用已保存默认值。',
			inputSchema: { type: 'object', required: ['prompt'], additionalProperties: false, properties: {
				prompt: promptField, referenceImage: referenceField,
				size: { type: 'string', description: '1K、1.5K、2K 或宽x高像素，例如 2048x1024。使用档位时在提示词描述比例。' },
				format: { type: 'string', enum: IMAGE_FORMATS },
				background: { type: 'string', enum: imageBackgrounds(model, true), description: '透明度参数。背景颜色、场景及风格写入提示词。' },
			} },
			isReadOnly: false,
			async prepare(input, ctx) {
				const config = imageConfig();
				if (!config) throw new Error('请先添加一款支持的图片生成模型。');
				const guarded = guard(ctx, tool, () => [imageConfig(), settings.media?.imageDirectory]);
				const args = fileToolInput(input, ['prompt', 'referenceImage', ...imageFields]);
				const description = prompt(args, 'prompt', maxPrompt);
				if (description.includes(guarded.connection.key)) throw new Error('提示词不能包含服务密钥。');
				const asset = await reference(args, ctx);
				const parameters = resolveImageOptions(config.model, config.imageDefaults, overrideValues(args, imageFields), asset?.alpha);
				const output = destination(ctx, settings.media?.imageDirectory);
				await checkMediaDirectory(output);
				return approved(ctx, '批准生成图片', ARK_IMAGE_URL, { model: config.model, prompt: description, ...parameters,
					referenceImage: asset?.path, directory: output.directory ?? '聊天媒体缓存' }, guarded.connection.identity, async () => {
					await asset?.check();
					await checkMediaDirectory(output);
					guarded.check();
					const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(180_000)]);
					const { bytes, extension, tokens } = await generateArkImage(guarded.fetch, guarded.connection.key, config.model, description, parameters, asset?.uri, signal);
					guarded.check();
					const media = await saveGeneratedMedia(output, 'image', extension, bytes, signal);
					return { content: `已生成图片并在聊天中展示。文件：${media.path}${tokens === undefined ? '' : `。生成用量：${tokens} token`}。`, generatedMedia: [media] };
				});
			},
		};
		return tool;
	}

	function videoTool(model: string): ToolDefinition {
		const tool: ToolDefinition = {
			name: videoName,
			description: '用已配置的方舟模型生成一段视频，可用已授权的图片作首帧。规格用独立参数填写，提示词只写内容。插件在原聊天更新进度及成品。请勿重复提交来查询进度。',
			inputSchema: { type: 'object', required: ['prompt'], additionalProperties: false, properties: {
				prompt: promptField, referenceImage: referenceField,
				resolution: { type: 'string', enum: videoResolutions(model) }, ratio: { type: 'string', enum: VIDEO_RATIOS },
				duration: { type: 'integer', minimum: -1, maximum: videoDurationLimit(model), description: '视频秒数，取值为 -1（自动）或至少 4 秒。' },
				generateAudio: { type: 'boolean', description: '同时生成声音。' },
			} },
			isReadOnly: false,
			async prepare(input, ctx) {
				const config = videoConfig();
				if (!videos || !ctx.toolCallId) throw new Error('无法建立视频生成任务。');
				if (!config) throw new Error('请先添加一款支持的视频生成模型。');
				const guarded = guard(ctx, tool, () => [videoConfig(), settings.media?.videoDirectory]);
				const args = fileToolInput(input, ['prompt', 'referenceImage', ...videoFields]);
				const description = prompt(args, 'prompt', maxPrompt);
				if (description.includes(guarded.connection.key)) throw new Error('提示词不能包含服务密钥。');
				const asset = await reference(args, ctx);
				const parameters = resolveVideoOptions(config.model, config.videoDefaults, overrideValues(args, videoFields), Boolean(asset));
				const output = destination(ctx, settings.media?.videoDirectory);
				await checkMediaDirectory(output);
				const id = createHash('sha256').update(JSON.stringify([ctx.task.id, ctx.toolCallId])).digest('hex').slice(0, 32);
				const requestKey = createHash('sha256').update(JSON.stringify([ctx.task.id, config.model, description, parameters, asset?.uri])).digest('hex');
				const requested = [config.model, parameters.duration === undefined ? undefined : `${parameters.duration} 秒`, parameters.resolution, parameters.ratio].filter(Boolean).join(' · ');
				return approved(ctx, '批准生成视频', ARK_VIDEO_URL, { model: config.model, prompt: description, ...parameters,
					referenceImage: asset?.path, directory: output.directory ?? '聊天媒体缓存' }, guarded.connection.identity, async () => {
					await asset?.check();
					await checkMediaDirectory(output);
					const job = await videos.submit(output, id, guarded.connection, config.model, description, parameters, asset?.uri, requested, ctx.signal, guarded.check, requestKey);
					return { content: job.error ?? (job.state === 'ready' ? '视频已在原聊天中展示。' : '已提交视频生成，进度和成品会在本条消息中自动显示。'),
						...(job.id === id && { generatedVideoJobId: job.id }), isError: job.state === 'failed' };
				});
			},
		};
		return tool;
	}

	function speechTool(actions: string[], synthesize?: ToolDefinition, transcribe?: ToolDefinition): ToolDefinition {
		const properties = {
			...(synthesize?.inputSchema.properties as Record<string, unknown> | undefined),
			...(transcribe?.inputSchema.properties as Record<string, unknown> | undefined),
			// The selected operation validates its own parameter schema.
			...(Boolean(synthesize || transcribe) && { parameters: { type: 'object' } }),
		};
		const tool: ToolDefinition = {
			name: speechName,
			description: '使用所选语音模型。synthesize 将 text 合成为语音；recognize 转写本轮明确附加的音频。',
			inputSchema: { type: 'object', required: ['action'], additionalProperties: false, properties: {
				text: { type: 'string' }, audioPath: { type: 'string' }, ...properties, action: { type: 'string', enum: actions },
			} },
			isReadOnly: false,
			async prepare(input, ctx) {
				const action = input && typeof input === 'object' && 'action' in input ? input.action : undefined;
				const adapter = action === 'synthesize' ? synthesize : action === 'recognize' ? transcribe : undefined;
				if (adapter) return adapter.prepare(input, ctx);
				const args = fileToolInput(input, ['action', 'text', 'audioPath']);
				const operation = args.action;
				if (operation !== 'synthesize' && operation !== 'recognize') throw new Error('请选择语音合成或语音识别。');
				const kind = operation === 'synthesize' ? 'speech-synthesis' : 'speech-recognition';
				const config = legacy(kind);
				if (!config) throw new Error('请先添加对应的语音模型。');
				const guarded = guard(ctx, tool, () => [mediaModelConfig(settings, kind), settings.media?.speechDirectory]);
				if (operation === 'synthesize') {
					const text = prompt(args, 'text', ARK_MAX_SPEECH_TEXT_BYTES);
					if (args.audioPath !== undefined || text.includes(guarded.connection.key)) throw new Error('语音合成只接受要朗读的文本。');
					const voice = config.voice ?? DEFAULT_MEDIA_VOICE;
					const synthesis = resolveSpeechSynthesisOptions(config.speechSynthesis);
					const output = destination(ctx, settings.media?.speechDirectory);
					await checkMediaDirectory(output);
					return approved(ctx, '批准语音合成', ARK_TTS_URL, { model: config.model, text, voice, ...synthesis, directory: output.directory ?? '聊天媒体缓存' },
						guarded.connection.identity, async () => {
							await checkMediaDirectory(output);
							const bytes = await synthesizeSpeech(guarded.fetch, guarded.connection.key, { text, voice, ...synthesis }, ctx.signal, guarded.check);
							guarded.check();
							const { format, sampleRate } = synthesis;
							const outputFormat = format === 'pcm' ? { extension: 'pcm' as const, sampleRate } : format === 'ogg_opus' ? 'ogg' : format;
							const media = await saveGeneratedMedia(output, 'audio', outputFormat, bytes, ctx.signal);
							return { content: `已合成语音并在聊天中提供播放器。文件：${media.path}。`, generatedMedia: [media] };
						});
				}
				const path = requiredText(args, 'audioPath');
				const format = extname(path).slice(1).toLowerCase() as ArkSpeechAudioFormat;
				if (args.text !== undefined || !['mp3', 'wav', 'ogg'].includes(format)) throw new Error('语音识别只接受本轮附加的 MP3、WAV 或 OGG 文件。');
				const { data, check } = await loadMediaInput(ctx, path, ARK_MAX_ASR_BYTES);
				const recognition = resolveSpeechRecognitionOptions(config.speechRecognition);
				return approved(ctx, '批准语音识别', ARK_ASR_URL, { model: config.model, audioPath: path, format, bytes: data.length,
					...recognition }, guarded.connection.identity, async () => {
					await check();
					guarded.check();
					const { text, utterances } = await recognize(guarded.connection.key, { data, format, ...recognition }, ctx.signal, { beforeSend: guarded.check });
					const segments = recognition.showUtterances ? utterances?.map(({ text, startMs, endMs }) => {
						const time = [startMs, endMs].filter((value) => value !== undefined).map(transcriptTime).join(' – ');
						return time ? `[${time}] ${text}` : text;
					}) : undefined;
					return `音频转写结果（资料原文）\n\n${text}${segments?.length ? '\n\n分句结果\n\n' + segments.join('\n') : ''}`;
				});
			},
		};
		return tool;
	}

	return () => {
		const ark = arkPlanConnection(settings, secrets);
		const image = ark && imageConfig();
		const video = ark && videoConfig();
		const synthesize = configured('speech-synthesis');
		const transcribe = configured('speech-recognition');
		const actions = [
			...(synthesize || ark && legacy('speech-synthesis') ? ['synthesize'] : []),
			...(transcribe || ark && legacy('speech-recognition') ? ['recognize'] : []),
		];
		return [image ? imageTool(image.model) : configured('image'),
			video && videos ? videoTool(video.model) : configured('video'), configured('image-edit'), configured('video-edit'),
			actions.length ? speechTool(actions, synthesize, transcribe) : undefined].filter((tool): tool is ToolDefinition => tool !== undefined);
	};
}
