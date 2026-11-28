import { createHash } from 'node:crypto';
import type { Buffer } from 'node:buffer';
import { basename, extname } from 'node:path';
import { mediaFields, mediaOptions, type MediaAdapter, type MediaCall, type MediaField, type MediaOperation } from '../../communication/mediaApi';
import type { ArkFetch } from '../../communication/arkVisual';
import { mediaAdapter } from '../../communication/mediaRegistry';
import { videoMime } from '../../communication/modelVideo';
import { mediaInstruction } from '../../orchestration/context/videoAttachments';
import { guardedMediaFetch, mediaConnection } from '../../orchestration/settings/mediaConnection';
import { selectedMedia } from '../../orchestration/settings/mediaSettings';
import type { MediaVideoJobs } from '../../orchestration/mediaVideoJobs';
import type { ScribeSettings, ToolContext, ToolDefinition } from '../../types';
import { fileToolInput, requiredText } from '../support/fileAccess';
import { imageContent, MAX_IMAGE_BYTES } from '../support/imageData';
import { checkMediaDirectory, publishMediaOutput } from '../support/generatedMediaFiles';
import { publicImageUrl } from '../support/remoteImage';

const toolNames: Record<MediaOperation, string> = {
	image: 'GenerateImage', 'image-edit': 'EditImage', video: 'GenerateVideo', 'video-edit': 'EditVideo',
	'speech-synthesis': 'Speech', 'speech-recognition': 'Speech',
};
const descriptions: Record<MediaOperation, string> = {
	image: '根据提示词生成图片。',
	'image-edit': '按照提示词编辑一张用户明确提供的原图，并返回新图片。',
	video: '根据提示词生成视频。已提交的任务会自行查询进度。',
	'video-edit': '按照提示词修改用户明确提供的已有视频。已提交的任务会自行查询进度。',
	'speech-synthesis': '把 text 中的文字合成为可播放的音频。',
	'speech-recognition': '转写本轮明确附加的音频文件。',
};
const audioTypes: Readonly<Record<string, string>> = {
	'.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
	'.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm',
};
const promptSchema = { type: 'string', minLength: 1, maxLength: 8_000 };

function fieldSchema(field: MediaField) {
	return {
		type: field.type ?? (typeof field.choices?.[0] === 'number' ? 'number' : 'string'),
		description: typeof field.label === 'string' ? field.label : field.label[0],
		...(field.choices && { enum: field.choices }),
		...(field.min !== undefined && { minimum: field.min }),
		...(field.max !== undefined && { maximum: field.max }),
	};
}

function sourceField(adapter: MediaAdapter) {
	return adapter.input?.endsWith('-url') ? 'sourceUrl'
		: adapter.operation === 'speech-recognition' ? 'audioPath'
			: adapter.input === 'image' && ['image', 'video'].includes(adapter.operation) ? 'referenceImage'
				: adapter.input ? 'sourcePath' : undefined;
}

export function createConfiguredMediaTools({ settings, secrets, fetcher, videos, loadMediaInput, refreshRadiusLogin }: {
	settings: ScribeSettings;
	secrets: ToolContext['app']['secretStorage'];
	fetcher: ArkFetch;
	videos?: MediaVideoJobs;
	loadMediaInput: (ctx: ToolContext, path: string, limit: number) => Promise<{ data: Buffer; check: () => Promise<void> }>;
	refreshRadiusLogin?: (signal: AbortSignal) => Promise<void>;
}) {
	return (operation: MediaOperation): ToolDefinition | undefined => {
		const selection = selectedMedia(settings, operation);
		if (!selection) return;
		const { providerId, model } = selection;
		const adapter = mediaAdapter(providerId, model, operation);
		if (!adapter || !settings.communication.credentialIds[providerId] || (adapter.poll && !videos)) return;
		const route = { providerId, model, operation };
		try { if (!mediaConnection(settings, secrets, route, adapter, Boolean(refreshRadiusLogin))) return; }
		catch { return undefined; }
		const fields = mediaFields(adapter, model);
		const source = sourceField(adapter);
		const requiresSource = source && (adapter.requiresSource ?? (operation.endsWith('-edit') || operation.startsWith('speech-')));
		const prompt = operation === 'speech-recognition' ? undefined : operation === 'speech-synthesis' ? 'text' : 'prompt';
		const properties = {
			...(prompt && { [prompt]: promptSchema }),
			...(source && { [source]: { type: 'string', description: source === 'sourceUrl'
				? '用户本轮明确提供的公开 HTTPS 素材链接。' : '本轮明确附加的完整素材文件路径。' } }),
			...(fields.length > 0 && { parameters: { type: 'object', additionalProperties: false,
				properties: Object.fromEntries(fields.map((field) => [field.key, fieldSchema(field)])) } }),
		};
		const tool: ToolDefinition = {
			name: toolNames[operation], description: `${descriptions[operation]} 当前模型 ${model}。`,
			inputSchema: { type: 'object', additionalProperties: false, properties,
				required: [...(prompt ? [prompt] : []), ...(requiresSource ? [requiresSource] : [])] },
			isReadOnly: false,
			async prepare(input, ctx) {
				const args = fileToolInput(input, ['action', ...Object.keys(properties)]);
				if (providerId === 'radius' && refreshRadiusLogin && ctx.permissions.canCallTool(tool) && ctx.permissions.canSendOutbound()
					&& !mediaConnection(settings, secrets, route, adapter) && mediaConnection(settings, secrets, route, adapter, true)) {
					await refreshRadiusLogin(ctx.signal);
				}
				const connection = mediaConnection(settings, secrets, route, adapter);
				if (!connection) throw new Error('请关联所选媒体服务的可用 API 密钥。');
				const info = settings.modelOverrides[providerId]?.[model]?.mediaOptions?.[operation];
				const savedOptions = JSON.stringify(info);
				const options = mediaOptions(fields, info, args.parameters);
				const promptText = prompt ? requiredText(args, prompt).trim() : '';
				const path = source && args[source] !== undefined ? requiredText(args, source) : undefined;
				if (requiresSource && !path) throw new Error('请附加要处理的原始素材。');
				if (promptText.length > 8_000 || promptText.includes('\0') || JSON.stringify([promptText, path, options]).includes(connection.key)) {
					throw new Error('媒体参数无效或包含服务密钥。');
				}
				let asset: MediaCall['source'];
				let sourceUrl: string | undefined;
				let checkAsset: (() => Promise<void>) | undefined;
				if (path && source === 'sourceUrl') {
					const url = publicImageUrl(path);
					const authorized = [...mediaInstruction(ctx.task.request).matchAll(/https:\/\/[^\s<>\])"'，。]+/gu)]
						.some(([candidate]) => URL.parse(candidate)?.href === URL.parse(path)?.href);
					if (url.protocol !== 'https:' || !authorized) throw new Error('请在本轮消息中明确提供素材的公开 HTTPS 链接。');
					sourceUrl = url.href;
				} else if (path) {
					const { data, check } = await loadMediaInput(ctx, path, adapter.input === 'image' ? MAX_IMAGE_BYTES : 32 * 1024 * 1024);
					const mimeType = adapter.input === 'image' ? imageContent(data).mimeType
						: adapter.input === 'video' ? videoMime(path) : audioTypes[extname(path).toLowerCase()];
					if (!mimeType) throw new Error('所选媒体文件类型无效。');
					asset = { bytes: data, mimeType, filename: basename(path) };
					checkAsset = check;
				}
				const directoryField = operation.startsWith('image') ? 'imageDirectory'
					: operation.startsWith('video') ? 'videoDirectory' : 'speechDirectory';
				const directory = settings.media?.[directoryField];
				const destination = { cwd: ctx.cwd, configDir: ctx.app.vault.configDir,
					conversationId: ctx.task.request.conversationId, subagentId: ctx.subagentId, directory };
				const confirm = () => {
					ctx.signal.throwIfAborted();
					const current = selectedMedia(settings, operation);
					if (!ctx.permissions.executionMode || !ctx.permissions.canCallTool(tool) || !ctx.permissions.canSendOutbound()
						|| current?.providerId !== providerId || current.model !== model
						|| settings.media?.[directoryField] !== directory
						|| JSON.stringify(settings.modelOverrides[providerId]?.[model]?.mediaOptions?.[operation]) !== savedOptions
						|| mediaConnection(settings, secrets, route, adapter)?.identity !== connection.identity) {
						throw new Error('媒体服务设置或聊天权限已变更，请重新提交。');
					}
				};
				confirm();
				if (operation !== 'speech-recognition') await checkMediaDirectory(destination);
				const run = async () => {
					await checkAsset?.();
					if (operation !== 'speech-recognition') await checkMediaDirectory(destination);
					confirm();
					const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(adapter.poll ? 60_000 : 180_000)]);
					let transmitted = false;
					const call: MediaCall = { ...connection, model, prompt: promptText, source: asset, sourceUrl,
						fetch: guardedMediaFetch(fetcher, connection.endpoint, confirm, () => { transmitted = true; }), signal, options };
					if (adapter.poll && videos) {
						if (!ctx.toolCallId) throw new Error('无法建立视频任务。');
						const id = createHash('sha256').update(JSON.stringify([ctx.task.id, ctx.toolCallId])).digest('hex').slice(0, 32);
						const requestKey = createHash('sha256').update(JSON.stringify([ctx.task.id, route, promptText, options, path]))
							.update(asset?.bytes ?? '').digest('hex');
						const job = await videos.submitExternal(destination, id, connection, route, ctx.signal, confirm, requestKey, async () => {
							const result = await adapter.run(call);
							if (!('id' in result)) throw new Error('服务商没有返回视频任务编号。');
							return result.id;
						}, () => transmitted);
						return { content: job.error ?? '视频任务已提交，进度和产物将在原聊天中显示。',
							generatedVideoJobId: job.id, isError: job.state === 'failed' };
					}
					const result = await adapter.run(call);
					confirm();
					if ('text' in result) {
						const text = result.text.replaceAll(connection.key, '[已隐去密钥]').trim();
						if (!text) throw new Error('服务没有返回识别文字。');
						return `音频转写结果（资料原文）\n\n${text}`;
					}
					if ('id' in result) throw new Error('当前媒体连接未提供任务查询接口。');
					const kind = operation.startsWith('image') ? 'image' : operation.startsWith('video') ? 'video' : 'audio';
					const media = await publishMediaOutput(destination, kind, result, signal, () => { confirm(); return Promise.resolve(); });
					return { content: `媒体已保存并在聊天中展示。文件：${media.path}。`, generatedMedia: [media] };
				};
				const safeRun = async () => {
					try { return await run(); }
					catch (error) {
						ctx.signal.throwIfAborted();
						const message = error instanceof Error ? error.message.replaceAll(connection.key, '[已隐去密钥]') : '媒体操作失败。';
						throw new Error(message.slice(0, 480));
					}
				};
				return ctx.permissions.executionMode === 'full-access' ? { independent: true, run: safeRun } : {
					approval: { kind: 'media', title: `批准${descriptions[operation].split('。')[0]}`, target: connection.endpoint,
						after: JSON.stringify({ model, prompt: promptText, ...options, source: path, directory: directory ?? '聊天媒体缓存' }, null, 2),
						reason: `提示词和所列素材将发送给 ${settings.communication.providerNames[providerId] ?? providerId}，可能消耗额度。` },
					approvalIdentity: connection.identity, run: safeRun,
				};
			},
		};
		return tool;
	};
}
