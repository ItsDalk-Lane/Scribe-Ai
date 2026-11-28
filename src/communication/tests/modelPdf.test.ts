import assert from 'node:assert/strict';
import test from 'node:test';
import type { CredentialStore, ModelRequest, Transport } from '../../types';
import { estimatePromptTokens } from '../inputUsage';
import { applyModelPdf, supportsPdfInput } from '../modelPdf';
import { createModelService } from '../providers';

const data = Buffer.from('%PDF-1.4\nfixture').toString('base64');
const file = { filename: 'fixture.pdf', data };
const marker = '[attachment]';

void test('PDF uses the selected API document part and excludes the transport encoding from token estimates', () => {
	const openai = { filename: file.filename, file_data: `data:application/pdf;base64,${data}` };
	assert.deepEqual(applyModelPdf({ input: [{ role: 'user', content: [{ type: 'input_text', text: marker + 'Read the PDF' }] }] },
		'responses', marker, file), { input: [{ role: 'user', content: [{ type: 'input_file', ...openai }, { type: 'input_text', text: 'Read the PDF' }] }] });
	const chat = () => ({ messages: [{ role: 'user', content: marker + 'Read the PDF' }] });
	assert.deepEqual(applyModelPdf(chat(), 'chat', marker, file), {
		messages: [{ role: 'user', content: [{ type: 'file', file: openai }, { type: 'text', text: 'Read the PDF' }] }],
	});
	const claude = applyModelPdf(chat(), 'messages', marker, file);
	assert.deepEqual(claude, { messages: [{ role: 'user', content: [
		{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }, { type: 'text', text: 'Read the PDF' },
	] }] });
	assert.equal(estimatePromptTokens('anthropic-messages', claude),
		estimatePromptTokens('anthropic-messages', applyModelPdf(chat(), 'messages', marker, { ...file, data: 'A'.repeat(10_000) })));
	assert.throws(() => applyModelPdf({ messages: [{ role: 'user', content: 'unrelated' }] }, 'messages', marker, file), /无法定位/u);
});

void test('PDF eligibility is limited to the documented provider routes and current model capability', () => {
	const gemini = { api: 'google-generative-ai', baseUrl: 'https://opencode.ai/inference/google/v1beta', source: 'catalog' } as const;
	assert.equal(supportsPdfInput(gemini, 'gemini-4-carbon', false), 'gemini');
	assert.equal(supportsPdfInput({ ...gemini, baseUrl: 'https://other.example/google/v1beta' }, 'gemini-4-carbon', true, undefined, ['pdf']), undefined);
	assert.equal(supportsPdfInput({ ...gemini, api: 'openai-completions' }, 'gemini-4-carbon', true), undefined);
	assert.equal(supportsPdfInput(gemini, 'gemini-4-carbon', true, undefined, ['text', 'image']), undefined);
	assert.equal(supportsPdfInput(gemini, 'gemini-4-carbon', true, { evidence: { inputModalities: { source: 'provider', conflict: true } } }), undefined);
	assert.equal(supportsPdfInput({ ...gemini, api: 'openai-responses', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan' },
		'doubao-seed-2-1-pro-260915', true, undefined, ['pdf']), undefined);
});

void test('dedicated Gemini request sends the original PDF through the selected route after address confirmation', async () => {
	const address = 'https://opencode.ai/inference/google/v1beta';
	const credentials: CredentialStore = {
		read: async () => ({ type: 'api_key', key: 'mock-key' }),
		list: async () => [], modify: async (_id, update) => update(undefined), delete: async () => {},
	};
	let confirmed = false;
	let rejectedByProvider = false;
	const sent: unknown[] = [];
	const transport: Transport = {
		configure() {}, onStatus: () => () => {}, logs: () => [],
		async fetch(input, init) {
			const req = new Request(input, init);
			assert.equal(confirmed, true);
			assert.equal(new URL(req.url).origin + new URL(req.url).pathname, address + '/models/gemini-4-carbon:streamGenerateContent');
			const { contents } = await req.json() as { contents: unknown };
			sent.push(contents);
			if (rejectedByProvider) return Response.json({ error: { code: 400, message: `Invalid part data: ${data}`, status: 'INVALID_ARGUMENT' } }, { status: 400 });
			return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Page 1' }], role: 'model' }, finishReason: 'STOP' }] })}\n\n`,
				{ headers: { 'content-type': 'text/event-stream' } });
		},
	};
	const models = createModelService(credentials, transport, {
		customProviders: () => [{ id: 'custom-pdf', label: 'Test', models: ['gemini-4-carbon'], baseUrl: address, protocol: 'google-generative-ai' }],
	});
	const request: ModelRequest = {
		providerId: 'custom-pdf', model: 'gemini-4-carbon', messages: [{ role: 'user', content: 'Read the PDF' }], tools: [], maxRetries: 0,
		beforeSend: async (target) => {
			assert.equal(target, address + '/models/gemini-4-carbon:streamGenerateContent');
			confirmed = true;
		},
	};
	const pdf: ModelRequest['pdf'] = { messageIndex: 0, load: async () => file };
	assert.equal(models.modelCapabilities?.(request.providerId, request.model).pdfAnalysis, true);
	assert.equal((await models.send({ ...request, pdf })).content, 'Page 1');
	assert.deepEqual(sent[0], [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data } }, { text: 'Read the PDF' }] }]);
	await models.send(request);
	assert.deepEqual(sent[1], [{ role: 'user', parts: [{ text: 'Read the PDF' }] }]);
	await assert.rejects(models.send({ ...request, pdf, beforeSend: async () => { throw new Error('not authorized'); } }), /not authorized/u);
	assert.equal(sent.length, 2);
	rejectedByProvider = true;
	await assert.rejects(models.send({ ...request, pdf }), (error: Error) => error.message.includes('Invalid part data') && !error.message.includes(data));
});
