import { Buffer } from 'node:buffer';
import { lookup } from 'node:dns';
import { lookup as lookupAddresses } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { createNodeFetch } from '../../communication/nodeFetch';
import { getProxyAgentWithStatus } from '../../communication/proxy';
import { imageContent, MAX_IMAGE_BYTES } from './imageData';

const privateAddresses = new BlockList();
for (const [address, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
	['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
	['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) privateAddresses.addSubnet(address, prefix);
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
	privateAddresses.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const syntheticV4 = new BlockList();
syntheticV4.addSubnet('198.18.0.0', 15);

function publicAddress(address: string): boolean {
	const version = isIP(address);
	return version === 4 ? !privateAddresses.check(address)
		: version === 6 && globalV6.check(address, 'ipv6') && !privateAddresses.check(address, 'ipv6');
}

export function publicImageUrl(value: string): URL {
	return publicMediaUrl(value, '图片');
}

function publicMediaUrl(value: string, label: string): URL {
	const url = URL.parse(value);
	if (!url || value.length > 8_192 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error(`请提供不含登录凭据的公开 HTTP 或 HTTPS ${label}链接。`);
	}
	const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
	if (isIP(hostname) ? !publicAddress(hostname) : !hostname.includes('.') || /\.(?:localhost|local|internal|home\.arpa)$/iu.test(hostname)) {
		throw new Error(`${label}链接必须指向公开网络地址。`);
	}
	url.hash = '';
	return url;
}

// Filter DNS answers at the socket boundary so the validated address is the one actually used.
const publicLookup: LookupFunction = (hostname, options, callback) => {
	lookup(hostname, { ...options, all: true }, (error, addresses) => {
		if (error) { callback(error, ''); return; }
		const publicAddresses = addresses.filter(({ address }) => publicAddress(address));
		const first = publicAddresses[0];
		if (!first) { callback(new Error('链接必须指向公开网络地址。'), ''); return; }
		if (options.all) callback(null, publicAddresses);
		else callback(null, first.address, first.family);
	});
};
export async function imageDownloadProxy(
	url: URL,
	selectProxy = getProxyAgentWithStatus,
	resolveAddresses = (hostname: string) => lookupAddresses(hostname, { all: true }),
) {
	if (url.protocol !== 'https:' || isIP(url.hostname.replace(/^\[|\]$/gu, ''))) return undefined;
	const selection = await selectProxy(url);
	if (!selection.agent || !selection.proxy || !['localhost', '127.0.0.1', '[::1]'].includes(selection.proxy.hostname)) return undefined;
	const addresses = await resolveAddresses(url.hostname);
	// A local fake-IP proxy owns this mapping. Pass the HTTPS hostname through its tunnel,
	// and keep synthetic addresses blocked for literal URLs and direct connections.
	return addresses.length && addresses.every(({ address, family }) => family === 4 && syntheticV4.check(address))
		? selection : undefined;
}
const fetchMedia = createNodeFetch(imageDownloadProxy, { lookup: publicLookup });

export async function openRemoteMedia(url: URL, signal: AbortSignal, media: 'image' | 'video' | 'audio', sameOriginOnly = false, fetcher: typeof fetch = fetchMedia) {
	const label = media === 'image' ? '图片' : media === 'video' ? '视频' : '音频';
	const origin = url.origin;
	for (let redirects = 0; redirects <= 5; redirects++) {
		url = publicMediaUrl(url.href, label);
		if (sameOriginOnly && url.origin !== origin) throw new Error(`${label}链接跳转到其他网站，请直接读取最终${label}地址。`);
		const response = await fetcher(url, { signal, redirect: 'manual', headers: { Accept: `${media}/*` } });
		const location = response.headers.get('location');
		if (location && [301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			url = new URL(location, url);
			continue;
		}
		const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
		if (!response.ok || !response.body || (type && !type.startsWith(`${media}/`) && type !== 'application/octet-stream')) {
			await response.body?.cancel();
			throw new Error(`链接没有返回可读取的${label}（HTTP ${response.status}）。`);
		}
		return { body: response.body, length: Number(response.headers.get('content-length')) };
	}
	throw new Error(`${label}链接跳转次数过多。`);
}

export async function readRemoteImage(url: URL, signal: AbortSignal, sameOriginOnly = false, fetcher: typeof fetch = fetchMedia) {
	signal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
	const { body, length } = await openRemoteMedia(url, signal, 'image', sameOriginOnly, fetcher);
	if (length > MAX_IMAGE_BYTES) {
		await body.cancel();
		throw new Error('单张图片不能超过 5 MiB。');
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 5 MiB。');
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return imageContent(Buffer.concat(chunks, size));
}
