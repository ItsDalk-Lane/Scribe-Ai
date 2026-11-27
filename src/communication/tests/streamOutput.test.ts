import assert from 'node:assert/strict';
import test from 'node:test';
import { receivedOutput } from '../streamOutput';

void test('completion frames select one candidate and one reasoning alias, including content and tool input delivered with usage', () => {
	const delta = { reasoning_content: 'why', reasoning: 'why', reasoning_details: [{ data: 'cipher' }],
		content: 'reply', tool_calls: [{ function: { arguments: '{"q":' } }, { custom: { input: 'test' } }] };
	assert.equal(receivedOutput('openai-completions', { usage: { completion_tokens: 10 },
		choices: [{ delta }, { delta: { content: 'another candidate' } }] }), 'whyreply{"q":test');
	assert.equal(receivedOutput('mistral-conversations', { choices: [{ delta: {
		content: ['one', { type: 'thinking', thinking: [{ text: 'two' }, { signature: 'cipher' }] },
			{ type: 'text', text: 'three' }, { type: 'image_url', image_url: 'image' }],
		tool_calls: [{ function: { arguments: { page: 1 } } }],
	} }] }), 'onetwothree{"page":1}');
});

void test('Responses estimates deltas only even when terminal and block events repeat the output', () => {
	for (const api of ['openai-responses', 'azure-openai-responses', 'openai-codex-responses'] as const) {
		const output = [
			{ type: 'response.reasoning_summary_text.delta', delta: 'r' },
			{ type: 'response.output_text.delta', delta: 'a' },
			{ type: 'response.output_item.added', item: { type: 'function_call', arguments: '{' } },
			{ type: 'response.function_call_arguments.delta', delta: '}' },
			{ type: 'response.function_call_arguments.done', arguments: '{}' },
			{ type: 'response.output_item.done', item: { content: [{ text: 'a' }], encrypted_content: 'cipher' } },
			{ type: 'response.completed', response: { output: [{ text: 'a' }] } },
		].map((frame) => receivedOutput(api, frame)).join('');
		assert.equal(output, 'ra{}');
	}
});

void test('Anthropic and Bedrock count textual deltas and ignore signatures and redacted content', () => {
	assert.equal(receivedOutput('anthropic-messages', { type: 'content_block_start', content_block: { type: 'text', text: 'start' } }), 'start');
	for (const [delta, expected] of [
		[{ type: 'text_delta', text: 'a' }, 'a'], [{ type: 'thinking_delta', thinking: 'b' }, 'b'],
		[{ type: 'input_json_delta', partial_json: '{"x"' }, '{"x"'], [{ type: 'signature_delta', signature: 'cipher' }, ''],
	] as const) assert.equal(receivedOutput('anthropic-messages', { type: 'content_block_delta', delta }), expected);
	assert.equal(receivedOutput('anthropic-messages', { type: 'content_block_start', content_block: { type: 'redacted_thinking', data: 'cipher' } }), '');
	for (const [delta, expected] of [
		[{ text: 'a' }, 'a'], [{ reasoningContent: { text: 'b', signature: 'cipher' } }, 'b'],
		[{ toolUse: { input: '{}' } }, '{}'], [{ reasoningContent: { redactedContent: 'cipher' } }, ''],
	] as const) assert.equal(receivedOutput('bedrock-converse-stream', { contentBlockDelta: { delta } }), expected);
});

void test('Google counts each delivered argument object once and Pi waits for the reasoning visibility decision', () => {
	for (const api of ['google-generative-ai', 'google-vertex'] as const) {
		const candidate = { content: { parts: [{ text: 'why', thought: true, thoughtSignature: 'cipher' }, { text: 'yes' },
			{ functionCall: { name: 'lookup', args: { num: 1 } } }, { inlineData: { data: 'binary' } }] } };
		assert.equal(receivedOutput(api, { candidates: [candidate, candidate], usageMetadata: { candidatesTokenCount: 9 } }), 'whyyes{"num":1}');
	}
	const frames = [
		{ type: 'thinking_delta', delta: 'private' }, { type: 'thinking_end', content: 'private', redacted: true },
		{ type: 'thinking_delta', delta: 'public' }, { type: 'thinking_end', content: 'public' },
		{ type: 'text_delta', delta: 'answer' }, { type: 'text_end', content: 'answer' },
		{ type: 'toolcall_delta', delta: '{}' }, { type: 'toolcall_end', toolCall: { arguments: {} } },
	];
	assert.equal(frames.map((frame) => receivedOutput('pi-messages', frame)).join(''), 'publicanswer{}');
});
