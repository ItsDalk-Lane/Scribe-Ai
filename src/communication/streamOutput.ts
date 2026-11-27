import type { Api } from '@earendil-works/pi-ai';

function fields(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function argumentsText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (!value || typeof value !== 'object') return '';
	try { return JSON.stringify(value); } catch { return ''; }
}

function mistralContent(content: unknown): string {
	if (typeof content === 'string') return content;
	return list(content).map((value) => {
		if (typeof value === 'string') return value;
		const part = fields(value);
		if (part.type === 'text') return text(part.text);
		if (part.type === 'thinking') return list(part.thinking).map((item) => text(fields(item).text)).join('');
		return '';
	}).join('');
}

/** 仅提取本帧新收到的可读输出，结束事件经常会重放此前的整个内容块。 */
export function receivedOutput(api: Api, frame: Record<string, unknown>): string {
	switch (api) {
		case 'openai-completions':
		case 'mistral-conversations': {
			const delta = fields(fields(list(frame.choices)[0]).delta);
			const content = api === 'mistral-conversations'
				? mistralContent(delta.content)
				: (text(delta.reasoning_content) || text(delta.reasoning) || text(delta.reasoning_text)) + text(delta.content);
			const args = list(delta.tool_calls).map((item) => {
				const call = fields(item);
				return argumentsText(fields(call.function).arguments) || text(fields(call.custom).input);
			}).join('');
			return content + args;
		}
		case 'openai-responses':
		case 'azure-openai-responses':
		case 'openai-codex-responses':
			switch (frame.type) {
				case 'response.output_item.added': {
					const item = fields(frame.item);
					if (item.type === 'function_call') return text(item.arguments);
					if (item.type === 'custom_tool_call') return text(item.input);
					return '';
				}
				case 'response.output_text.delta':
				case 'response.refusal.delta':
				case 'response.reasoning_text.delta':
				case 'response.reasoning_summary_text.delta':
				case 'response.function_call_arguments.delta':
				case 'response.custom_tool_call_input.delta':
					return text(frame.delta);
				default: return '';
			}
		case 'anthropic-messages': {
			if (frame.type === 'content_block_start') {
				const block = fields(frame.content_block);
				if (block.type === 'text') return text(block.text);
				if (block.type === 'thinking') return text(block.thinking);
				return '';
			}
			if (frame.type !== 'content_block_delta') return '';
			const delta = fields(frame.delta);
			switch (delta.type) {
				case 'text_delta': return text(delta.text);
				case 'thinking_delta': return text(delta.thinking);
				case 'input_json_delta': return text(delta.partial_json);
				default: return '';
			}
		}
		case 'google-generative-ai':
		case 'google-vertex': {
			const candidate = fields(list(frame.candidates)[0]);
			return list(fields(candidate.content).parts).map((value) => {
				const part = fields(value);
				return text(part.text) + argumentsText(fields(part.functionCall).args);
			}).join('');
		}
		case 'bedrock-converse-stream': {
			const delta = fields(fields(frame.contentBlockDelta).delta);
			return text(delta.text) || text(fields(delta.toolUse).input) || text(fields(delta.reasoningContent).text);
		}
		case 'pi-messages':
			if (frame.type === 'text_delta' || frame.type === 'toolcall_delta') return text(frame.delta);
			// Pi 直到思考块结束才确认是否隐藏，因此在此时只计一次已公开的内容。
			if (frame.type === 'thinking_end' && !frame.redacted) return text(frame.content);
			return '';
		default: return '';
	}
}
