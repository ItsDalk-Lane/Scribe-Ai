import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createLongTermMemory } from '../../orchestration/context/longTermMemory';
import { promptText } from '../../orchestration/context/promptXml';
import { initializeLocalState } from '../../orchestration/storage/localState';
import { scribeDataPaths } from '../../orchestration/storage/paths';
import { memoryTools } from '../../tools/memoryTools';
import { writeTools } from '../../tools/writeTools';
import type { ModelRequest, ModelResponse, ModelStream } from '../../types';
import { emptyModelResponse, fakeStream, fixture, sessionsFor } from './agentFixture';

function model(respond: (request: ModelRequest) => ModelResponse | Promise<ModelResponse>) {
	return {
		stream(request: ModelRequest): ModelStream {
			const response = Promise.resolve().then(async () => {
				await request.beforeSend?.('https://model.test/chat');
				return respond(request);
			});
			return {
				async *[Symbol.asyncIterator]() { yield* fakeStream(await response, request.signal); },
				result: () => response,
				cancel() {},
			};
		},
	};
}

async function preferences(cwd: string) {
	const paths = scribeDataPaths(cwd);
	await mkdir(paths.root);
	return initializeLocalState(paths.state, { loadLocalStorage: () => null, saveLocalStorage: () => {} }, []);
}

void test('real conversation sends opted-in memory references and resolves just the requested body', async (t) => {
	const { app, cwd } = await fixture(t);
	const state = await preferences(cwd);
	const memory = createLongTermMemory(cwd, state);
	const body = 'Memory body marker 85723';
	await memory.save('citation', '固定引用格式', body, null, true);
	const done = emptyModelResponse('处理完成。');
	const messages = (request: ModelRequest) => request.messages.map(promptText).join('\n');
	let step = 0;
	const sessions = sessionsFor(app, model((request) => {
		const text = messages(request);
		switch (++step) {
			case 1:
			case 4:
				assert.doesNotMatch(text, /<memory-index>|85723/u);
				assert.ok(!request.tools.some(({ name }) => name.startsWith('Memory') || name === 'HistorySearch'));
				return done;
			case 2:
				assert.match(text, /<memory-index>[\s\S]*固定引用格式/u);
				assert.doesNotMatch(text, /85723/u);
				assert.ok(request.tools.some(({ name }) => name === 'MemoryRead'));
				return emptyModelResponse('', [{ id: 'memory-read', name: 'MemoryRead', input: { topic: 'citation' } }]);
			case 3:
				assert.match(text, /Memory body marker 85723/u);
				return done;
			default: throw new Error('unexpected model turn');
		}
	}), [memoryTools], undefined, undefined, state);
	const request = (instruction: string) => ({ instruction, conversationId: 'memory-conversation', refs: [] });
	const first = await sessions.submit(request('先给摘要。')).result;
	assert.equal(first.status, 'done', first.error);
	await state.saveMemoryEnabled(true);
	const second = await sessions.submit(request('查出固定引用格式。')).result;
	assert.equal(second.status, 'done', second.error);
	assert.equal(second.messages.find(({ toolCallId }) => toolCallId === 'memory-read')?.isError, false);
	assert.doesNotMatch(JSON.stringify(second.messages), /85723/u);
	await state.saveMemoryEnabled(false);
	const final = await sessions.submit(request('告诉我你仍能看到的资料。')).result;
	assert.equal(final.status, 'done', final.error);
	assert.equal(step, 4);
});

void test('trusted directory rules reach the model before a first write in that directory', async (t) => {
	const { app, cwd } = await fixture(t);
	const state = await preferences(cwd);
	await state.saveDirectoryRulesTrust(true);
	const folder = join(cwd, 'drafts');
	await mkdir(folder);
	await writeFile(join(folder, 'AGENTS.md'), '正文首行填写“初稿”。');
	const path = join(folder, 'new.md');
	app.vault.getFileByPath = (name) => existsSync(join(cwd, name)) ? { path: name } as ReturnType<typeof app.vault.getFileByPath> : null;
	app.vault.read = (file) => readFile(join(cwd, file.path), 'utf8');
	let step = 0;
	const sessions = sessionsFor(app, model(async (request) => {
		const text = request.messages.map(promptText).join('\n');
		switch (++step) {
			case 1:
				assert.doesNotMatch(text, /正文首行填写/u);
				return emptyModelResponse('', [{ id: 'early', name: 'Write', input: { file_path: 'drafts/new.md', content: '未按规则' } }]);
			case 2:
				await assert.rejects(readFile(path), { code: 'ENOENT' });
				assert.match(text, /本次写入未执行/u);
				assert.match(text, /<project-rules>\s+drafts\/AGENTS\.md[\s\S]*正文首行填写/u);
				return emptyModelResponse('', [{ id: 'corrected', name: 'Write', input: { file_path: 'drafts/new.md', content: '初稿\n多一行' } }]);
			case 3:
				assert.equal(await readFile(path, 'utf8'), '初稿\n多一行');
				return emptyModelResponse('已完成。');
			default: throw new Error('unexpected model turn');
		}
	}), [writeTools], undefined, undefined, state);
	const result = await sessions.submit({ instruction: '建立该目录的新笔记。', conversationId: 'folder-rules', refs: [] }, {}, undefined, { executionMode: 'full-access' }).result;
	assert.equal(result.status, 'done', result.error);
	assert.deepEqual(result.messages.filter(({ role }) => role === 'tool').map(({ toolCallId, isError }) => [toolCallId, isError]), [
		['early', true], ['corrected', false],
	]);
});
