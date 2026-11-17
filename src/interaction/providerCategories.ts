/**
 * 服务商分类：按各服务商官方文档逐个确认，新增 id 未收录时归入「其它」。
 * - domestic：国内厂商第一方 API / 官方套餐（含 CN 专属端点）
 * - global：国外厂商第一方 API
 * - aggregator：聚合网关、推理平台、订阅转售
 * - other：云平台市场代销（Bedrock/Azure）与 Pi 自有的 Radius
 */
export type ProviderCategory = 'domestic' | 'global' | 'aggregator' | 'other';

const PROVIDER_CATEGORIES: Record<string, ProviderCategory> = {
	// 国内官方
	deepseek: 'domestic',
	moonshotai: 'domestic',
	'moonshotai-cn': 'domestic',
	'kimi-coding': 'domestic',
	minimax: 'domestic',
	'minimax-cn': 'domestic',
	zai: 'domestic',
	'zai-coding-cn': 'domestic',
	'ant-ling': 'domestic',
	'qwen-token-plan': 'domestic',
	'qwen-token-plan-cn': 'domestic',
	'qwen-token-plan-individual': 'domestic',
	'qwen-token-plan-individual-cn': 'domestic',
	'bailian-token-plan': 'domestic',
	'bailian-coding-plan': 'domestic',
	'bailian-payg': 'domestic',
	'volcengine-agent-plan': 'domestic',
	'volcengine-coding-plan': 'domestic',
	'volcengine-doubao': 'domestic',
	xiaomi: 'domestic',
	'xiaomi-token-plan-ams': 'domestic',
	'xiaomi-token-plan-cn': 'domestic',
	'xiaomi-token-plan-sgp': 'domestic',
	// 国外官方
	openai: 'global',
	'openai-codex': 'global',
	anthropic: 'global',
	google: 'global',
	'google-vertex': 'global',
	mistral: 'global',
	xai: 'global',
	meta: 'global',
	typesafe: 'global',
	// 聚合平台
	openrouter: 'aggregator',
	together: 'aggregator',
	fireworks: 'aggregator',
	groq: 'aggregator',
	cerebras: 'aggregator',
	baseten: 'aggregator',
	nvidia: 'aggregator',
	huggingface: 'aggregator',
	'cloudflare-ai-gateway': 'aggregator',
	'cloudflare-workers-ai': 'aggregator',
	'vercel-ai-gateway': 'aggregator',
	'github-copilot': 'aggregator',
	opencode: 'aggregator',
	'opencode-go': 'aggregator',
	// 其它
	'amazon-bedrock': 'other',
	azure: 'other',
	radius: 'other',
};

export function providerCategory(id: string): ProviderCategory {
	return PROVIDER_CATEGORIES[id] ?? 'other';
}
