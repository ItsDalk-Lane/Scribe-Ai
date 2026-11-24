import assert from 'node:assert/strict';
import { Agent } from 'node:http';
import test from 'node:test';
import { createImageAttachments } from '../../orchestration/context/imageAttachments';
import { taskMessage } from '../../orchestration/context/contextBuilder';
import type { Message, RunContext, TaskRequest } from '../../types';
import { imageDownloadProxy, publicImageUrl, readRemoteImage } from '../support/remoteImage';

void test('explicit public image links become image content; private and redirected private targets never receive a request', async () => {
	const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
	const requests: string[] = [];
	const signal = new AbortController().signal;
	const fetcher: typeof fetch = async (input) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		requests.push(url);
		if (url.endsWith('/private')) return Response.redirect('http://[::ffff:127.0.0.1]/secret');
		return new Response(Buffer.from(data, 'base64'), { headers: { 'content-type': 'image/png' } });
	};
	const source: TaskRequest = { conversationId: 'images', refs: [],
		instruction: '图一 https://images.example.com/a.png。\n图二 ![图二](https://images.example.com/raw?id=9)\n参考 https://example.com/docs\n`https://example.com/code.png`\n![视频](https://example.com/clip.mp4)' };
	const task = { request: source } as RunContext['task'];
	const current: Message[] = [taskMessage(source)];
	const attachments = createImageAttachments(undefined, (url, signal) => readRemoteImage(url, signal, false, fetcher));
	const request = attachments({ task } as RunContext, current, current);
	assert.deepEqual((await request?.load(signal))?.get(0), Array.from({ length: 2 }, () => ({ type: 'image', mimeType: 'image/png', data })));
	assert.deepEqual(requests, ['https://images.example.com/a.png', 'https://images.example.com/raw?id=9']);
	await request?.load(signal);
	assert.equal(requests.length, 2);
	assert.throws(() => publicImageUrl('http://2130706433/image.png'), /公开网络/u);
	assert.throws(() => publicImageUrl('http://fetch:test@images.example.com/a.png'), /登录凭据/u);
	await assert.rejects(readRemoteImage(new URL('https://images.example.com/private'), signal, false, fetcher), /公开网络/u);
	assert.equal(requests.length, 3);
});

void test('a local HTTPS proxy can resolve a synthetic hostname without allowing synthetic IP URLs or private DNS answers', async () => {
	const url = new URL('https://images.example.com/image.png');
	const local = { proxy: new URL('http://127.0.0.1:7897'), agent: new Agent(), source: 'system' as const };
	const select = async () => local;
	assert.equal(await imageDownloadProxy(url, select, async () => [{ address: '198.18.0.196', family: 4 }]), local);
	assert.equal(await imageDownloadProxy(url, select, async () => [{ address: '192.168.1.3', family: 4 }]), undefined);
	assert.equal(await imageDownloadProxy(url, async () => ({ ...local, proxy: new URL('http://proxy.example.com:7897') }),
		async () => [{ address: '198.18.0.196', family: 4 }]), undefined);
	assert.throws(() => publicImageUrl('https://198.18.0.196/image.png'), /公开网络/u);
});
