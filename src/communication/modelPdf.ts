import { Buffer } from 'node:buffer';
import type { ModelCatalogDetails, ModelConnection, ModelInputModality } from '../types';

export const MAX_PDF_BYTES = 12 * 1024 * 1024;
const mimeType = 'application/pdf';
type PdfFormat = 'gemini' | 'messages' | 'responses' | 'chat';

export function nativePdfFormat(connection: ModelConnection): PdfFormat | undefined {
	const { api, baseUrl, issue } = connection;
	const url = URL.parse(baseUrl);
	if (issue || url?.protocol !== 'https:' || url.port || url.username || url.password) return undefined;
	const { hostname } = url;
	const path = url.pathname.replace(/\/$/u, '');
	const openCode = hostname === 'opencode.ai' && path.match(/^\/inference\/(?:go\/)?(.+)$/u)?.[1];
	if (api === 'google-generative-ai' && (hostname === 'generativelanguage.googleapis.com' || openCode === 'google/v1beta')) return 'gemini';
	if (api === 'google-vertex' && /^(?:[^.]+-)?aiplatform\.googleapis\.com$/u.test(hostname)) return 'gemini';
	if (api === 'anthropic-messages' && (hostname === 'api.anthropic.com' || openCode === 'anthropic')) return 'messages';
	const openai = hostname === 'api.openai.com' && path === '/v1';
	const ark = hostname === 'ark.cn-beijing.volces.com' && path === '/api/v3';
	const openRouter = hostname === 'openrouter.ai' && path === '/api/v1';
	if (api === 'openai-responses' && (openai || ark || openRouter || openCode === 'openai/v1')) return 'responses';
	if (api === 'openai-completions' && (openai || ark || openRouter)) return 'chat';
	return undefined;
}

export function supportsPdfInput(connection: ModelConnection, model: string, imageInput: boolean,
	details?: ModelCatalogDetails, override?: readonly ModelInputModality[]): PdfFormat | undefined {
	const format = nativePdfFormat(connection);
	if (!format) return undefined;
	if (override) return override.includes('pdf') ? format : undefined;
	if (details?.evidence?.inputModalities?.conflict) return undefined;
	if (details?.inputModalities?.includes('pdf')) return format;
	// https://ai.google.dev/gemini-api/docs/document-processing
	// https://platform.claude.com/docs/en/build-with-claude/pdf-support
	// https://developers.openai.com/api/docs/guides/file-inputs
	// https://console.volcengine.com/ark/region:cn-beijing/docs/document-understanding
	const hostname = new URL(connection.baseUrl).hostname;
	if (format === 'gemini' && (imageInput && /^gemini-[234][.-]/u.test(model)
		|| /^gemini-4-(?:argon|carbon|hydrogen|neon)$/u.test(model))) return format;
	if (format === 'messages' && /^claude-(?:opus|sonnet|haiku|fable)-[45](?:-|$)/u.test(model)) return format;
	if ((hostname === 'api.openai.com' || hostname === 'opencode.ai') && imageInput && /^(?:gpt-[456]|o[134](?:-|$))/u.test(model)) return format;
	if (hostname === 'ark.cn-beijing.volces.com' && model === 'doubao-seed-2-1-pro-260915') return format;
	return undefined;
}

type Part = { text?: string } & Record<string, unknown>;
type MessageParts = { role: string; content: string | Part[] };

export function redactPdfError(error?: string): string | undefined {
	return error?.replace(/data:application\/pdf;base64,[A-Za-z0-9+/=]*|JVBERi0[A-Za-z0-9+/=]*|[A-Za-z0-9+/]{80,}={0,2}/gu, '[PDF]');
}

export function applyModelPdf(payload: unknown, format: PdfFormat, marker: string, { filename, data }: { filename: string; data: string }): unknown {
	if (!data || data.length > MAX_PDF_BYTES / 3 * 4) throw new Error('PDF 附件必须为非空文件，且不得超过 12 MiB。');
	const fields = payload as {
		messages?: MessageParts[];
		input?: MessageParts[];
		contents?: { role: string; parts: Part[] }[];
	};
	const file = { filename, file_data: `data:${mimeType};base64,${data}` };
	const document: Record<PdfFormat, Part> = {
		gemini: { inlineData: { mimeType, data } },
		messages: { type: 'document', source: { type: 'base64', media_type: mimeType, data } },
		responses: { type: 'input_file', ...file },
		chat: { type: 'file', file },
	};
	const messages = format === 'gemini' ? fields.contents : format === 'responses' ? fields.input : fields.messages;
	for (const message of messages ?? []) {
		if (message.role !== 'user') continue;
		const content = 'parts' in message ? message.parts : message.content;
		const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
		const part = Array.isArray(parts) && parts.find(({ text }) => text?.startsWith(marker));
		if (!part || part.text === undefined) continue;
		part.text = part.text.slice(marker.length);
		parts.unshift(document[format]);
		if (!('parts' in message)) message.content = parts;
		if (format === 'gemini' && Buffer.byteLength(JSON.stringify(fields)) > 20_000_000) {
			throw new Error('PDF 附件与问题合计超过单次解析请求大小限制。');
		}
		return fields;
	}
	throw new Error('无法定位发送 PDF 的用户消息。');
}
