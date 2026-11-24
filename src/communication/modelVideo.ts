import { Buffer } from 'node:buffer';
import type { ModelCatalogDetails, ModelConnection, ModelVideo } from '../types';
import { bedrockVideoModels } from './providerCapabilityEvidence';

export function catalogVideoInput(details?: ModelCatalogDetails): boolean | undefined {
	if (details?.evidence?.videoInput?.conflict) return false;
	return details?.videoInput ?? (details?.evidence?.inputModalities?.conflict ? undefined : details?.inputModalities?.includes('video'));
}

const videoMimes: Record<string, string> = {
	mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
};

export function videoMime(path: string): string | undefined {
	const suffix = /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase();
	return suffix && Object.prototype.hasOwnProperty.call(videoMimes, suffix) ? videoMimes[suffix] : undefined;
}

type VideoFormat = 'gemini' | 'responses' | 'chat' | 'chat-url' | 'bedrock';

export function nativeVideoFormat({ api, baseUrl }: ModelConnection, modelId?: string): VideoFormat | undefined {
	const url = URL.parse(baseUrl);
	if (url?.protocol !== 'https:') return undefined;
	const { hostname } = url;
	const path = url.pathname.replace(/\/$/u, '');
	const ark = hostname === 'ark.cn-beijing.volces.com' && path === '/api/v3';
	const openCode = hostname === 'opencode.ai' && /^\/inference\/(?:go\/)?google\/v1beta$/u.test(path);
	if (api === 'google-generative-ai' && hostname === 'generativelanguage.googleapis.com') return 'gemini';
	if (api === 'google-generative-ai' && openCode) return 'gemini';
	if (api === 'google-vertex' && /^(?:[^.]+-)?aiplatform\.googleapis\.com$/u.test(hostname)) return 'gemini';
	if (api === 'bedrock-converse-stream' && /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/u.test(hostname)
		&& bedrockVideoModels.includes(modelId ?? '')) return 'bedrock';
	if (api === 'openai-responses') {
		if (ark) return 'responses';
		if (hostname === 'openrouter.ai' && path === '/api/v1' || hostname === 'api.meta.ai' && path === '/v1') return 'responses';
	}
	if (api !== 'openai-completions') return undefined;
	if (ark) return 'chat';
	if (hostname === 'api.xiaomimimo.com' && path === '/v1') return 'chat';
	if ((hostname === 'api.moonshot.ai' || hostname === 'api.moonshot.cn') && path === '/v1') return 'chat';
	if (hostname === 'openrouter.ai' && path === '/api/v1') return 'chat';
	if ((hostname === 'api.kimi.com' || hostname === 'api.kimi.ai') && path === '/coding/v1') return 'chat';
	if (path === '/compatible-mode/v1' && (/^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/u.test(hostname)
		|| /^[a-z0-9-]+\.(?:ap-southeast-1|cn-beijing)\.maas\.aliyuncs\.com$/u.test(hostname))) return 'chat';
	if (path === '/v1' && hostname === 'integrate.api.nvidia.com') return 'chat';
	if ((hostname === 'open.bigmodel.cn' || hostname === 'api.z.ai') && /^\/api\/(?:coding\/)?paas\/v4$/u.test(path)) return 'chat-url';
	return undefined;
}

export function videoTakesOnlyUrls(format?: VideoFormat): boolean {
	return format === 'chat-url';
}

export function applyModelVideo(payload: unknown, format: NonNullable<ReturnType<typeof nativeVideoFormat>>,
	marker: string, videos: ModelVideo[]): unknown {
	const fields = payload as {
		messages?: { role: string; content: unknown }[];
		contents?: { role: string; parts: Array<{ text?: string } | { inlineData: { mimeType: string; data: string } }> }[];
		input?: { role: string; content: Array<{ type: string; text?: string; video_url?: string }> }[];
	};
	const videoUrl = ({ mimeType, data, url }: ModelVideo) => url ?? `data:${mimeType};base64,${data}`;
	if (format === 'bedrock') {
		type ContentBlock = { text?: string; video?: { format: string; source: { bytes: Uint8Array } } };
		const messages = fields.messages as { role: string; content: ContentBlock[] }[] | undefined;
		const user = messages?.find(({ role, content }) => role === 'user'
			&& Array.isArray(content) && content.some(({ text }) => text?.startsWith(marker)));
		const text = user?.content.find((part) => part.text?.startsWith(marker));
		if (!user || !text?.text) throw new Error('无法定位发送视频的用户消息。');
		text.text = text.text.slice(marker.length);
		for (const { mimeType, data } of videos) {
			const format = Object.keys(videoMimes).find((key) => videoMimes[key] === mimeType);
			if (!data || !format) throw new Error('这条 Bedrock 连接请使用本地视频附件。');
			user.content.push({ video: { format, source: { bytes: Buffer.from(data, 'base64') } } });
		}
	} else if (format === 'gemini') {
		const parts = fields.contents?.find(({ role, parts }) => role === 'user'
			&& parts.some((part) => 'text' in part && part.text?.startsWith(marker)))?.parts;
		const text = parts?.find((part) => 'text' in part && part.text?.startsWith(marker));
		if (!parts || !text || !('text' in text) || !text.text) throw new Error('无法定位发送视频的用户消息。');
		text.text = text.text.slice(marker.length);
		for (const { mimeType, data } of videos) {
			if (!data || mimeType === 'video/x-matroska') throw new Error('这条 Gemini 连接请使用 MP4、MOV 或 WebM 本地视频。');
			parts.push({ inlineData: { mimeType, data } });
		}
		if (Buffer.byteLength(JSON.stringify(fields)) > 20_000_000) throw new Error('请求内容和视频附件合计超过 Gemini 的 20 MB 限制。');
	} else if (format === 'responses') {
		const user = fields.input?.find(({ role, content }) => role === 'user'
			&& Array.isArray(content) && content.some(({ text }) => text?.startsWith(marker)));
		const text = user?.content.find((part) => part.text?.startsWith(marker));
		if (!user || !text?.text) throw new Error('无法定位发送视频的用户消息。');
		text.text = text.text.slice(marker.length);
		user.content.push(...videos.map((video) => ({ type: 'input_video', video_url: videoUrl(video) })));
	} else {
		for (const message of fields.messages ?? []) {
			if (message.role !== 'user') continue;
			const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
				: message.content as { type: string; text?: string }[] | undefined;
			const part = Array.isArray(content) && content.find((part) => part.type === 'text' && part.text?.startsWith(marker));
			if (!content || !part || !part.text) continue;
			const text = part.text.slice(marker.length);
			message.content = [...content.map((entry) => entry === part ? { ...part, text } : entry), ...videos.map((video) => {
				if (format === 'chat-url' && (!video.url || video.mimeType === 'video/webm')) throw new Error('这条连接请使用 MP4、MOV 或 MKV 的 HTTPS 视频链接。');
				return { type: 'video_url', video_url: { url: videoUrl(video) } };
			})];
			return fields;
		}
		throw new Error('无法定位发送视频的用户消息。');
	}
	return fields;
}
