import type { ModelProviderInfo } from '../types';

/** 同一厂商的不同版本/端点归到一张卡片，配置弹窗首行提供切换 */
export interface ProviderGroup {
	/** 首个端点的 id，作为卡片与渲染的稳定 key */
	id: string;
	label: string;
	providers: ModelProviderInfo[];
}

/** 按厂商归组；未列出的服务商各自成组。逐个核对了官方端点地址。 */
const GROUP_SPECS: Array<{ label: string; variants: string[] }> = [
	{ label: '火山引擎', variants: ['volcengine-agent-plan', 'volcengine-coding-plan', 'volcengine-doubao'] },
	{ label: 'Moonshot AI', variants: ['moonshotai', 'moonshotai-cn', 'kimi-coding'] },
	{ label: 'MiniMax', variants: ['minimax', 'minimax-cn', 'minimax-m-plan', 'minimax-m-plan-cn'] },
	{ label: 'Z.AI', variants: ['zai', 'zai-coding-cn', 'zai-payg', 'zai-payg-cn'] },
	{ label: '阿里云百炼', variants: ['bailian-token-plan', 'bailian-coding-plan', 'bailian-payg', 'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual', 'qwen-token-plan-individual-cn'] },
	{ label: 'Xiaomi MiMo', variants: ['xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp'] },
	{ label: 'OpenAI', variants: ['openai', 'openai-codex'] },
	{ label: 'Google', variants: ['google', 'google-vertex'] },
	{ label: 'OpenCode', variants: ['opencode', 'opencode-go'] },
	{ label: 'Cloudflare', variants: ['cloudflare-ai-gateway', 'cloudflare-workers-ai'] },
];

export function groupProviders(providers: ModelProviderInfo[]): ProviderGroup[] {
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	const used = new Set<string>();
	const groups: ProviderGroup[] = [];
	for (const spec of GROUP_SPECS) {
		const variants: ModelProviderInfo[] = [];
		for (const id of spec.variants) {
			const provider = byId.get(id);
			if (!provider) continue;
			used.add(id);
			variants.push(provider);
		}
		if (variants.length) groups.push({ id: variants[0]?.id ?? spec.label, label: spec.label, providers: variants });
	}
	for (const provider of providers) {
		if (!used.has(provider.id)) groups.push({ id: provider.id, label: provider.label, providers: [provider] });
	}
	return groups;
}
