import assert from 'node:assert/strict';
import test from 'node:test';
import { bareChatMedia, chatMediaKind, deferChatMediaEmbeds, pastedImagePreview, remoteChatMedia } from '../chatMedia';
import { splitMarkdownBlocks } from '../markdownBlocks';

void test('only whole clipboard attachments in the vault image cache receive a resource URL', () => {
	const reads: string[] = [];
	const adapter = { getResourcePath: (path: string) => { reads.push(path); return 'app://fixture/' + path; } };
	const path = '.scribe-ai/cache/draft/root/scribe-ai-image-aB12Cd/screenshot.png';
	const ref = { path, kind: 'file', pastedImage: true } as const;
	assert.equal(pastedImagePreview(adapter, ref), 'app://fixture/' + path);
	assert.equal(pastedImagePreview(adapter, { ...ref, path: '../outside.png' }), undefined);
	assert.equal(pastedImagePreview(adapter, { ...ref, path: path.replace('screenshot', 'other') }), undefined);
	assert.equal(pastedImagePreview(adapter, { ...ref, lines: [1, 2] }), undefined);
	assert.equal(pastedImagePreview(adapter, { ...ref, pastedImage: undefined }), undefined);
	assert.deepEqual(reads, [path]);
});

void test('recognizes remote media by the URL path and keeps credentials and other schemes out of previews', () => {
	assert.equal(chatMediaKind('照片.JPEG'), 'image');
	assert.equal(chatMediaKind('录音.ogg'), 'audio');
	assert.deepEqual(remoteChatMedia('https://cdn.example.com/clip.MP4?signature=123#t=1'), {
		kind: 'video', source: 'https://cdn.example.com/clip.MP4?signature=123#t=1',
	});
	assert.deepEqual([...bareChatMedia('视频（https://cdn.example.com/demo(1).mp4）。音频 https://cdn.example.com/a.wav。')].map(({ label }) => label),
		['https://cdn.example.com/demo(1).mp4', 'https://cdn.example.com/a.wav']);
	for (const url of ['https://example.com/watch?id=a.mp4', 'https://user:pass@example.com/a.png', 'file:///tmp/a.mov', 'data:image/png;base64,AA==']) {
		assert.equal(remoteChatMedia(url), undefined);
	}
});

void test('renders remote Markdown embeds as inert links before Obsidian parses them', () => {
	const embed = '![](https://cdn.example.com/clip(1).mp4?token=a "Clip")';
	const angle = '![Audio](<https://cdn.example.com/voice note.wav>)';
	const reference = '![Another audio][clip]';
	const definition = '[clip]: https://cdn.example.com/example.mp3';
	const native = '![[Media/Project.m4a]]';
	const image = '![Diagram](https://cdn.example.com/image?id=abc)';
	const markdown = [embed, angle, reference, native, image, definition].join('\n\n');
	const prepared = splitMarkdownBlocks(markdown).map(({ text }) => deferChatMediaEmbeds(text)).join('\n\n');
	assert.equal(prepared, [embed.slice(1), angle.slice(1), reference.slice(1), native, image.slice(1), definition].join('\n\n'));
});

void test('leaves inline, indented and fenced code examples, escapes, and comments exactly as written', () => {
	const embed = '![Clip](https://cdn.example.com/a.mp4)';
	const protectedText = [
		'`' + embed + '`',
		'    ' + embed,
		'~~~md\n' + embed + '\n~~~~',
		'> ```markdown\n> ' + embed + '\n> ```',
		'\\' + embed,
		'<!-- ' + embed + ' -->',
		'%% ' + embed + ' %%',
	].join('\n\n');
	assert.equal(deferChatMediaEmbeds(protectedText + '\n\n' + embed), protectedText + '\n\n' + embed.slice(1));
	assert.equal(deferChatMediaEmbeds('```\n' + embed), '```\n' + embed);
});

void test('remote embeds with no extension, literal HTML and protocol-relative URLs cannot load on render', () => {
	const markup = '![diagram](//cdn.example.com/render)\n<img src="https://cdn.example.com/img">\n![[Local picture.png]]';
	assert.equal(deferChatMediaEmbeds(markup), '[diagram](//cdn.example.com/render)\n&lt;img src="https://cdn.example.com/img">\n![[Local picture.png]]');
});
