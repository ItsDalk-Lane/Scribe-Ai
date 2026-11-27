import assert from 'node:assert/strict';
import test from 'node:test';
import { estimatePromptTokens } from '../inputUsage';
import { createModelService } from '../providers';

void test('prompt estimation includes history, tool results and declarations in a real Chat Completions payload', async () => {
	let sent: Record<string, unknown> = {};
	const service = createModelService({
		read: async () => ({ type: 'api_key', key: 'test-key' }), list: async () => [],
		modify: async (_id, update) => update(undefined), delete: async () => {},
	}, {
		configure() {}, onStatus: () => () => {}, logs: () => [],
		async fetch(input, init) {
			sent = await new Request(input, init).json() as Record<string, unknown>;
			const chunk = { id: 'id', object: 'chat.completion.chunk', model: 'chat', created: 1,
				choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] };
			return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
		},
	}, {
		customProviders: () => [{ id: 'count', label: 'Count', baseUrl: 'https://fixture.test/v1', protocol: 'openai-completions', models: ['chat'] }],
		catalogDetails: () => ({ structuredOutput: true, tools: true }),
	});
	await service.send({
		providerId: 'count', model: 'chat', system: 'System instructions. '.repeat(40),
		messages: [{ role: 'user', content: 'Earlier question. '.repeat(30) },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'lookup', input: { query: 'what' } }] },
			{ role: 'tool', content: 'Returned text. '.repeat(40), toolCallId: 'call', toolName: 'lookup' },
			{ role: 'user', content: 'Continue.' }],
		tools: [{ name: 'lookup', description: 'A long tool description. '.repeat(30), inputSchema: { type: 'object', properties: {} } }],
		responseSchema: { type: 'object', description: 'Required response. '.repeat(30) },
	});
	const api = 'openai-completions';
	const total = estimatePromptTokens(api, sent);
	assert.ok(total);
	assert.ok(Array.isArray(sent.messages));
	for (const role of ['system', 'tool', 'user']) {
		assert.ok(total > estimatePromptTokens(api, { ...sent, messages: sent.messages.filter((m: { role: string }) => m.role !== role) })! + 40, role);
	}
	for (const field of ['tools', 'response_format']) {
		assert.ok(total > estimatePromptTokens(api, { ...sent, [field]: undefined })! + 40, field);
	}
	assert.equal(total, estimatePromptTokens(api, { ...sent, model: 'routing only'.repeat(300), max_tokens: 5000 }));
});

void test('Google, Bedrock and Responses estimate native media independently of encoding and include output constraints', () => {
	const short = 'a';
	const long = short.repeat(24_000);
	const schema = { properties: { data: { type: 'string', description: 'Schema detail. '.repeat(80) } } };
	for (const api of ['google-generative-ai', 'google-vertex', 'bedrock-converse-stream', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses'] as const) {
		const measure = (data: string, structured: boolean) => {
			switch (api) {
				case 'google-generative-ai':
				case 'google-vertex':
					return estimatePromptTokens(api, { contents: [{ role: 'user', parts: [
						{ functionResponse: { name: 'render', response: { output: 'OK' }, parts: [{ inlineData: { mimeType: 'image/jpeg', data } }] } },
						{ fileData: { mimeType: 'video/mp4', fileUri: 'https://fixture.test/' + data } },
					] }], config: { systemInstruction: 'Check it', responseJsonSchema: structured ? schema : undefined } });
				case 'bedrock-converse-stream':
					return estimatePromptTokens(api, { messages: [{ role: 'user', content: [
						{ toolResult: { content: [{ image: { format: 'jpeg', source: { bytes: Buffer.from(data) } } }] } },
						{ video: { format: 'mp4', source: { bytes: Buffer.from(data) } } },
					] }], system: [{ text: 'Check it' }], outputConfig: { textFormat: structured ? { structure: { jsonSchema: { schema: JSON.stringify(schema) } } } : undefined } });
				default:
					return estimatePromptTokens(api, { instructions: 'Check it', input: [{ role: 'user', content: [
						{ type: 'input_image', image_url: 'data:image/jpeg;base64,' + data }, { type: 'input_video', video_url: 'https://fixture.test/' + data },
					] }], text: { format: structured ? { type: 'json_schema', schema } : undefined } });
			}
		};
		const base = measure(short, false);
		assert.ok(base && base > 2000, api);
		assert.equal(base, measure(long, false), api);
		assert.ok(measure(long, true)! > base + 80, api);
	}
});

void test('Pi history omits replay accounting and signatures while keeping tools, model messages and tool arguments', () => {
	const noise = 'metadata'.repeat(2_000);
	const count = (metadata: string, argument: string, description: string) => estimatePromptTokens('pi-messages', {
		model: metadata, context: { messages: [
			{ role: 'system', content: 'Use the tool', sections: { background: 'History' }, toolsAdded: [{ name: 'lookup', description }] },
			{ role: 'user', content: [{ type: 'image', data: metadata, mimeType: 'image/png' }, { type: 'text', text: 'Check it' }] },
			{ role: 'assistant', usage: { raw: metadata }, provider: metadata, errorMessage: metadata, content: [
				{ type: 'thinking', thinking: 'Known thoughts', thinkingSignature: metadata },
				{ type: 'toolCall', name: 'lookup', arguments: { data: argument, signature: argument } },
			] },
			{ role: 'toolResult', toolName: 'lookup', content: [{ type: 'text', text: 'Found it' }] },
		] },
	});
	const base = count('a', 'a', 'a');
	assert.ok(base && base > 1000);
	assert.equal(base, count(noise, 'a', 'a'));
	assert.ok(count('a', noise, 'a')! > base + 1000);
	assert.ok(count('a', 'a', noise)! > base + 1000);
	assert.equal(estimatePromptTokens('pi-messages', {}), undefined);
});
