import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { App, TFile } from 'obsidian';
import type { Message, ToolContext } from '../../types';
import { createReadDelivery } from '../../runtime/readDelivery';
import { readTools } from '../readTools';
import { isWithinPath } from '../support/pathUtils';
import { writeTools } from '../writeTools';

async function fileToolsFixture(testContext: TestContext) {
	const directory = await mkdtemp(join(await realpath(tmpdir()), 'scribe-file-tools-'));
	testContext.after(() => rm(directory, { recursive: true, force: true }));
	const cwd = join(directory, 'vault');
	const outside = join(directory, 'outside');
	await Promise.all([mkdir(cwd), mkdir(outside)]);
	const usedVaultApi = new Set<string>();
	const app = { vault: {
		getFileByPath: (path: string) => path === 'note.md' ? { path } : null,
		readBinary(file: TFile) {
			usedVaultApi.add('readBinary');
			return readFile(join(cwd, file.path));
		},
		async process(file: TFile, update: (source: string) => string) {
			usedVaultApi.add('process');
			const path = join(cwd, file.path);
			await writeFile(path, update(await readFile(path, 'utf8')));
		},
		async create(path: string, text: string) {
			usedVaultApi.add('create');
			await writeFile(join(cwd, path), text, { flag: 'wx' });
		},
	} } as unknown as App;
	const permitted = (path: string) => isWithinPath(cwd, path) || isWithinPath(outside, path);
	const context: ToolContext = {
		cwd,
		app,
		signal: new AbortController().signal,
		readFiles: new Map(),
		readDelivery: createReadDelivery(),
		task: { id: 'test', request: { conversationId: 'test', instruction: '', refs: [] }, status: 'running', createdAt: 0, updatedAt: 0 },
		permissions: { canRead: permitted, canWrite: permitted, canCallTool: () => true, canSendOutbound: () => true },
	};
	const tools = new Map([...readTools(), ...writeTools()].map((tool) => [tool.name, tool]));
	const prepare = async (name: string, input: unknown) => {
		const tool = tools.get(name);
		assert.ok(tool);
		return tool.prepare(input, context);
	};
	const run = async (name: string, input: unknown) => {
		const output = await (await prepare(name, input)).run();
		if (typeof output === 'string') return output;
		const message: Message = { role: 'tool', content: output.content };
		context.readDelivery.remember(message, output.fileRead);
		context.readDelivery.accept([message]);
		return output.content;
	};
	return { directory, cwd, outside, usedVaultApi, context, prepare, run };
}

void test('File tools read and write vault files and authorized external files', async (testContext) => {
	const { directory, cwd, outside, usedVaultApi, context, prepare, run } = await fileToolsFixture(testContext);
	const note = join(cwd, 'note.md');
	const external = join(outside, 'draft.txt');
	const denied = join(directory, 'private.txt');
	await Promise.all([
		writeFile(note, 'before\r\nUnicode 😀\r\nafter\r\n'),
		writeFile(external, 'old old'),
		writeFile(denied, 'private'),
	]);
	context.task.request.refs = [{ path: 'note.md', lines: [2, 2] }];
	const excerpt = await run('Read', { file_path: 'note.md' });
	assert.match(excerpt, /2\tUnicode 😀$/);
	assert.doesNotMatch(excerpt, /before|after/);
	await assert.rejects(prepare('Write', { file_path: 'note.md', content: 'test' }), /部分行/);
	context.task.request.refs = [];
	await assert.rejects(run('Read', { file_path: denied }), /未包含/);
	if (process.platform !== 'win32') {
		await symlink(denied, join(cwd, 'link.md'));
		await assert.rejects(run('Read', { file_path: 'link.md' }), /未包含/);
	}
	await run('Read', { file_path: 'note.md', offset: 2, limit: 2 });
	const replacement = await prepare('Edit', { file_path: 'note.md', old_string: 'Unicode 😀\nafter', new_string: 'music $&' });
	assert.equal(replacement.approval?.after, 'before\r\nmusic $&\r\n');
	await replacement.run();
	assert.equal(await readFile(note, 'utf8'), 'before\r\nmusic $&\r\n');
	await run('Write', { file_path: 'new.md', content: '' });
	assert.equal(await readFile(join(cwd, 'new.md'), 'utf8'), '');
	assert.deepEqual([...usedVaultApi], ['readBinary', 'process', 'create']);
	await assert.rejects(prepare('Write', { file_path: external, content: 'new' }), /读取/);
	await run('Read', { file_path: external });
	await assert.rejects(prepare('Edit', { file_path: external, old_string: 'old', new_string: 'new' }), /出现多次/);
	const approved = await prepare('Edit', { file_path: external, old_string: 'old', new_string: 'new', replace_all: true });
	await writeFile(external, 'changed since approval');
	await assert.rejects(async () => approved.run(), /已变化/);
	assert.equal(await readFile(external, 'utf8'), 'changed since approval');
	await run('Read', { file_path: external });
	await run('Write', { file_path: external, content: 'confirmed replacement' });
	assert.equal(await readFile(external, 'utf8'), 'confirmed replacement');
});

void test('Read bounds oversized results and gives a continuation line', async (testContext) => {
	const { outside, prepare, run } = await fileToolsFixture(testContext);
	const path = join(outside, 'long.txt');
	await writeFile(path, 'x'.repeat(102_000) + '\nsecond line\n');
	const result = await run('Read', { file_path: path });
	assert.ok(result.length <= 100_000);
	assert.match(result, /第 1 行过长/);
	assert.match(result, /offset=2/);
	assert.match(await run('Read', { file_path: path, offset: 2 }), /2\tsecond line$/);
	await assert.rejects(prepare('Write', { file_path: path, content: 'replacement' }), /读取同一版本的全部内容/);
});

void test('NotebookEdit updates cells while retaining notebook metadata', async (testContext) => {
	const { outside, run } = await fileToolsFixture(testContext);
	const path = join(outside, 'notebook.ipynb');
	const code = { id: 'old', cell_type: 'code', source: ['x=1'], metadata: { retain: true }, execution_count: 7, outputs: [{}] };
	const notebook = { nbformat: 4, nbformat_minor: 5, metadata: { lang: 'test' }, cells: [code] };
	await writeFile(path, JSON.stringify(notebook));
	await run('Read', { file_path: path });
	await run('NotebookEdit', { notebook_path: path, cell_id: 'old', new_source: 'x=5\ny=10' });
	let result = JSON.parse(await readFile(path, 'utf8')) as typeof notebook;
	assert.deepEqual(result, { ...notebook, cells: [{ ...code, source: ['x=5\n', 'y=10'], execution_count: null, outputs: [] }] });
	await run('NotebookEdit', { notebook_path: path, cell_id: 'old', edit_mode: 'insert', new_source: 'new', cell_type: 'markdown' });
	result = JSON.parse(await readFile(path, 'utf8')) as typeof notebook;
	const added = result.cells[1];
	assert.ok(added && /^[0-9a-f-]+$/.test(added.id));
	await run('NotebookEdit', { notebook_path: path, cell_id: 'old', edit_mode: 'delete' });
	result = JSON.parse(await readFile(path, 'utf8')) as typeof notebook;
	assert.deepEqual(result.cells, [added]);
});
