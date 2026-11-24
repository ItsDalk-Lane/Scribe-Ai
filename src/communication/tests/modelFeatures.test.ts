import assert from 'node:assert/strict';
import test from 'node:test';
import { applyResponseSchema, supportsResponseSchema } from '../modelFeatures';
import { applyModelVideo, nativeVideoFormat } from '../modelVideo';
import { createModelService } from '../providers';
import { documentedRouteDetails } from '../modelCatalog';
import { captureReportedUsage } from '../reportedUsage';
import type { CredentialStore, ModelOverride, ModelRequest, Transport } from '../../types';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const localTool = { name: 'lookup', description: 'Look up a note.', inputSchema: { type: 'object' } };

void test('video encodings follow the selected API, with GLM URL-only and OpenRouter Messages excluded', () => {
	const sample = { mimeType: 'video/mp4', data: 'AA==' };
	const link = { mimeType: 'video/mp4', url: 'https://media.example/clip.mp4' };
	const chat = () => ({ messages: [{ role: 'user', content: 'marker:text' }] });
	assert.deepEqual(applyModelVideo(chat(), 'chat-url', 'marker:', [link]), {
		messages: [{ role: 'user', content: [{ type: 'text', text: 'text' }, { type: 'video_url', video_url: { url: link.url } }] }],
	});
	assert.throws(() => applyModelVideo(chat(), 'chat-url', 'marker:', [sample]), /HTTPS/);
	const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } };
	assert.deepEqual(applyModelVideo({ messages: [{ role: 'user', content: [{ type: 'text', text: 'marker:text' }, image] }] },
		'chat-url', 'marker:', [link]), {
		messages: [{ role: 'user', content: [{ type: 'text', text: 'text' }, image, { type: 'video_url', video_url: { url: link.url } }] }],
	});
	assert.deepEqual(applyModelVideo({ contents: [{ role: 'user', parts: [{ text: 'marker:text' }] }] }, 'gemini', 'marker:', [sample]),
		{ contents: [{ role: 'user', parts: [{ text: 'text' }, { inlineData: sample }] }] });
	assert.deepEqual(applyModelVideo({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'marker:text' }] }] }, 'responses', 'marker:', [link]),
		{ input: [{ role: 'user', content: [{ type: 'input_text', text: 'text' }, { type: 'input_video', video_url: link.url }] }] });
	assert.equal(nativeVideoFormat({ api: 'anthropic-messages', baseUrl: 'https://openrouter.ai/api', source: 'catalog' }), undefined);
});

void test('confirmed video routes send native content blocks and keep unrelated interfaces disabled', () => {
	const file = { mimeType: 'video/mp4', data: 'AA==' };
	const route = (api: string, baseUrl: string, model: string) => nativeVideoFormat({ api, baseUrl, source: 'catalog' }, model);
	const bedrock = 'https://bedrock-runtime.ca-central-1.amazonaws.com';
	assert.equal(route('bedrock-converse-stream', bedrock, 'ca.amazon.nova-lite-v1:0'), 'bedrock');
	assert.equal(route('bedrock-converse-stream', bedrock, 'amazon.nova-2-lite-v1:0'), undefined);
	assert.deepEqual(applyModelVideo({ messages: [{ role: 'user', content: [{ text: 'marker:test' }] }] }, 'bedrock', 'marker:', [file]), {
		messages: [{ role: 'user', content: [{ text: 'test' }, { video: { format: 'mp4', source: { bytes: Buffer.from([0]) } } }] }],
	});
	const ark = 'https://ark.cn-beijing.volces.com/api/v3';
	assert.equal(route('openai-completions', ark, 'doubao-seed-2-1-pro-260915'), 'chat');
	assert.equal(route('openai-responses', ark, 'doubao-seed-2-1-pro-260915'), 'responses');
	assert.equal(route('openai-responses', 'https://api.meta.ai/v1', 'muse-spark-1.3'), 'responses');
	assert.equal(route('openai-completions', 'https://api.meta.ai/v1', 'muse-spark-1.3'), undefined);
	assert.equal(route('openai-completions', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro'), 'chat');
	assert.equal(route('google-generative-ai', 'https://opencode.ai/inference/google/v1beta', 'gemini-4-argon'), 'gemini');
	assert.deepEqual(applyModelVideo({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'marker:test' }] }] }, 'responses', 'marker:', [file]), {
		input: [{ role: 'user', content: [{ type: 'input_text', text: 'test' }, { type: 'input_video', video_url: 'data:video/mp4;base64,AA==' }] }],
	});
});

void test('dedicated analysis exposes all adapted video connections with their attachment mode', () => {
	const definitions = [
		['google-generative-ai', 'https://generativelanguage.googleapis.com', 'gemini-4-argon', 'file'],
		['google-generative-ai', 'https://opencode.ai/inference/go/google/v1beta', 'gemini-4-argon', 'file'],
		['google-vertex', 'https://aiplatform.googleapis.com', 'gemini-4-argon', 'file'],
		['bedrock-converse-stream', 'https://bedrock-runtime.ca-central-1.amazonaws.com', 'ca.amazon.nova-lite-v1:0', 'file'],
		['openai-responses', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao', 'file'],
		['openai-responses', 'https://openrouter.ai/api/v1', 'video', 'file'],
		['openai-responses', 'https://api.meta.ai/v1', 'muse-spark-1.3', 'file'],
		['openai-completions', 'https://api.xiaomimimo.com/v1', 'mimo', 'file'],
		['openai-completions', 'https://api.moonshot.cn/v1', 'kimi', 'file'],
		['openai-completions', 'https://api.kimi.com/coding/v1', 'kimi', 'file'],
		['openai-completions', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen', 'file'],
		['openai-completions', 'https://integrate.api.nvidia.com/v1', 'nvidia-video', 'file'],
		['openai-completions', 'https://open.bigmodel.cn/api/coding/paas/v4', 'glm-5.3-flash', 'link'],
		['openai-completions', 'https://api.z.ai/api/paas/v4', 'glm', 'link'],
		['anthropic-messages', 'https://openrouter.ai/api/v1', 'video', undefined],
	] as const;
	const entries = definitions.map(([protocol, baseUrl, model], i) => ({ id: 'custom-' + i, label: 'Fixture', protocol, baseUrl, models: [model] }));
	const credentials: CredentialStore = {
		read: async () => undefined, list: async () => [], modify: async (_id, update) => update(undefined), delete: async () => {},
	};
	const transport: Transport = {
		configure() {}, onStatus: () => () => {}, logs: () => [], fetch: () => assert.fail('Catalog capability should be local'),
	};
	const service = createModelService(credentials, transport, {
		customProviders: () => entries,
		modelOverrides: () => Object.fromEntries(entries.map(({ id, models }) => [id, { [models[0]!]: { input: ['video'] } }])),
	});
	for (const [i, { id, models: [model] }] of entries.entries()) {
		assert.equal(service.modelCapabilities?.(id, model!).videoAnalysis, definitions[i]![3], definitions[i]![1]);
	}
});

void test('video receipt requires an explicit video count for Chat Completions and Responses', () => {
	const chat = captureReportedUsage('openai-completions');
	chat.observe({ usage: { prompt_tokens: 210, prompt_tokens_details: { audio_tokens: 200 } } });
	assert.equal(chat.read().videoInput, undefined);
	chat.observe({ usage: { prompt_tokens_details: { video_tokens: 100 } } });
	assert.equal(chat.read().videoInput, 100);
	const responses = captureReportedUsage('openai-responses');
	responses.observe({ response: { usage: { input_tokens: 600, input_tokens_details: { video_tokens: 500 } } } });
	assert.equal(responses.read().videoInput, 500);
});

void test('alternate API evidence matches the provider, model, URL and protocol independently', () => {
	assert.equal(documentedRouteDetails('meta', 'muse-spark-1.3', 'openai-completions', 'https://api.meta.ai/v1')?.structuredOutput, true);
	assert.equal(supportsResponseSchema('openai-responses', 'https://api.meta.ai/v1', 'muse-spark-1.3'), false);
	assert.equal(documentedRouteDetails('meta', 'muse-spark-1.3', 'openai-completions', 'https://mirror.example/v1'), undefined);
	assert.equal(documentedRouteDetails('moonshotai-cn', 'kimi-k3.1-pro', 'openai-responses', 'https://api.moonshot.cn/v1')?.structuredOutput, true);
	assert.equal(documentedRouteDetails('moonshotai-cn', 'kimi-k3.1-pro', 'openai-responses', 'https://api.moonshot.ai/v1'), undefined);
});

void test('catalog capability reaches the selected connection and only explicit requests use a JSON schema', async () => {
	const overrides: Record<string, ModelOverride> = {};
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const credentials: CredentialStore = {
		read: async () => ({ type: 'api_key', key: 'mock-key' }),
		list: async () => [], modify: async (_id, update) => update(undefined), delete: async () => {},
	};
	const endpoint = 'https://original.test/v1';
	let reply = '{"ok":true}';
	const transport: Transport = {
		configure() {}, onStatus: () => () => {}, logs: () => [],
		async fetch(input, init) {
			const req = new Request(input, init);
			const body = await req.json() as Record<string, unknown>;
			requests.push({ url: req.url, body });
			const part = { type: 'output_text', text: reply, annotations: [{
				type: 'url_citation', url: 'https://source.example/docs', title: 'Docs', start_index: 0, end_index: 1,
			}] };
			const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [part] };
			const data = [
				{ type: 'response.output_item.added', item: { ...item, content: [] }, output_index: 0 },
				{ type: 'response.content_part.added', part: { ...part, text: '', annotations: [] }, output_index: 0, content_index: 0 },
				{ type: 'response.output_text.delta', delta: reply, output_index: 0, content_index: 0 },
				{ type: 'response.output_item.done', item, output_index: 0 },
				{ type: 'response.completed', response: { id: 'resp_feature', status: 'completed', output: [item] } },
			];
			return new Response(data.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
				{ headers: { 'content-type': 'text/event-stream' } });
		},
	};
	const models = createModelService(credentials, transport, {
		customProviders: () => [{ id: 'custom-1', label: 'Test', models: ['model'], baseUrl: endpoint, protocol: 'openai-responses' }],
		modelOverrides: () => ({ 'custom-1': overrides }),
		catalogDetails: (_id, _model, address) => {
			assert.equal(address, endpoint);
			return { structuredOutput: true, nativeWebSearch: true };
		},
	});
	const request: ModelRequest = { providerId: 'custom-1', model: 'model', messages: [{ role: 'user', content: 'Check.' }], tools: [localTool] };
	assert.deepEqual(models.modelCapabilities?.(request.providerId, request.model), { structuredOutput: true, tools: true, imageInput: false });

	const legacyRequest = { ...request, allowNativeWebSearch: true };
	const ordinary = await models.send(legacyRequest);
	assert.equal(ordinary.content, reply);
	assert.equal(requests[0]?.url, endpoint + '/responses');
	assert.equal(requests[0]?.body.text, undefined);
	assert.deepEqual((requests[0]?.body.tools as { type: string }[]).map(({ type }) => type), ['function']);

	const json = await models.send({ ...request, responseSchema: schema, tools: [] });
	assert.equal(json.content, reply);
	assert.equal(json.structuredOutput, true);
	assert.equal(requests[1]?.body.tools, undefined);
	assert.deepEqual(requests[1]?.body.text, { format: { type: 'json_schema', name: 'scribe_response', strict: true, schema } });

	reply = 'unstructured';
	await assert.rejects(models.send({ ...request, responseSchema: schema }), /有效的结构化 JSON/u);
	await models.send(request);
	assert.deepEqual((requests[3]?.body.tools as { type: string }[]).map(({ type }) => type), ['function']);

	overrides.model = { capabilities: { structuredOutput: false } };
	await models.send(request);
	assert.deepEqual((requests[4]?.body.tools as { type: string }[]).map(({ type }) => type), ['function']);
	assert.throws(() => models.send({ ...request, responseSchema: schema }), /未启用结构化输出/u);
	assert.equal(requests.length, 5);

	overrides.model = { baseUrl: 'https://other.test/v1' };
	assert.deepEqual(models.modelCapabilities?.(request.providerId, request.model), { structuredOutput: false, tools: true, imageInput: false });
});

void test('schema uses each provider request format and preserves other request fields', () => {
	assert.deepEqual(applyResponseSchema({ tools: [localTool], output_config: { effort: 'low' } },
		'anthropic-messages', schema, 'https://api.anthropic.com'), {
		tools: [localTool],
		output_config: { effort: 'low', format: { type: 'json_schema', schema } },
	});
	assert.deepEqual(applyResponseSchema({ config: { temperature: 0.5 } }, 'google-vertex', schema, 'https://aiplatform.googleapis.com'), {
		config: { temperature: 0.5, responseMimeType: 'application/json', responseJsonSchema: schema },
	});
	assert.deepEqual(applyResponseSchema({}, 'bedrock-converse-stream', schema, ''), {
		outputConfig: { textFormat: { type: 'json_schema', structure: { jsonSchema: { schema: JSON.stringify(schema), name: 'scribe_response' } } } },
	});
	assert.deepEqual(applyResponseSchema({ provider: { sort: 'price' } }, 'openai-completions', schema, 'https://openrouter.ai/api/v1'), {
		provider: { sort: 'price', require_parameters: true },
		response_format: { type: 'json_schema', json_schema: { name: 'scribe_response', strict: true, schema } },
	});
	const coding = 'https://open.bigmodel.cn/api/coding/paas/v4';
	assert.equal(supportsResponseSchema('openai-completions', coding, 'glm-5.3-flash'), true);
	assert.equal(supportsResponseSchema('openai-completions', coding, 'glm-5.3'), false);
	assert.equal(supportsResponseSchema('openai-completions', 'https://api.z.ai/api/coding/paas/v4', 'glm-5.3-flash'), false);
});

void test('Groq sends strict schema without API streaming and hands the completed JSON back to the Agent', async () => {
	const credentials: CredentialStore = {
		read: async () => ({ type: 'api_key', key: 'fixture' }),
		list: async () => [], modify: async () => undefined, delete: async () => {},
	};
	const transport: Transport = {
		configure() {}, onStatus: () => () => {}, logs: () => [],
		async fetch(input, init) {
			const request = new Request(input, init);
			assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
			const body = await request.json() as Record<string, unknown>;
			assert.equal(body.stream, false);
			assert.equal(body.stream_options, undefined);
			assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'scribe_response', strict: true, schema } });
			return Response.json({
				id: 'audit', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-20b',
				choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
				usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
			});
		},
	};
	const result = await createModelService(credentials, transport).send({
		providerId: 'groq', model: 'openai/gpt-oss-20b', tools: [], messages: [{ role: 'user', content: 'Ready?' }], responseSchema: schema,
	});
	assert.equal(result.content, '{"ok":true}');
	assert.equal(result.structuredOutput, true);
	assert.equal(result.reportedUsage?.total, 9);
});
