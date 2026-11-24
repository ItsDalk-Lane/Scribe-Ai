import type { Agent } from 'node:http';
import { nodeRequire } from './nodeRequire';

export type ProxySource = 'direct' | 'configured' | 'environment' | 'system';
export interface ProxyAgentSelection {
	agent?: Agent;
	proxy?: URL;
	source: ProxySource;
}
export type ProxyAgentResolver = (url: URL) => Agent | ProxyAgentSelection | undefined | Promise<Agent | ProxyAgentSelection | undefined>;

const agents = new Map<string, Agent>();
let configuredProxy = '';
let useSystemProxy = true;

export function configureProxy(options: { proxyUrl?: string; systemProxy?: boolean }): void {
	configuredProxy = options.proxyUrl?.trim() ?? '';
	useSystemProxy = options.systemProxy !== false;
}

function environment(name: string): string | undefined {
	if (typeof process === 'undefined') return undefined;
	return process.env[name] ?? process.env[name.toLowerCase()];
}

function isLocalHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function noProxyMatches(url: URL, noProxy: string | undefined): boolean {
	if (!noProxy) return false;
	const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	const port = url.port || (url.protocol === 'https:' ? '443' : '80');
	return noProxy.split(',').some((rawRule) => {
		const rule = rawRule.trim().toLowerCase();
		if (!rule) return false;
		if (rule === '*') return true;
		const [ruleHost, rulePort] = rule.startsWith('[')
			? [rule.slice(1, rule.indexOf(']')), rule.includes(']:') ? rule.split(']:')[1] : undefined]
			: rule.split(':');
		if (rulePort && rulePort !== port) return false;
		const host = ruleHost?.replace(/^\./, '');
		return host === hostname || (!!host && hostname.endsWith(`.${host}`));
	});
}

function parseProxyUrl(value: string): URL {
	const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
	const proxy = new URL(withScheme);
	if (!['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(proxy.protocol)) {
		throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
	}
	return proxy;
}

async function systemProxyUrl(target: URL): Promise<string | undefined> {
	if (!useSystemProxy) return undefined;
	try {
		const electron = nodeRequire('electron') as {
			remote?: { session?: { defaultSession?: { resolveProxy?: (url: string) => Promise<string> } } };
			session?: { defaultSession?: { resolveProxy?: (url: string) => Promise<string> } };
		};
		const session = electron.remote?.session?.defaultSession ?? electron.session?.defaultSession;
		if (!session?.resolveProxy) return undefined;
		const result = await session.resolveProxy(target.href);
		for (const rule of result.split(';')) {
			const [kind, address] = rule.trim().split(/\s+/, 2);
			if (!address) continue;
			if (kind === 'PROXY') return `http://${address}`;
			if (kind === 'HTTPS') return `https://${address}`;
			if (kind === 'SOCKS' || kind === 'SOCKS5') return `socks5://${address}`;
			if (kind === 'SOCKS4') return `socks4://${address}`;
		}
	} catch {
		// Electron remote is not an Obsidian API; absence or failure falls back to DIRECT.
	}
	return undefined;
}

async function resolveProxy(target: URL): Promise<{ proxy?: URL; source: ProxySource }> {
	if (noProxyMatches(target, environment('NO_PROXY')) || isLocalHostname(target.hostname)) return { source: 'direct' };
	if (configuredProxy) return { proxy: parseProxyUrl(configuredProxy), source: 'configured' };
	const environmentProxy = target.protocol === 'https:'
		? environment('HTTPS_PROXY') ?? environment('HTTP_PROXY') ?? environment('ALL_PROXY')
		: environment('HTTP_PROXY') ?? environment('ALL_PROXY');
	if (environmentProxy) return { proxy: parseProxyUrl(environmentProxy), source: 'environment' };
	const system = await systemProxyUrl(target);
	return system ? { proxy: parseProxyUrl(system), source: 'system' } : { source: 'direct' };
}

export async function resolveProxyUrl(target: URL): Promise<URL | undefined> {
	return (await resolveProxy(target)).proxy;
}

async function createAgent(target: URL, proxy: URL): Promise<Agent> {
	const key = `${target.protocol}|${proxy.href}`;
	const cached = agents.get(key);
	if (cached) return cached;
	let agent: Agent;
	if (proxy.protocol.startsWith('socks')) {
		const { SocksProxyAgent } = await import('socks-proxy-agent');
		agent = new SocksProxyAgent(proxy.href);
	} else if (target.protocol === 'https:') {
		const { HttpsProxyAgent } = await import('https-proxy-agent');
		agent = new HttpsProxyAgent(proxy.href);
	} else {
		const { HttpProxyAgent } = await import('http-proxy-agent');
		agent = new HttpProxyAgent(proxy.href);
	}
	agents.set(key, agent);
	return agent;
}

export async function getProxyAgentWithStatus(target: URL): Promise<ProxyAgentSelection> {
	const { proxy, source } = await resolveProxy(target);
	return proxy ? { agent: await createAgent(target, proxy), proxy, source } : { source: 'direct' };
}

export const getProxyAgent = async (target: URL): Promise<Agent | undefined> => {
	const selection = await getProxyAgentWithStatus(target);
	return selection.agent;
};
