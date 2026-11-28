import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchArkPublicModelCatalog } from '../arkModelCatalog';
import type { Transport } from '../../types';

void test('Ark public model lookup keeps PAYG version IDs apart from subscription aliases and never sends credentials', async () => {
	const signal = new AbortController().signal;
	const requests: string[] = [];
	const markdown = new Map([
		['model-list.md', [
			'# 文本生成能力', '## 推荐模型',
			'| 模型 ID (Model ID) | 能力支持 | 长度限制（token） |',
			'|---|---|---|',
			'|[doubao-seed-2-1-pro-260915](https://ark.volcengine.com/region:cn-beijing/model/detail?Id=doubao-seed-2-1-pro) |文本生成 |上下文窗口: 1024K |',
			'| | |[最大回答(默认 4K)](/docs/text-generation#details): 256K |',
			'# 视频生成能力',
			'|[doubao-seedance-2-5-260628](https://ark.volcengine.com/region:cn-beijing/model/detail?Id=doubao-seedance-2-5) |文生视频|',
		].join('\n')],
		['agent-plan-personal-plan-overview.md', [
			'|分类 |领域 |模型名称 |长度限制(token) |输入模态 |Small |Medium |Large |Max |',
			'|---|---|---|---|---|---|---|---|---|',
			'|模型 |文本生成 |ark-code-latest |以实际调用模型为准 |',
			'|^^|文本生成（进阶） |glm-5.3 (glm-latest) |* 上下文窗口：1024K |文本 |',
			'| | | |* 最大输出：128K | |',
			'|^^|文本生成（进阶） |kimi-k3 |* 上下文窗口：1024K |文本 |',
			'|^^|语音模型 |doubao-seed-tts-2.0 |\\- |文本 |',
			'|^^|图片生成 |doubao-seedream-5-0-pro |\\- |文本 |',
			'|Harness|专业数据集 |\\- |\\- |\\- |',
		].join('\n')],
		['coding-plan-personal-plan-overview.md', [
			'|模型名称 |长度限制(token) |输入模态 |',
			'|---|---|---|',
			'|ark-code-latest |以实际调用模型为准 |以实际调用模型为准 |',
			'|doubao-seed-2.1-pro |* 上下文窗口：1024K |文本、图片、视频 |',
			'| |* 最大输出：256K | |',
			'|future-retirement `即将下线` |* 上下文窗口：128K |文本 |',
			'|retired `已下线` |* 上下文窗口：128K |文本 |',
			'|doubao-embedding-vision |* 上下文窗口：128K |文本、图片、视频 |',
		].join('\n')],
	]);
	const fetch: Transport['fetch'] = async (input, init) => {
		const url = new URL(new Request(input).url);
		assert.equal(url.origin, 'https://ark.volcengine.com');
		assert.equal(url.search, '');
		assert.equal(new Headers(init?.headers).get('authorization'), null);
		assert.equal(init?.signal, signal);
		assert.equal(init?.redirect, 'error');
		requests.push(url.pathname);
		const doc = markdown.get(url.pathname.split('/').pop() ?? '');
		assert.ok(doc);
		return new Response(doc, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
	};
	const payg = await fetchArkPublicModelCatalog('volcengine-doubao', fetch, signal);
	assert.equal(payg?.source, 'docs');
	assert.deepEqual(payg?.models, ['doubao-seed-2-1-pro-260915']);
	assert.deepEqual(payg?.details?.get('doubao-seed-2-1-pro-260915'), { type: 'text', contextWindow: 1_024_000, maxTokens: 256_000 });
	assert.equal(payg?.details?.get('doubao-seedance-2-5-260628')?.type, 'video');
	const agent = await fetchArkPublicModelCatalog('volcengine-agent-plan', fetch, signal);
	assert.deepEqual(agent?.models, ['ark-code-latest', 'glm-5.3']);
	assert.equal(agent?.details?.get('glm-5.3')?.maxTokens, 128_000);
	assert.equal(agent?.details?.get('doubao-seed-tts-2.0')?.type, 'speech-synthesis');
	assert.equal(agent?.details?.get('doubao-seedream-5.0-pro')?.type, 'image');
	const coding = await fetchArkPublicModelCatalog('volcengine-coding-plan', fetch, signal);
	assert.deepEqual(coding?.models, ['ark-code-latest', 'doubao-seed-2.1-pro', 'future-retirement']);
	assert.equal(coding?.details?.get('doubao-embedding-vision')?.type, 'embedding');
	assert.equal(await fetchArkPublicModelCatalog('other', fetch, signal), undefined);
	assert.equal(requests.length, 3);
});

void test('Ark rejects login pages and malformed documentation instead of replacing a valid catalog', async () => {
	const signal = new AbortController().signal;
	await assert.rejects(fetchArkPublicModelCatalog('volcengine-doubao', async () =>
		new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }), signal), /unavailable/);
	await assert.rejects(fetchArkPublicModelCatalog('volcengine-doubao', async () =>
		new Response('# Unrecognized model list'), signal), /Invalid Ark model catalog/);
});
