import type { Api } from '@earendil-works/pi-ai';
import { estimateTextAndImageContentTokens, estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';

type Fields = Record<string, unknown>;
function fields(value: unknown): Fields {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
}

// 各协议的媒体都沿用 Pi 单幅图像的粗估值；传输编码长度与视觉 token 无关。
const mediaTokens = estimateTextAndImageContentTokens([{ type: 'image', mimeType: 'image/png', data: '' }]);
const mediaTypes = new Set(['image', 'image_url', 'input_image', 'video', 'video_url', 'input_video']);
const signatures = new Set(['signature', 'thoughtSignature', 'thinkingSignature', 'textSignature', 'encrypted_content', 'redactedContent']);
const contentFields = new Set(['content', 'parts', 'output', 'functionResponse', 'toolResult', 'reasoningContent', 'reasoningText', 'reasoning_details']);

/** 按实际协议所携的输入估算，只在准备好的输入结构可识别时返回数字。 */
export function estimatePromptTokens(api: Api, payload: unknown): number | undefined {
	const body = fields(payload);
	let media = 0;
	function content(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(content);
		if (!value || typeof value !== 'object') return value;
		const part = fields(value);
		if ((typeof part.type === 'string' && mediaTypes.has(part.type)) || part.inlineData || part.fileData
			|| fields(part.image).source || fields(part.video).source) {
			media++;
			return null;
		}
		if (part.redacted || part.type === 'redacted_thinking' || part.type === 'reasoning.encrypted') return null;
		const result: Fields = {};
		for (const [key, child] of Object.entries(part)) {
			if (signatures.has(key) || key === 'cache_control') continue;
			result[key] = contentFields.has(key) ? content(child) : child;
		}
		return result;
	}
	try {
		let parts: unknown[];
		switch (api) {
			case 'openai-completions':
			case 'mistral-conversations':
				if (!Array.isArray(body.messages)) return undefined;
				parts = [content(body.messages), body.tools, body.response_format ?? body.responseFormat];
				break;
			case 'anthropic-messages':
				if (!Array.isArray(body.messages)) return undefined;
				parts = [content(body.system), content(body.messages), body.tools, fields(body.output_config).format];
				break;
			case 'openai-responses':
			case 'azure-openai-responses':
			case 'openai-codex-responses':
				if (typeof body.input !== 'string' && !Array.isArray(body.input)) return undefined;
				parts = [body.instructions, content(body.input), body.tools, fields(body.text).format];
				break;
			case 'google-generative-ai':
			case 'google-vertex': {
				if (!Array.isArray(body.contents)) return undefined;
				const config = fields(body.config);
				parts = [content(config.systemInstruction), content(body.contents), config.tools, config.responseJsonSchema ?? config.responseSchema];
				break;
			}
			case 'bedrock-converse-stream':
				if (!Array.isArray(body.messages)) return undefined;
				parts = [content(body.system), content(body.messages), fields(body.toolConfig).tools, fields(body.outputConfig).textFormat];
				break;
			case 'pi-messages': {
				const context = fields(body.context);
				if (!Array.isArray(context.messages)) return undefined;
				const messages = context.messages.map((message: unknown) => {
					const { role, content: blocks, sections, toolsAdded, toolsRemoved, toolName, toolCallId, isError } = fields(message);
					return { role, content: content(blocks), sections, toolsAdded, toolsRemoved, toolName, toolCallId, isError };
				});
				parts = [context.systemPrompt, messages, context.tools, fields(body.text).format];
				break;
			}
			default: return undefined;
		}
		const text = JSON.stringify(parts.filter((part) => part !== undefined));
		return estimateTextTokens(text) + media * mediaTokens;
	} catch {
		return undefined;
	}
}
